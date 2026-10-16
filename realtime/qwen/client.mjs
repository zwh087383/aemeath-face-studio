const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const activeAudio = audio => ['buffering', 'playing', 'paused'].includes(audio?.status);
let requestSequence = 0;
const requestId = () => `avatar-${Date.now().toString(36)}-${++requestSequence}`;
const validOptions = value => typeof value.sidecar === 'boolean' && ['gentle', 'balanced', 'lively'].includes(value.profile);

function encodePcm(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) view.setInt16(index * 2, samples[index], true);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 4096) binary += String.fromCharCode(...bytes.subarray(index, index + 4096));
  return btoa(binary);
}

function decodePcm(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 1400000
    || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('invalid_output_pcm');
  const binary = atob(encoded);
  if (!binary.length || binary.length % 2) throw new Error('invalid_output_pcm');
  const output = new Float32Array(binary.length / 2);
  for (let index = 0; index < output.length; index++) {
    const value = binary.charCodeAt(index * 2) | binary.charCodeAt(index * 2 + 1) << 8;
    output[index] = (value >= 32768 ? value - 65536 : value) / 32768;
  }
  return output;
}

/** Browser-only protocol adapter for the local authenticated bridge. No provider
 * credential, cloud URL, automatic reconnect, hidden retry or rendering loop.
 * clock and every exposed timestamp use monotonic client milliseconds.
 */
export class QwenClient {
  constructor({ session, context, onEvent = () => {}, WebSocketCtor = globalThis.WebSocket,
    clock = () => performance.now(), url, handshakeTimeoutMs = 25000 } = {}) {
    if (!session || !context || typeof context.resume !== 'function' || typeof onEvent !== 'function'
      || typeof clock !== 'function' || typeof WebSocketCtor !== 'function') throw new TypeError('invalid client dependencies');
    if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0 || handshakeTimeoutMs > 60000) throw new RangeError('handshakeTimeoutMs');
    if (!url) {
      const target = new URL('/api/qwen', globalThis.location?.href ?? 'http://127.0.0.1:18769/');
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'; url = target.href;
    }
    Object.assign(this, { session, context, onEvent, WebSocketCtor, clock, url, handshakeTimeoutMs });
    this.ready = false; this.connectionId = null; this.mode = null; this.currentTrial = null; this.trials = [];
    this.socket = null; this.lastError = null; this.inputSequence = 0; this.inputFrames = 0;
    this._uncommittedFrames = 0; this._generation = 0; this._pending = null; this._active = null;
    this._inputOptions = { sidecar: true, profile: 'balanced' };
    this._byResponse = new Map(); this._socketConnectionId = null; this._closedHandled = false;
    this._connectPromise = null; this._connectResolve = null; this._connectReject = null; this._handshakeTimer = null;
  }

  _now() { const value = this.clock(); if (!Number.isFinite(value) || value < 0) throw new Error('invalid_client_clock'); return value; }
  _emit(type, details = {}) {
    let atMs = null; try { atMs = this._now(); } catch { /* diagnostic timestamp */ }
    try { const result = this.onEvent({ type, atMs, ...details }); if (result?.catch) result.catch(() => {}); } catch { /* observer only */ }
  }
  _send(command) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(command)); return true; }
    catch { this._fail('socket_send_failed'); return false; }
  }
  _localCancel(trial, reason) {
    if (!trial) return false;
    if (trial.cancelAt === null) trial.cancelAt = this._now();
    trial.revoked = true; trial.cancelReason = reason;
    return trial.owner ? this.session.cancel(reason, trial.owner) : true;
  }
  _shutdown(reason) {
    if (this._closedHandled) return;
    this._closedHandled = true; this.ready = false; clearTimeout(this._handshakeTimer); this._handshakeTimer = null;
    for (const trial of new Set([this._active, this._pending, this.currentTrial].filter(Boolean))) {
      if (trial.providerDoneAt === null || (trial.owner === this.session.owner && activeAudio(this.session.audio.snapshot()))) {
        this._localCancel(trial, reason);
      } else if (trial.owner === this.session.owner) this.session.cancel(reason, trial.owner);
      if (trial.providerDoneAt === null) trial.usageStatus = 'unknown';
    }
    this._connectReject?.(new Error(reason)); this._connectResolve = null; this._connectReject = null;
    this._emit('closed', { reason });
  }
  _fail(code) {
    this.lastError = String(code); this._emit('error', { code: this.lastError, fatal: true });
    this._shutdown(this.lastError);
    try { this.socket?.close(); } catch { /* local cleanup already happened */ }
    return false;
  }
  _canSubmit() {
    if (!this.ready || this._pending || this._active) return false;
    const state = this.session.audio.snapshot();
    return !activeAudio(state) || this.session.snapshot().revoked;
  }
  _newTrial(kind, options = {}, assignedRequestId = requestId()) {
    const trial = { requestId: assignedRequestId, responseId: null, kind,
      connectionId: this.connectionId, submittedAt: this._now(), inputStartAt: null, inputLastSpeechAt: null,
      responseCreatedAt: null, firstPcmAt: null, firstSubtitleAt: null, audioDoneAt: null,
      providerDoneAt: null, usage: null, usageStatus: 'pending', status: 'pending', transcript: '',
      cancelAt: null, cancelAckAt: null, remoteCancelDoneAt: null, remoteCancelNeeded: null,
      revoked: false, owner: null, sidecar: options.sidecar ?? true, profile: options.profile ?? 'balanced',
      pcmSequence: 0, outputFrames: 0, subtitleSequences: {}, audioTranscriptSeen: false,
      phase: kind === 'text' ? 'submitted' : 'input' };
    this.trials.push(trial);
    while (this.trials.length > 20) {
      const removed = this.trials.shift(); if (removed.responseId) this._byResponse.delete(removed.responseId);
    }
    this.currentTrial = trial; this._emit('trial', { action: 'new', trial }); return trial;
  }

  connect(mode = 'manual') {
    if (!['manual', 'vad'].includes(mode)) return Promise.reject(new Error('invalid_mode'));
    if ((this.socket || this._connectPromise) && !this._closedHandled) return Promise.reject(new Error('already_connected'));
    const generation = ++this._generation;
    this.mode = mode; this.ready = false; this.connectionId = null; this.lastError = null;
    this._closedHandled = false; this._socketConnectionId = null; this.inputSequence = 0;
    this.inputFrames = 0; this._uncommittedFrames = 0; this._pending = null; this._active = null;
    this._byResponse.clear(); this.currentTrial = null;
    this._connectPromise = new Promise((resolve, reject) => { this._connectResolve = resolve; this._connectReject = reject; });
    this._handshakeTimer = setTimeout(() => { if (generation === this._generation) this._fail('handshake_timeout'); }, this.handshakeTimeoutMs);
    this._handshakeTimer.unref?.();
    Promise.resolve().then(() => this.context.resume()).then(() => {
      if (generation !== this._generation || this._closedHandled) return;
      if (this.context.state !== 'running') { this._fail('audio_context_not_running'); return; }
      const socket = new this.WebSocketCtor(this.url); this.socket = socket;
      const current = () => generation === this._generation && socket === this.socket && !this._closedHandled;
      socket.onopen = () => { if (current()) this._send({ type: 'connect', mode }); };
      socket.onmessage = message => {
        if (!current()) return;
        try { this._message(JSON.parse(message.data)); } catch (error) { this._fail(error?.message ?? 'invalid_bridge_message'); }
      };
      socket.onerror = () => { if (current()) this._fail('websocket_error'); };
      socket.onclose = () => { if (current()) this._shutdown('websocket_closed'); };
    }).catch(() => { if (generation === this._generation && !this._closedHandled) this._fail('audio_context_resume_failed'); });
    return this._connectPromise;
  }

  sendText(text, { sidecar = true, profile = 'balanced' } = {}) {
    if (!this._canSubmit() || typeof text !== 'string' || !text.trim() || text.length > 2000 || !validOptions({ sidecar, profile })) return null;
    const trial = this._newTrial('text', { sidecar, profile }); this._pending = trial;
    if (!this._send({ type: 'text', text, requestId: trial.requestId })) return null;
    return trial.requestId;
  }

  prepareInput({ sidecar = this._inputOptions.sidecar, profile = this._inputOptions.profile } = {}) {
    if (!this.ready || this._pending || !validOptions({ sidecar, profile }) || (this.mode !== 'vad' && !this._canSubmit())) return null;
    this._inputOptions = { sidecar, profile };
    const trial = this._newTrial(this.mode === 'vad' ? 'vad-audio' : 'audio', { sidecar, profile });
    trial.inputStartAt = this._now(); this._pending = trial; return trial;
  }

  sendInput(samples) {
    if (!this.ready || !(samples instanceof Int16Array) || !samples.length || samples.length > 16000) return false;
    const sequence = this.inputSequence;
    if (!this._send({ type: 'input_audio', sequence, audio: encodePcm(samples) })) return false;
    this.inputSequence++; this.inputFrames += samples.length; this._uncommittedFrames += samples.length;
    if (this._pending?.phase === 'input' && this._pending.inputStartAt === null) this._pending.inputStartAt = this._now();
    return true;
  }

  commit({ sidecar = this._pending?.sidecar ?? true, profile = this._pending?.profile ?? 'balanced' } = {}) {
    if (!this.ready || this.mode !== 'manual' || this._active || this._uncommittedFrames < 1600
      || !validOptions({ sidecar, profile }) || (this._pending && (this._pending.phase !== 'input' || this._pending.revoked))) return null;
    const trial = this._pending ?? this._newTrial('audio', { sidecar, profile });
    trial.sidecar = sidecar; trial.profile = profile; trial.phase = 'submitted'; trial.submittedAt = this._now(); this._pending = trial;
    if (!this._send({ type: 'commit', requestId: trial.requestId })) return null;
    this._uncommittedFrames = 0; return trial.requestId;
  }

  cancel(reason = 'user_interrupt') {
    const trial = this._active ?? this._pending ?? this.currentTrial;
    if (!trial || trial.revoked) return false;
    // Local audio/animation cancellation precedes sending any network command.
    const local = this._localCancel(trial, reason);
    const hasRemoteOwner = trial.responseId || trial.phase === 'submitted';
    if (!hasRemoteOwner && trial.phase === 'input') {
      // The bridge deliberately has no silent input-buffer-clear command. An
      // uncommitted cancellation must close that buffer, never submit it later.
      this._emit('cancel', { trial, local, sent: false, reason, requiresReconnect: true });
      this.close(); return local;
    }
    const sent = this.ready && hasRemoteOwner ? this._send({ type: 'cancel', requestId: trial.requestId,
      ...(trial.responseId ? { responseId: trial.responseId } : {}) }) : false;
    this._emit('cancel', { trial, local, sent, reason }); return local;
  }

  _message(message) {
    if (!message || typeof message !== 'object' || !id(message.connectionId) || typeof message.type !== 'string') throw new Error('invalid_bridge_message');
    if (this._socketConnectionId && this._socketConnectionId !== message.connectionId) throw new Error('connection_owner_mismatch');
    this._socketConnectionId = message.connectionId;
    if (message.type === 'ready') {
      if (this.ready || message.mode !== this.mode || message.inputSampleRate !== 16000 || message.outputSampleRate !== 24000
        || !this.session.setConnection(message.connectionId)) throw new Error('ready_configuration_mismatch');
      this.connectionId = message.connectionId; this.ready = true;
      clearTimeout(this._handshakeTimer); this._handshakeTimer = null;
      this._connectResolve?.(this); this._connectResolve = null; this._connectReject = null;
      this._emit('ready', { connectionId: this.connectionId, mode: this.mode, model: message.model, voice: message.voice }); return;
    }
    if (message.type === 'error') { this._fail(message.code ?? 'bridge_error'); return; }
    if (message.type === 'closed') { this._shutdown(message.reason ?? 'bridge_closed'); return; }
    if (message.type === 'cancel_ack') {
      const trial = message.responseId ? this._byResponse.get(message.responseId)
        : this.trials.find(entry => entry.connectionId === this.connectionId && entry.requestId === message.requestId);
      if (!trial || (message.requestId && trial.requestId !== message.requestId) || trial.cancelAt === null) {
        this._emit('protocol_drop', { reason: 'unknown_cancel_ack' }); return;
      }
      trial.cancelAckAt = this._now(); trial.remoteCancelNeeded = message.remoteNeeded === true;
      if (message.remoteNeeded === false) trial.cancelScope = 'local_playback';
      this._emit('cancel_ack', { trial, pending: message.pending === true }); return;
    }
    if (message.type === 'provider') { this._provider(message); return; }
    this._emit(message.type, { envelope: message });
  }

  _provider(envelope) {
    const event = envelope.event;
    if (!event || typeof event.type !== 'string') throw new Error('invalid_provider_event');
    const type = event.type;
    this._emit('provider', { event, serverAtMs: envelope.serverAtMs, revoked: envelope.revoked === true,
      requestId: envelope.requestId, connectionId: envelope.connectionId });
    if (type === 'input_audio_buffer.speech_started') {
      if (!this.ready || this.mode !== 'vad') throw new Error('unexpected_vad_event');
      if (activeAudio(this.session.audio.snapshot()) || this._active) this.cancel('server_vad');
      if (!this._pending) this.prepareInput();
      this._emit('speech_started', { event, trial: this._pending }); return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this._emit('speech_stopped', { event, trial: this._pending }); return;
    }
    if (type.includes('input_audio_transcription')) { this._emit('input_transcript', { event }); return; }
    if (!type.startsWith('response.')) return;
    if (!this.ready) throw new Error('response_before_ready');
    const responseId = type === 'response.created' || type === 'response.done' ? event.response?.id : event.response_id;
    if (!id(responseId)) throw new Error('response_owner_missing');
    if (type === 'response.created') {
      if (this._byResponse.has(responseId)) { this._emit('protocol_drop', { reason: 'duplicate_response_created', responseId }); return; }
      const trial = this._pending;
      if (!trial || this._active || (this.mode !== 'vad' && envelope.requestId && envelope.requestId !== trial.requestId)) {
        throw new Error('response_ownership_unknown');
      }
      if (envelope.requestId) trial.requestId = envelope.requestId;
      trial.responseId = responseId; trial.responseCreatedAt = this._now(); trial.status = 'in_progress'; trial.phase = 'responding';
      trial.revoked ||= envelope.revoked === true; this._pending = null; this._active = trial;
      this._byResponse.set(responseId, trial); this.currentTrial = trial;
      if (!trial.revoked) {
        trial.owner = this.session.beginResponse({ connectionId: this.connectionId, responseId, sampleRate: 24000,
          sidecar: trial.sidecar, profile: trial.profile });
        if (!trial.owner) throw new Error('avatar_begin_failed');
      }
      this._emit('response_created', { trial }); return;
    }
    const trial = this._byResponse.get(responseId);
    if (!trial || (envelope.requestId && envelope.requestId !== trial.requestId)) {
      this._emit('protocol_drop', { reason: 'unknown_response', responseId }); return;
    }
    if (type === 'response.done') {
      if (trial.providerDoneAt !== null) { this._emit('protocol_drop', { reason: 'duplicate_response_done', responseId }); return; }
      trial.providerDoneAt = this._now(); trial.status = event.response?.status ?? 'unknown';
      trial.usage = event.response?.usage ?? null; trial.usageStatus = trial.usage ? 'reported' : 'unknown';
      if (trial.cancelAt !== null) trial.remoteCancelDoneAt = this._now();
      if (this._active === trial) this._active = null;
      if (!['completed', 'cancelled'].includes(trial.status)) {
        this._localCancel(trial, 'provider_response_failed'); this._emit('response_done', { trial });
        this._fail('provider_response_failed'); return;
      }
      if (trial.status === 'cancelled' || envelope.revoked === true) this._localCancel(trial, 'provider_cancelled');
      else if (!trial.revoked && trial.owner) this.session.providerDone(trial.owner);
      this._emit('response_done', { trial }); return;
    }
    if (trial.revoked || envelope.revoked === true || (trial.providerDoneAt !== null && !['response.audio.done', 'response.audio_transcript.done'].includes(type))) {
      this._emit('protocol_drop', { reason: 'revoked_or_terminal_response', responseId, eventType: type }); return;
    }
    if (!trial.owner || this.session.owner !== trial.owner) { this._emit('protocol_drop', { reason: 'inactive_response', responseId }); return; }
    if (type === 'response.audio.delta') {
      const samples = decodePcm(event.delta);
      if (trial.firstPcmAt === null) trial.firstPcmAt = this._now();
      // Keep per-call PCM and lip work at or below one second, irrespective of
      // provider packet size. No Worker result or async visual operation is awaited.
      for (let offset = 0; offset < samples.length; offset += 24000) {
        const chunk = samples.subarray(offset, Math.min(samples.length, offset + 24000));
        if (!this.session.appendPcm({ owner: trial.owner, sequence: trial.pcmSequence, samples: chunk })) throw new Error('avatar_pcm_rejected');
        trial.pcmSequence++; trial.outputFrames += chunk.length;
      }
      this._emit('audio', { trial, frames: samples.length }); return;
    }
    if (type === 'response.audio_transcript.delta') {
      if (typeof event.delta !== 'string' || !event.delta.length) return;
      const itemId = `${event.item_id ?? 'reply-text'}:${event.content_index ?? 0}`;
      if (!id(itemId) || event.delta.length > 1024) throw new Error('invalid_subtitle_delta');
      const sequence = trial.subtitleSequences[itemId] ?? 0;
      trial.audioTranscriptSeen = true;
      if (trial.firstSubtitleAt === null) trial.firstSubtitleAt = this._now();
      if (trial.transcript.length + event.delta.length > 16384) throw new Error('transcript_limit');
      trial.transcript += event.delta; trial.subtitleSequences[itemId] = sequence + 1;
      this.session.pushSubtitle(event.delta, { owner: trial.owner, itemId, sequence });
      this._emit('subtitle', { trial, text: event.delta, itemId, sequence }); return;
    }
    if (type === 'response.audio.done') {
      if (trial.audioDoneAt !== null) return;
      trial.audioDoneAt = this._now(); this.session.finishAudio(trial.owner); this._emit('audio_done', { trial }); return;
    }
    if (type === 'response.audio_transcript.done') {
      this.session.finishSubtitles(trial.owner); this._emit('subtitle_done', { trial });
    }
  }

  close() {
    if (this._closedHandled) return;
    // Stop local resources before waiting for the bridge/provider close handshake.
    this._shutdown('client_close'); this._send({ type: 'close' });
    try { this.socket?.close(); } catch { /* cleanup already attempted */ }
  }

  snapshot() {
    return { ready: this.ready, connectionId: this.connectionId, mode: this.mode, lastError: this.lastError,
      inputSequence: this.inputSequence, inputFrames: this.inputFrames,
      currentRequestId: this.currentTrial?.requestId ?? null, trials: structuredClone(this.trials) };
  }
}
