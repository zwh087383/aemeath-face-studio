import { StreamingAudioTransport } from '../stream-audio.mjs';
import { RealtimeScheduler } from '../scheduler.mjs';
import { SubtitleSidecar } from '../subtitle-sidecar.mjs';
import { AVATAR_CATALOG, createAvatarSink } from '../avatar/controller-bridge.mjs';
import { PcmLipTrack } from './pcm-lip-track.mjs';
import { CHANNELS } from '../../preview/core/profile.js';

const ACTIVE = new Set(['buffering', 'playing', 'paused']);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const same = (a, b) => a && b && a.connectionId === b.connectionId
  && a.responseId === b.responseId && a.epoch === b.epoch;
const copy = value => value ? { ...value } : null;
const nowCpu = () => performance.now();

/** External PCM and transcript adapter. No sockets, credentials, microphone or
 * rendering loop. beginResponse belongs ONLY to a trusted response.created.
 * Provider event completion is distinct from actual local playback completion.
 * All public timestamps use monotonic milliseconds; the scheduler uses seconds.
 */
export class LiveAvatarSession {
  constructor({ context, face, motion, clock = () => performance.now() / 1000,
    onEvent = () => {}, workerFactory, lipTrack = new PcmLipTrack(),
    maxPendingText = 128, maxTurnChars = 16384, maxResponses = 1024,
    maxConnections = 64, audioOptions = {} } = {}) {
    if (!face || !motion || typeof clock !== 'function' || typeof onEvent !== 'function'
      || !lipTrack || !['begin', 'append', 'sample', 'finish', 'cancel'].every(key => typeof lipTrack[key] === 'function')) {
      throw new TypeError('invalid live session dependencies');
    }
    for (const [key, value] of Object.entries({ maxPendingText, maxTurnChars, maxResponses, maxConnections })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 65536) throw new RangeError(key);
    }
    Object.assign(this, { face, motion, clock, onEvent, lipTrack, maxPendingText, maxTurnChars, maxResponses, maxConnections });
    this.connectionId = null; this.owner = null; this.lastError = null; this.events = [];
    this._connections = new Set(); this._seenResponses = new Set(); this._operation = 0;
    this._disposed = false; this._revoked = false; this._starting = false; this._handledFault = null;
    this._pendingText = []; this._textItems = new Map(); this._textChars = 0;
    this._textFinished = false; this._sidecarEnabled = false; this._lipEnabled = false;
    this._lastChunkStart = 0; this._cueSequence = 0;
    this.timings = {}; this.metrics = { responses: 0, replacements: 0, pcmChunks: 0, pcmFrames: 0,
      pcmAppendMaxMs: 0, pcmAppendTotalMs: 0, lipAppendMaxMs: 0, lipAppendTotalMs: 0,
      staleInputs: 0, rejectedInputs: 0, cancels: 0, visualFailures: 0, eventsTotal: 0 };
    this._zeroLip = { weights: new Float32Array(CHANNELS.length), closure: 0, energy: 0 };
    this.audio = new StreamingAudioTransport(context, audioOptions);
    this._sink = createAvatarSink({ audio: this.audio, face, motion });
    this.scheduler = new RealtimeScheduler({ clock, catalog: AVATAR_CATALOG, emit: command => {
      if (command.type === 'stop_audio') this._clearVisuals(command.identity);
      const accepted = this._sink(command);
      if (command.type === 'cue' && accepted) this._mark('firstCueAt');
      if (command.type !== 'playback') this._event(command.type, { owner: copy(command.identity), accepted,
        reason: command.reason, ...(command.cue ? { cue: { ...command.cue } } : {}) });
      return accepted;
    } });
    this.sidecar = new SubtitleSidecar({ scheduler: this.scheduler, clock,
      ...(workerFactory ? { workerFactory } : {}),
      onDecision: decision => this._event('subtitle_decision', { decision }),
    });
    this.playReady = Promise.resolve(false);
  }

  _now() { try { const value = this.clock() * 1000; return Number.isFinite(value) && value >= 0 ? value : null; } catch { return null; } }
  _mark(key) { if (this.timings[key] === undefined) this.timings[key] = this._now(); }
  _event(type, details = {}) {
    const event = { type, owner: copy(this.owner), atMs: this._now(), ...details };
    this.events.push(event); if (this.events.length > 128) this.events.shift(); this.metrics.eventsTotal++;
    try { const value = this.onEvent(structuredClone(event)); if (value?.catch) value.catch(() => {}); } catch { /* observation only */ }
  }
  _reject(reason, stale = false) {
    this.metrics.rejectedInputs++; if (stale) this.metrics.staleInputs++;
    return { accepted: false, reason };
  }
  _current(owner) {
    return !this._disposed && same(owner, this.owner) && owner.connectionId === this.connectionId
      && same(owner, this.scheduler.identity);
  }
  _active(owner) { return this._current(owner) && !this._revoked && !this.scheduler.fault && ACTIVE.has(this.scheduler.status); }
  _clearVisuals(owner) {
    if (same(owner, this.owner)) this._pendingText = [];
    try { this.sidecar?.cancel(owner); } catch { /* optional analysis */ }
    try { this.lipTrack.cancel(owner); } catch { /* mouth returns zero outside playing */ }
  }
  _disableText(reason) {
    this._sidecarEnabled = false; this._pendingText = []; this.sidecar.cancel(this.owner);
    this.metrics.visualFailures++; this._event('subtitle_disabled', { reason });
  }
  _disableLip(reason) {
    this._lipEnabled = false; this.metrics.visualFailures++; this._event('lip_disabled', { reason });
    try { this.lipTrack.cancel(this.owner); } catch { /* audio remains independent */ }
  }
  _fail(reason) {
    this.lastError = String(reason); this._event('error', { reason: this.lastError });
    this.cancel('session_error'); return false;
  }

  setConnection(connectionId) {
    if (this._disposed || !id(connectionId) || this.scheduler.fault || this.audio.status === 'fault') return false;
    if (connectionId === this.connectionId) return true;
    // A retired connection cannot be reinstalled by a delayed socket callback.
    if (this._connections.has(connectionId) || this._connections.size >= this.maxConnections) return false;
    if (this.owner && !this.cancel('connection_replaced')) return false;
    this.connectionId = connectionId; this._connections.add(connectionId); this._seenResponses.clear();
    this._event('connection', { connectionId }); return true;
  }

  beginResponse({ connectionId, responseId, sampleRate = 24000, sidecar = true, profile = 'balanced' } = {}) {
    if (this._disposed || connectionId !== this.connectionId || !id(connectionId) || !id(responseId)
      || this._seenResponses.has(responseId) || this._seenResponses.size >= this.maxResponses
      || !Number.isInteger(sampleRate) || sampleRate < 3000 || sampleRate > 384000
      || typeof sidecar !== 'boolean' || !['gentle', 'balanced', 'lively'].includes(profile)
      || this.scheduler.fault || this.audio.status === 'fault') {
      this._reject('invalid_or_duplicate_response', true); return null;
    }
    const operation = ++this._operation;
    if (this.owner) { this._clearVisuals(this.owner); this.metrics.replacements++; }
    const epoch = Math.max(this.audio.epoch, this.scheduler.highestEpoch, this.face.epoch ?? 0, this.motion.epoch ?? 0) + 1;
    const owner = Object.freeze({ connectionId, responseId, epoch });
    if (!this.scheduler.begin(owner)) { this.lastError = this.scheduler.fault ?? 'scheduler_begin_failed'; return null; }
    this.owner = owner; this._seenResponses.add(responseId); this._revoked = false; this._handledFault = null;
    this.lastError = null; this.timings = { responseBeginAt: this._now() };
    this._pendingText = []; this._textItems = new Map(); this._textChars = 0; this._textFinished = false;
    this._lastChunkStart = 0; this._sidecarEnabled = sidecar; this._lipEnabled = true;
    if (!this.audio.begin(epoch, { sampleRate })) { this._fail(this.audio.lastError ?? 'audio_begin_failed'); return null; }
    try { if (this.lipTrack.begin(owner, sampleRate) !== true) this._disableLip('lip_begin_failed'); }
    catch (error) { this._disableLip(error?.message ?? 'lip_begin_failed'); }
    if (sidecar && !this.sidecar.begin(owner, { profile })) this._disableText('worker_unavailable');
    this.metrics.responses++; this._starting = true;
    this._event('response_begin', { sampleRate, sidecar, profile });
    // PCM arrivals may proceed while browser audio permission is resolving.
    // Neither this promise nor the subtitle worker is awaited by appendPcm().
    this.playReady = this.audio.play().then(played => {
      if (operation !== this._operation || !this._current(owner) || this._revoked) return false;
      this._starting = false;
      if (!played) return this._fail(this.audio.lastError ?? 'audio_play_failed');
      this.sync(); return !this.scheduler.fault && this.audio.status !== 'fault';
    }).catch(error => {
      if (operation !== this._operation || !this._current(owner) || this._revoked) return false;
      this._starting = false; return this._fail(error?.message ?? error);
    });
    return owner;
  }

  appendPcm({ owner, sequence, samples } = {}) {
    if (!this._active(owner)) { this._reject('wrong_or_inactive_owner', true); return false; }
    const start = this.audio.receivedDuration, began = nowCpu();
    // Audio is accepted first. Mouth analysis failure cannot delay or revoke it.
    const accepted = this.audio.append({ epoch: owner.epoch, sequence, samples });
    const elapsed = nowCpu() - began;
    this.metrics.pcmAppendMaxMs = Math.max(this.metrics.pcmAppendMaxMs, elapsed); this.metrics.pcmAppendTotalMs += elapsed;
    if (!accepted) return this._fail(this.audio.lastError ?? 'pcm_append_failed');
    this._lastChunkStart = start; this.metrics.pcmChunks++; this.metrics.pcmFrames += samples.length;
    if (this.timings.firstPcmAt === undefined) { this._mark('firstPcmAt'); this._event('first_pcm', { frames: samples.length }); }
    if (this._lipEnabled) {
      const lipStart = nowCpu();
      try { if (this.lipTrack.append(owner, sequence, samples) !== true) this._disableLip('lip_append_failed'); }
      catch (error) { this._disableLip(error?.message ?? 'lip_append_failed'); }
      const lipMs = nowCpu() - lipStart;
      this.metrics.lipAppendMaxMs = Math.max(this.metrics.lipAppendMaxMs, lipMs); this.metrics.lipAppendTotalMs += lipMs;
    }
    return true;
  }

  pushSubtitle(text, { owner, itemId = 'reply-text', sequence } = {}) {
    if (!this._active(owner)) return this._reject('wrong_or_inactive_owner', true);
    if (this._textFinished) return this._reject('subtitles_finished');
    if (typeof text !== 'string' || !text.length || text.length > this.sidecar.maxChunkChars || !id(itemId)
      || !Number.isSafeInteger(sequence) || sequence < 0) return this._reject('invalid_subtitle');
    let item = this._textItems.get(itemId);
    if (!item) {
      if (this._textItems.size >= this.sidecar.maxItems) { this._disableText('item_capacity'); return this._reject('item_capacity'); }
      item = { next: 0, chunks: new Map() }; this._textItems.set(itemId, item);
    }
    if (sequence < item.next && item.chunks.get(sequence) === text) return this._reject('duplicate');
    if (sequence !== item.next) { this._disableText('subtitle_sequence_conflict'); return this._reject('subtitle_sequence_conflict'); }
    if (this._textChars + text.length > this.maxTurnChars
      || [...this._textItems.values()].reduce((sum, entry) => sum + entry.next, 0) >= this.sidecar.maxChunks) {
      this._disableText('text_capacity'); return this._reject('text_capacity');
    }
    item.chunks.set(sequence, text); item.next++; this._textChars += text.length;
    // Qwen transcript deltas do not carry word timestamps. This is an arrival
    // boundary approximation: delay analysis until playback reaches the latest
    // PCM chunk's start, not provider wall time or an invented phoneme position.
    const boundary = this._lastChunkStart;
    this._mark('firstSubtitleAt'); this._event('raw_subtitle', { text, itemId, sequence, boundary });
    // Display delivery is independent of optional Worker availability/capacity.
    if (!this._sidecarEnabled) return { accepted: true, reason: 'sidecar_disabled', boundary };
    if (this._pendingText.length >= this.maxPendingText) {
      this._disableText('pending_text_capacity'); return { accepted: true, reason: 'sidecar_disabled', boundary };
    }
    this._pendingText.push({ owner, itemId, sequence, text, boundary });
    return { accepted: true, reason: 'queued_for_playback', boundary };
  }

  _releaseText(audio) {
    if (!this._sidecarEnabled || !this._active(this.owner) || audio.status !== 'playing') return;
    // At most eight deltas per render turn keeps a transcript burst bounded.
    for (let count = 0; count < 8 && this._pendingText.length; count++) {
      const input = this._pendingText[0];
      if (input.boundary > audio.time + this.scheduler.leadSeconds) break;
      this._pendingText.shift();
      const result = this.sidecar.push({ ...input.owner, itemId: input.itemId, sequence: input.sequence, text: input.text });
      if (!result.accepted) { this._disableText(result.reason); break; }
    }
    if (this._textFinished && !this._pendingText.length && this.sidecar.status === 'active') this.sidecar.finish(this.owner);
  }

  finishAudio(owner) {
    if (!this._current(owner) || this._revoked || this.scheduler.fault) return false;
    if (this.timings.audioDoneAt !== undefined) return true;
    if (!ACTIVE.has(this.scheduler.status)) return false;
    if (!this.audio.finish(owner.epoch)) return this._fail(this.audio.lastError ?? 'audio_finish_failed');
    this._mark('audioDoneAt'); this._event('audio_done');
    if (this._lipEnabled) {
      try { if (this.lipTrack.finish(owner) !== true) this._disableLip('lip_finish_failed'); }
      catch (error) { this._disableLip(error?.message ?? 'lip_finish_failed'); }
    }
    return true;
  }

  finishSubtitles(owner) {
    if (!this._current(owner) || this._revoked || this.scheduler.fault) return false;
    this._textFinished = true;
    if (this._sidecarEnabled && !this._pendingText.length && ACTIVE.has(this.scheduler.status)) this.sidecar.finish(owner);
    return true;
  }

  providerDone(owner) {
    if (!this._current(owner) || this._revoked || this.scheduler.fault) return false;
    if (this.timings.providerDoneAt !== undefined) return true;
    this._mark('providerDoneAt'); this._event('provider_completed');
    // response.done may arrive after the last source has already drained.
    return this.scheduler.status === 'ended' || this.scheduler.providerDone(owner);
  }

  cancel(reason = 'barge_in', owner = this.owner) {
    if (!this._current(owner)) { this._reject('wrong_owner', true); return false; }
    ++this._operation; this._starting = false; this._revoked = true;
    this._mark('interruptAt'); this._clearVisuals(owner);
    let accepted = false;
    if (ACTIVE.has(this.scheduler.status)) accepted = this.scheduler.interrupt({ ...owner, reason });
    else if (this.audio.epoch === owner.epoch) {
      let stopped = false, retracted = false;
      try { stopped = this.audio.cancel() === true; } catch (error) { this.lastError = error.message; }
      try { retracted = this._sink({ type: 'retract', identity: owner, atWall: this.clock(), reason }) === true; }
      catch (error) { this.lastError = error.message; }
      accepted = stopped && retracted && !this.scheduler.fault;
    }
    if (!accepted && this.scheduler.fault) this.lastError = this.scheduler.fault;
    if (this.audio.status === 'fault') this._handledFault = owner.epoch;
    this.metrics.cancels++; this._event('cancel', { reason, accepted }); return accepted;
  }

  pause() {
    if (!this._active(this.owner)) return false;
    ++this._operation; this._starting = false; this.sync();
    try { const accepted = this.audio.pause(); this.sync(); return accepted; }
    catch (error) { return this._fail(error?.message ?? error); }
  }

  async resume() {
    if (!this._active(this.owner)) return false;
    const operation = ++this._operation, owner = this.owner;
    const accepted = await this.audio.resume();
    if (operation !== this._operation || !this._active(owner)) return false;
    if (!accepted) return this._fail(this.audio.lastError ?? 'audio_resume_failed');
    this.sync(); return true;
  }

  sync() {
    let audio = this.audio.snapshot();
    if (this._disposed || !this.owner || audio.epoch !== this.owner.epoch) return audio;
    if (audio.status === 'fault') {
      if (this._handledFault !== audio.epoch) { this._handledFault = audio.epoch; this._fail(audio.fault ?? 'audio_fault'); }
      return this.audio.snapshot();
    }
    if (this._active(this.owner) && ['buffering', 'playing', 'paused', 'ended'].includes(audio.status)) {
      if (audio.sourceActive && this.timings.firstPlaybackAt === undefined) { this._mark('firstPlaybackAt'); this._event('first_playback'); }
      this.scheduler.playback({ ...this.owner, status: audio.status, time: audio.time });
      if (this.scheduler.fault) { this.lastError = this.scheduler.fault; this._clearVisuals(this.owner); }
      else if (audio.status === 'ended') {
        this._mark('playbackEndedAt'); this._event('playback_ended'); this._clearVisuals(this.owner);
      } else this._releaseText(audio);
      audio = this.audio.snapshot();
    }
    return audio;
  }

  lipSample(audio = this.audio.snapshot()) {
    if (!this._lipEnabled || this._revoked || !this._current(this.owner)
      || audio.epoch !== this.owner.epoch || audio.status !== 'playing' || !audio.sourceActive) return this._zeroLip;
    try { return this.lipTrack.sample(this.owner, audio.time); }
    catch (error) { this._disableLip(error?.message ?? 'lip_sample_failed'); return this._zeroLip; }
  }

  enqueue(cue, owner = this.owner) {
    if (!this._active(owner)) return this._reject('wrong_or_inactive_owner', true);
    if (!cue || typeof cue !== 'object' || Array.isArray(cue)) return this._reject('invalid_cue');
    return this.scheduler.enqueue({ ...cue, ...owner, id: cue.id ?? `live-manual-${++this._cueSequence}` });
  }

  snapshot() {
    return { connectionId: this.connectionId, owner: copy(this.owner), audio: this.audio.snapshot(),
      scheduler: this.scheduler.snapshot(), sidecar: this.sidecar.snapshot(),
      lip: typeof this.lipTrack.snapshot === 'function' ? this.lipTrack.snapshot() : null,
      metrics: { ...this.metrics }, timings: { ...this.timings }, events: structuredClone(this.events),
      pendingText: this._pendingText.length, textChars: this._textChars, starting: this._starting,
      revoked: this._revoked, disposed: this._disposed, lastError: this.lastError,
      subtitleAlignment: 'Approximate latest-PCM-chunk arrival boundary; no word timestamps.',
      timingBoundary: 'Monotonic client milliseconds; WebAudio scheduling, not physical speaker output.' };
  }

  dispose() {
    if (this._disposed) return;
    if (this.owner) this.cancel('disposed');
    this.sidecar.dispose(); this._pendingText = []; this._disposed = true;
  }
}
