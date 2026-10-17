import { CooutputDriver } from '../qwen/cooutput-driver.mjs';
import { pcmBase64, decodePcm24k, rms16 } from '../qwen/input-audio.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const active = status => ['playing', 'buffering', 'paused'].includes(status);

/** Continuous input and D output. No subtitle rules or model-selected clocks. */
export class DuplexClient {
  constructor({ session, clock = () => performance.now(), onEvent = () => {}, socketFactory = url => new WebSocket(url) }) {
    Object.assign(this, { session, clock, onEvent, socketFactory });
    this.ready = false; this.blocked = false; this.socket = null; this.connectionId = null;
    this.sequence = 0; this.trials = []; this.inputs = []; this.events = []; this.interruptions = [];
    this.current = null; this.lastLoudAt = -Infinity; this.localInput = null; this.serial = 0;
    this.generation = 0; this.error = null; this.budget = null;
    this.blockReason = null; this.hardBlocked = false; this.seenConnections = new Set(); this.pendingReadyGeneration = null;
  }
  now() { return this.clock(); }
  emit(type, fields = {}) {
    const event = { type, at: this.now(), ...fields }; this.events.push(event);
    if (this.events.length > 10000) this.events.shift();
    this.onEvent(event);
  }
  send(command) { if (this.socket?.readyState !== 1) return false; this.socket.send(JSON.stringify(command)); return true; }
  get canReconnect() {
    return this.blocked && !this.hardBlocked && this.blockReason === 'session_input_limit'
      && this.budget?.blocked === false && this.budget?.unknown === 0;
  }
  async connect(url = new URL('/api/duplex', globalThis.location?.href ?? 'http://127.0.0.1:18772/').href.replace(/^http/, 'ws')) {
    if (this.socket && this.socket.readyState < 2) throw Error('already_connected');
    if (this.blocked && !this.canReconnect) throw Error(this.blockReason ?? 'client_blocked');
    const generation = ++this.generation, socket = this.socketFactory(url); this.socket = socket;
    this.ready = false; if (!this.blocked) this.error = null; this.sequence = 0; this.pendingReadyGeneration = generation;
    const current = () => this.socket === socket && this.generation === generation;
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => { if (!resolved && current()) { reject(Error('connect_timeout')); socket.close(); } }, 30000);
      socket.onmessage = e => {
        if (!current()) return;
        try {
          const message = JSON.parse(e.data); this.message(message, generation);
          if (message.type === 'ready') { resolved = true; clearTimeout(timer); resolve(message); }
          else if (message.type === 'blocked' && !resolved) { clearTimeout(timer); reject(Error(message.code)); }
        } catch (error) { this.error = error.message; this.blocked = true; this.hardBlocked = true;
          this.blockReason = 'client_protocol_error'; this.cancel('client_protocol_error'); this.emit('client_error', { code: this.error }); }
      };
      socket.onerror = () => { if (current()) { this.error = 'socket_error'; this.emit('client_error', { code: this.error }); if (!resolved) { clearTimeout(timer); reject(Error(this.error)); } } };
      socket.onclose = () => { if (!current()) return; clearTimeout(timer); this.pendingReadyGeneration = null; this.ready = false; this.cancel('disconnected', false); this.emit('closed'); if (!resolved) reject(Error('connection_closed')); };
    });
  }
  message(message, socketGeneration = null) {
    if (message.type === 'ready') {
      const freshHandshake = socketGeneration !== null && socketGeneration === this.generation
        && socketGeneration === this.pendingReadyGeneration;
      if (!validId(message.connectionId) || this.ready || this.seenConnections.has(message.connectionId)
        || (this.connectionId !== null && !freshHandshake)) throw Error('invalid_ready');
      if (!this.session.setConnection(message.connectionId)) throw Error('connection_rejected');
      const recoverable = this.canReconnect;
      this.connectionId = message.connectionId; this.ready = true; this.budget = message.budget; this.variant = message.variant ?? 'full-cold';
      this.seenConnections.add(message.connectionId); this.pendingReadyGeneration = null;
      if (message.budget?.blocked === true || message.budget?.unknown > 0) {
        this.blocked = true; this.hardBlocked = true; this.blockReason = 'usage_unknown_admission_blocked'; this.error = this.blockReason;
      } else if (freshHandshake && recoverable && message.budget?.blocked === false && message.budget?.unknown === 0) {
        this.blocked = false; this.blockReason = null; this.error = null;
      }
      if (!this.blocked) { this.inputExhausted = false; this.localInput = null; this.lastLoudAt = -Infinity; }
      this.emit('ready', { mode: message.listenerConfiguration?.turn_detection, variant: this.variant, connectionId: this.connectionId }); return;
    }
    if (message.connectionId !== this.connectionId) { this.emit('stale_connection_drop'); return; }
    this.budget = message.budget ?? this.budget;
    if (this.budget?.blocked === true || this.budget?.unknown > 0) {
      this.blocked = true; this.hardBlocked = true; this.blockReason = 'usage_unknown_admission_blocked';
      this.error = this.blockReason; this.cancel(this.error, false);
    }
    const t = this.trials.find(t => t.id === message.turnId);
    this.emit('server', { event: { ...message, pcm: message.pcm ? `[PCM ${message.pcm.length}]` : undefined } });
    if (message.type === 'input_exhausted') {
      this.inputExhausted = true; this.emit('input_exhausted');
    } else if (message.type === 'speech_started') {
      const input = this.inputs.findLast(i => !i.itemId);
      if (input) input.itemId = message.itemId;
      if (this.current) this.current.serverSpeechPending = message.itemId;
      this.provisionalPause('server_speech_started');
    } else if (message.type === 'speech_stopped') {
      if (this.current?.serverSpeechPending === message.itemId) delete this.current.serverSpeechPending;
      const input = this.inputs.find(i => i.itemId === message.itemId);
      if (input) { input.stoppedAt = this.now(); input.valid = message.valid; }
      if (message.valid) this.cancel('confirmed_voice_barge_in', false);
      else this.resumeInvalid();
    } else if (message.type === 'input_final') {
      const input = this.inputs.find(i => i.itemId === message.itemId);
      if (input) { input.finalAt = this.now(); input.transcript = message.transcript; }
    } else if (message.type === 'turn_started') {
      this.cancel('new_turn', false);
      const input = this.inputs.find(i => i.itemId === message.itemId);
      const trial = { id: message.turnId, itemId: message.itemId, input: input ?? null, text: message.text,
        startedAt: this.now(), variant: this.variant, sequence: 0, frames: 0, transcript: '', tools: [], stages: [], fastStages: [], revoked: false, owner: null,
        ...(this.variant === 'qwen-direct' ? { segments: [], segmentRequests: [], pendingTools: [] } : {}) };
      this.trials.push(trial); this.current = trial;
    } else if (t?.variant === 'qwen-direct' && this.directMessage(message, t)) {
      // Physical Qwen response identities remain distinct inside one playback epoch.
    } else if (message.type === 'context_ready' && t) {
      t.contextReadyAt ??= this.now();
      if (t.variant === 'qwen-direct') { t.context ??= message; (t.contexts ??= []).push(message); }
      else t.context = message;
    } else if (message.type === 'fast_reply' && t) {
      t.fastStages.push({ at: this.now(), ...message });
    } else if (message.type === 'reply_connecting' && t) {
      t.prewarmed = message.prewarmed;
    } else if (message.type === 'request_sent' && t) {
      t.requestAt = this.now(); t.providerConnectionId = message.providerConnectionId;
    } else if (message.type === 'response_created' && t) {
      if (t.responseId || !validId(message.responseId) || !validId(message.providerConnectionId)) throw Error('response_owner_conflict');
      t.responseId = message.responseId; t.providerConnectionId = message.providerConnectionId;
      if (t.revoked || t !== this.current) return;
      t.owner = this.session.beginResponse({ connectionId: this.connectionId, responseId: t.responseId, sidecar: false });
      if (!t.owner) throw Error('response_begin_failed');
      t.driver = new CooutputDriver(this.session, t.owner, 'D');
    } else if (message.type === 'audio' && t) {
      if (message.responseId !== t.responseId) throw Error('audio_owner_conflict');
      const samples = decodePcm24k(message.pcm); t.frames += samples.length; t.firstPcmAt ??= this.now();
      if (t.revoked || message.revoked || t !== this.current) { t.droppedPcm = (t.droppedPcm ?? 0) + samples.length; return; }
      for (let p = 0; p < samples.length; p += 24000) {
        if (!this.session.appendPcm({ owner: t.owner, sequence: t.sequence++, samples: samples.slice(p, p + 24000) })) throw Error('pcm_append_failed');
      }
    } else if (message.type === 'subtitle' && t) {
      if (message.responseId !== t.responseId) throw Error('subtitle_owner_conflict');
      if (!t.revoked && !message.revoked) { t.transcript += message.delta; t.firstSubtitleAt ??= this.now(); }
    } else if (message.type === 'tool' && t) {
      if (message.responseId !== t.responseId) throw Error('tool_owner_conflict');
      const accepted = !t.revoked && !message.revoked && t === this.current;
      const result = accepted ? t.driver?.accept(message) : { accepted: false, reason: 'revoked_or_stale_owner' };
      t.tools.push({ at: this.now(), event: message, result }); t.firstToolAt ??= this.now();
    } else if (message.type === 'audio_done' && t && !t.revoked && t === this.current) {
      this.session.finishAudio(t.owner); t.audioDoneAt = this.now();
    } else if (message.type === 'response_done' && t) {
      if (message.result?.responseId !== t.responseId || message.result?.connectionId !== t.providerConnectionId) throw Error('terminal_owner_conflict');
      t.providerDoneAt = this.now(); t.result = message.result;
      if (!t.revoked && t === this.current) {
        if (t.result.status === 'completed' && t.result.frames > 0) { this.session.finishAudio(t.owner); this.session.providerDone(t.owner); }
        else this.cancel('provider_incomplete', false);
      }
    } else if (message.type === 'tool_receipt_send' && t) {
      t.toolReceiptAt ??= this.now();
    } else if (message.type === 'delivery' && t) {
      if (message.responseId !== t.responseId || message.providerConnectionId !== t.providerConnectionId) throw Error('delivery_owner_conflict');
      t.delivery = message; this.sync();
    } else if (message.type === 'settled' && t) {
      if (!t.revoked && t.ackSentAt !== undefined && t.delivery?.deliveryId === message.deliveryId) t.settledAt = this.now();
    } else if (message.type === 'revoked' && t) {
      if (t === this.current) this.cancel(message.reason, false);
      else t.revoked = true;
    } else if (message.type === 'blocked' || message.type === 'input_limit') {
      this.blocked = true; this.error = message.code ?? 'input_limit'; this.blockReason = this.error;
      this.hardBlocked ||= this.error !== 'session_input_limit' || this.budget?.blocked !== false || this.budget?.unknown !== 0;
      this.cancel(this.error, false);
      this.emit('blocked', { code: this.error, budget: message.budget });
    } else if (message.type === 'turn_error' && t) {
      t.error = message.code; if (t === this.current) this.cancel('turn_error', false);
    }
  }
  directSegment(t, message) {
    const segment = t.segments[message.segmentIndex];
    if (!segment || message.segmentIndex !== segment.index || message.phase !== segment.phase
      || message.startFrame !== segment.startFrame
      || (message.responseId ?? message.result?.responseId) !== segment.responseId
      || (message.providerConnectionId ?? message.result?.connectionId) !== segment.connectionId)
      throw Error('segment_owner_conflict');
    return segment;
  }
  directSegments(t) {
    return t.segments.map(s => ({ index: s.index, connectionId: s.connectionId, responseId: s.responseId,
      frames: s.frames, audioDone: s.result?.audioDone, transcriptDone: s.result?.transcriptDone,
      status: s.result?.status, startFrame: s.startFrame, phase: s.phase }));
  }
  sameSegments(left, right) {
    const keys = ['index', 'connectionId', 'responseId', 'frames', 'audioDone', 'transcriptDone', 'status', 'startFrame', 'phase'];
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((s, i) => s && Object.keys(s).length === keys.length && keys.every(k => s[k] === right[i][k]));
  }
  directMessage(message, t) {
    const type = message.type;
    if (type === 'request_sent') {
      const index = message.segmentIndex;
      if (!Number.isInteger(index) || index < 0 || index > 1 || t.segmentRequests[index]
        || index !== t.segments.length || !validId(message.providerConnectionId)) throw Error('segment_request_conflict');
      t.segmentRequests[index] = { at: this.now(), ...message }; t.requestAt ??= this.now(); return true;
    }
    if (type === 'response_created') {
      const index = message.segmentIndex, previous = t.segments.at(-1);
      if (!Number.isInteger(index) || index !== t.segments.length || index > 1
        || !validId(message.responseId) || !validId(message.providerConnectionId)
        || message.startFrame !== t.frames
        || !(index === 0 ? ['direct', 'full-bypass'].includes(message.phase) : message.phase === 'full')
        || (index === 1 && (!t.handoff || previous.result?.status !== 'completed'))
        || t.segments.some(s => s.responseId === message.responseId)
        || t.segmentRequests[index]?.providerConnectionId !== message.providerConnectionId
        || t.segmentRequests[index]?.phase !== message.phase || t.segmentRequests[index]?.startFrame !== message.startFrame)
        throw Error('segment_owner_conflict');
      const segment = { index, connectionId: message.providerConnectionId, responseId: message.responseId,
        phase: message.phase, startFrame: message.startFrame, frames: 0, transcript: '', calls: [], createdAt: this.now() };
      t.segments.push(segment); t.responseId = segment.responseId; t.providerConnectionId = segment.connectionId;
      if (!t.revoked && t === this.current && !t.owner) {
        t.owner = this.session.beginResponse({ connectionId: this.connectionId, responseId: segment.responseId, sidecar: false });
        if (!t.owner) throw Error('response_begin_failed');
        t.driver = new CooutputDriver(this.session, t.owner, 'D');
      }
      return true;
    }
    if (['audio', 'subtitle', 'tool', 'audio_done', 'response_done', 'tool_receipt_send', 'handoff_requested'].includes(type)) {
      const s = this.directSegment(t, message);
      if (['audio', 'subtitle', 'tool', 'audio_done'].includes(type) && s.result) throw Error('late_segment_event');
      if (type === 'audio') {
        const samples = decodePcm24k(message.pcm); s.frames += samples.length; t.frames += samples.length;
        s.firstPcmAt ??= this.now(); t.firstPcmAt ??= this.now();
        if (t.revoked || message.revoked || t !== this.current) { t.droppedPcm = (t.droppedPcm ?? 0) + samples.length; return true; }
        for (let p = 0; p < samples.length; p += 24000)
          if (!this.session.appendPcm({ owner: t.owner, sequence: t.sequence++, samples: samples.slice(p, p + 24000) })) throw Error('pcm_append_failed');
      } else if (type === 'subtitle') {
        if (typeof message.delta !== 'string') throw Error('invalid_subtitle');
        s.transcript += message.delta;
        if (!t.revoked && !message.revoked) { t.transcript = t.segments.map(part => part.transcript.trim()).filter(Boolean).join('\n'); t.firstSubtitleAt ??= this.now(); }
      } else if (type === 'tool') {
        if (message.name !== 'perform_avatar' || typeof message.callId !== 'string'
          || !/^[A-Za-z0-9_.:-]{1,100}$/.test(message.callId)) throw Error('unexpected_avatar_tool');
        const record = { at: this.now(), event: message, segmentIndex: s.index,
          result: { accepted: false, reason: 'pending_segment_playback' } };
        t.tools.push(record); t.firstToolAt ??= this.now();
        if (t.revoked || message.revoked || t !== this.current) record.result = { accepted: false, reason: 'revoked_or_stale_owner' };
        else {
          if (!s.calls.includes(message.callId)) s.calls.push(message.callId);
          record.localCallId = `s${s.index}.c${s.calls.indexOf(message.callId) + 1}`;
          t.pendingTools.push(record); this.drainDirectTools(t);
        }
      } else if (type === 'audio_done') {
        if (s.audioDoneAt !== undefined) throw Error('duplicate_segment_audio_done');
        s.audioDoneAt = this.now();
      } else if (type === 'response_done') {
        if (s.result || message.result?.frames !== s.frames || message.result?.transcript !== s.transcript)
          throw Error('segment_terminal_conflict');
        s.result = structuredClone(message.result); s.providerDoneAt = this.now(); t.providerDoneAt = this.now();
        if (s.result.status !== 'completed' && !t.revoked && t === this.current) this.cancel('provider_incomplete', false);
      } else if (type === 'handoff_requested') {
        if (s.index !== 0 || s.phase !== 'direct' || t.handoff || s.result?.status !== 'completed'
          || !validId(message.callId)
          || !['memory_retrieval', 'temporal_retrieval', 'vision', 'action', 'web_search', 'graph',
            'long_answer', 'context_budget', 'policy', 'main_model'].includes(message.reason))
          throw Error('invalid_handoff');
        t.handoff = { at: this.now(), ...message };
      } else t.toolReceiptAt ??= this.now();
      return true;
    }
    if (type === 'turn_output_done') {
      const result = message.result, last = t.segments.at(-1), segments = this.directSegments(t);
      if (t.outputDoneAt !== undefined || !last || (t.handoff && t.segments.length !== 2)
        || message.responseId !== last.responseId || message.providerConnectionId !== last.connectionId
        || result?.responseId !== last.responseId || result?.connectionId !== last.connectionId
        || !this.sameSegments(result?.segments, segments) || result.frames !== t.frames || result.frames <= 0
        || result.transcript !== t.segments.map(s => s.transcript.trim()).filter(Boolean).join('\n')
        || result.status !== 'completed' || !result.audioDone || !result.transcriptDone
        || segments.some(s => s.status !== 'completed' || !s.audioDone || !s.transcriptDone))
        throw Error('turn_output_conflict');
      t.result = structuredClone(result); t.outputDoneAt = this.now();
      if (!t.revoked && t === this.current) {
        this.session.finishAudio(t.owner); this.session.providerDone(t.owner); t.audioDoneAt = this.now();
      }
      return true;
    }
    if (type === 'delivery') {
      if (!t.result || message.responseId !== t.responseId || message.providerConnectionId !== t.providerConnectionId
        || message.expectedFrames !== t.frames || !this.sameSegments(message.segments, t.result.segments))
        throw Error('delivery_owner_conflict');
      t.delivery = message; this.sync(); return true;
    }
    return false;
  }
  drainDirectTools(t) {
    if (t.revoked || t !== this.current || this.session.owner !== t.owner) return;
    const audio = this.session.audio.snapshot();
    if (!active(audio.status) || audio.epoch !== t.owner.epoch) return;
    for (const record of t.pendingTools) {
      if (record.dispatchedAt !== undefined || audio.time * 24000 + 1 < t.segments[record.segmentIndex].startFrame) continue;
      if (record.segmentIndex > 0 && t.segments[record.segmentIndex].startFrame > 0 && audio.status !== 'playing') continue;
      record.dispatchedAt = this.now();
      record.result = t.driver.accept({ ...record.event, callId: record.localCallId });
    }
  }
  sendAudio(samples, { source = 'microphone' } = {}) {
    if (!this.ready || this.blocked || this.inputExhausted || !(samples instanceof Int16Array)) return false;
    const loud = rms16(samples) > .015, at = this.now();
    if (loud) {
      if (!this.localInput || at - this.lastLoudAt > 1200 || this.localInput.valid !== undefined) {
        this.localInput = { id: ++this.serial, source, startAt: at, lastSpeechAt: at }; this.inputs.push(this.localInput);
      }
      let last = samples.length - 1; while (last > 0 && Math.abs(samples[last] / 32768) < .015) last--;
      this.localInput.lastSpeechAt = at - (samples.length - 1 - last) / 16;
      this.lastLoudAt = at; this.provisionalPause('local_voice_activity');
    }
    return this.send({ type: 'audio', sequence: this.sequence++, pcm: pcmBase64(samples) });
  }
  provisionalPause(reason) {
    const t = this.current;
    if (!t || t.revoked || t.settledAt !== undefined || !active(this.session.audio.snapshot().status)) return false;
    if (t.pausedAt !== undefined) return true;
    t.pausedAt = this.now(); t.pauseReason = reason;
    const before = this.session.audio.snapshot(); const accepted = this.session.pause();
    this.emit('provisional_pause', { turnId: t.id, reason, accepted, sourceBefore: before.sourceCount, sourceAfter: this.session.audio.snapshot().sourceCount });
    return accepted;
  }
  async resumeInvalid(reason = 'invalid_turn_resumed') {
    const t = this.current;
    if (t && !t.resuming && !t.revoked && t.pausedAt !== undefined && this.session.owner === t.owner) {
      t.resuming = true;
      const resumed = await this.session.resume(); t.resumedAt = this.now(); delete t.pausedAt;
      t.resuming = false;
      this.emit(reason, { turnId: t.id, resumed });
    }
  }
  cancel(reason = 'explicit_user_interrupt', remote = true) {
    const t = this.current;
    if (!t || t.revoked || t.settledAt !== undefined) return false;
    const at = this.now(), audio = this.session.audio.snapshot();
    t.revoked = true; t.cancelAt = at; t.driver?.cancel();
    const activeMotion = !!this.session.motion.snapshot().gestures?.length;
    if (t.owner) this.session.cancel(reason, t.owner);
    const after = this.session.audio.snapshot();
    const record = { turnId: t.id, at, reason, mediaTime: audio.time, sourcesBefore: audio.sourceCount,
      queuedBefore: audio.queuedSeconds, sourcesAfter: after.sourceCount, returnMs: this.now() - at, activeMotion };
    this.interruptions.push(record);
    if (remote) this.send({ type: 'cancel', turnId: t.id });
    this.emit('cancel', record); return true;
  }
  sync() {
    const t = this.current, audio = this.session.sync();
    if (!t || t.revoked || this.session.owner !== t.owner) return;
    // A short local noise spike need not produce a provider speech event.
    // Once the provider confirms speech, only its validity decision resumes.
    if (t.pausedAt !== undefined && !t.serverSpeechPending && this.now() - this.lastLoudAt > 1800)
      void this.resumeInvalid('unconfirmed_noise_resumed');
    if (audio.sourceActive) t.playbackAt ??= this.now();
    if (t.variant === 'qwen-direct') this.drainDirectTools(t);
    if (audio.status === 'ended') t.playbackEndedAt ??= this.now();
    const d = t.delivery, result = t.result;
    if (d && result?.status === 'completed' && result.audioDone && result.transcriptDone && t.ackSentAt === undefined
      && audio.status === 'ended' && audio.finished && !audio.fault && audio.epoch === t.owner.epoch
      && audio.sourceCount === 0 && !audio.sourceActive && audio.queuedSeconds <= 1 / 24000
      && d.expectedFrames === t.frames && result.frames === t.frames
      && Math.round(audio.time * 24000) === t.frames && Math.round(audio.receivedDuration * 24000) === t.frames) {
      t.ackSentAt = this.now();
      if (!this.send({ type: 'playback_complete', turnId: t.id, deliveryId: d.deliveryId,
        responseId: t.responseId, providerConnectionId: t.providerConnectionId, frames: t.frames, status: 'ended',
        ...(t.variant === 'qwen-direct' ? { segments: structuredClone(t.result.segments) } : {}) })) {
        t.error = 'ack_send_failed'; this.cancel(t.error, false);
      }
    }
  }
  sendText(text) { if (!this.ready || this.blocked || this.inputExhausted) return false; return this.send({ type: 'text', text }); }
  close() { this.cancel('disconnect'); this.ready = false; this.send({ type: 'close' }); }
  snapshot() {
    return { ready: this.ready, blocked: this.blocked, error: this.error, connectionId: this.connectionId,
      blockReason: this.blockReason, hardBlocked: this.hardBlocked, canReconnect: this.canReconnect,
      budget: this.budget, inputPackets: this.sequence, inputs: structuredClone(this.inputs),
      trials: this.trials.map(({ driver, ...t }) => structuredClone(t)),
      interruptions: structuredClone(this.interruptions), events: structuredClone(this.events) };
  }
}
