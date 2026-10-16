import { StreamingAudioTransport } from '../stream-audio.mjs';
import { RealtimeScheduler } from '../scheduler.mjs';
import { SubtitleSidecar } from '../subtitle-sidecar.mjs';
import { AVATAR_CATALOG, createAvatarSink } from './controller-bridge.mjs';

const ACTIVE = new Set(['buffering', 'playing', 'paused']);
const same = (a, b) => a && b && a.connectionId === b.connectionId
  && a.responseId === b.responseId && a.epoch === b.epoch;
const copy = owner => owner ? { ...owner } : null;
let sessionSequence = 0;

/** One PCM player and one owner fence for the existing face/body controllers.
 * The host owns rendering, lip sampling and subtitle arrival. sync() supplies
 * their shared media clock; subtitle analysis is never awaited by audio.
 */
export class AvatarSession {
  constructor({ context, face, motion, clock = () => performance.now() / 1000,
    onEvent = () => {}, workerFactory } = {}) {
    if (!face || !motion || typeof clock !== 'function' || typeof onEvent !== 'function') {
      throw new TypeError('face, motion, clock and onEvent are required');
    }
    this.clock = clock; this.onEvent = onEvent; this.face = face; this.motion = motion;
    this.owner = null; this.duration = 0; this.lastError = null; this.events = [];
    this._connectionId = `avatar-session-${++sessionSequence}`;
    this._operation = 0; this._timer = null; this._feedState = null;
    this._disposed = false; this._sidecarEnabled = false; this._cueSequence = 0;
    this._handledAudioFaultEpoch = null;
    this._subtitleSequences = new Map();
    this.metrics = { starts: 0, replacements: 0, pauses: 0, resumes: 0, cancels: 0,
      pcmChunks: 0, pcmFrames: 0, pcmPushMaxMs: 0, pcmBatchMaxChunks: 0,
      feedFailures: 0, staleInputs: 0, eventsTotal: 0 };
    this.audio = new StreamingAudioTransport(context);
    this._sink = createAvatarSink({ audio: this.audio, face, motion });
    this.scheduler = new RealtimeScheduler({ clock, catalog: AVATAR_CATALOG, emit: command => {
      if (command.type === 'stop_audio') {
        // Cleanup remains synchronous even if a worker has stopped responding.
        this._clearFeed();
        this.sidecar?.cancel(command.identity);
      }
      const accepted = this._sink(command);
      if (command.type !== 'playback') this._event(command.type, {
        owner: copy(command.identity), accepted, reason: command.reason,
        ...(command.cue ? { cue: { ...command.cue } } : {}),
      });
      return accepted;
    } });
    this.sidecar = new SubtitleSidecar({ scheduler: this.scheduler, clock,
      ...(workerFactory ? { workerFactory } : {}),
      onDecision: decision => this._event('subtitle', { decision }),
    });
  }

  _event(type, details = {}) {
    let atWall = null;
    try { atWall = this.clock(); } catch { /* diagnostics must not block cleanup */ }
    const event = { type, owner: copy(this.owner), atWall, ...details };
    this.events.push(event); if (this.events.length > 128) this.events.shift();
    this.metrics.eventsTotal++;
    try {
      const result = this.onEvent(structuredClone(event));
      if (result?.catch) result.catch(() => {});
    } catch { /* observers do not control the session */ }
  }

  _reject(reason) { this.metrics.staleInputs++; return { accepted: false, reason }; }
  _current(owner) { return !this._disposed && same(owner, this.owner) && same(owner, this.scheduler.identity); }
  _clearTimer() { clearTimeout(this._timer); this._timer = null; }
  _clearFeed() { this._clearTimer(); this._feedState = null; }
  _error(reason) {
    this.lastError = String(reason);
    this.metrics.feedFailures++;
    this._event('error', { reason: this.lastError });
    this.cancel('session_error');
    return false;
  }

  async start(sample, { sidecar = true, profile = 'balanced', chunkMs = 20,
    providerFast = false, starve = false } = {}) {
    if (this._disposed) return false;
    if (!(sample?.samples instanceof Float32Array) || !sample.samples.length
      || !Number.isInteger(sample.sampleRate) || sample.sampleRate < 3000 || sample.sampleRate > 384000
      || sample.samples.length / sample.sampleRate > 120
      || ![20, 40].includes(chunkMs) || !['gentle', 'balanced', 'lively'].includes(profile)
      || ![sidecar, providerFast, starve].every(value => typeof value === 'boolean')) {
      this.lastError = 'invalid_sample_or_options'; return false;
    }
    const operation = ++this._operation;
    this._clearFeed();
    // A completed audio turn can still own an in-flight subtitle worker.
    if (this.owner) { this.sidecar.cancel(this.owner); this.metrics.replacements++; }
    const epoch = Math.max(this.audio.epoch, this.scheduler.highestEpoch,
      this.face.epoch ?? 0, this.motion.epoch ?? 0) + 1;
    const owner = Object.freeze({ connectionId: this._connectionId, responseId: `reply-${epoch}`, epoch });
    // Old audio must be stopped before transport.begin can install a new epoch.
    if (!this.scheduler.begin(owner)) {
      this.lastError = this.scheduler.fault ?? 'scheduler_begin_failed'; return false;
    }
    this.owner = owner; this.lastError = null; this.duration = sample.samples.length / sample.sampleRate;
    this._handledAudioFaultEpoch = null;
    this._subtitleSequences.clear(); this._sidecarEnabled = sidecar;
    if (!this.audio.begin(epoch, { sampleRate: sample.sampleRate })) return this._error(this.audio.lastError ?? 'audio_begin_failed');
    const feed = this._feedState = { owner, sample, index: 0, sequence: 0,
      chunkFrames: Math.max(1, Math.round(sample.sampleRate * chunkMs / 1000)),
      chunkMs, providerFast, starve, starved: false, starveUntil: null,
      initial: true, arrivalOrigin: null, arrivalSent: 0 };
    if (sidecar) this.sidecar.begin(owner, { profile });
    this.metrics.starts++; this._event('start', { duration: this.duration, sidecar, profile, chunkMs, providerFast, starve });
    const played = await this.audio.play();
    if (operation !== this._operation || !this._current(owner)) return false;
    if (!played) return this._error(this.audio.lastError ?? 'audio_play_failed');
    this._feed(feed);
    this.sync();
    return !this.scheduler.fault && !['fault', 'cancelled'].includes(this.audio.status);
  }

  _scheduleFeed(feed, delay) {
    this._clearTimer();
    if (this._feedState !== feed || !this._current(feed.owner)) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try { this._feed(feed); } catch (error) { this._error(error?.message ?? error); }
    }, delay);
  }

  _feed(feed) {
    if (this._feedState !== feed || !this._current(feed.owner)) return;
    let state = this.audio.snapshot();
    if (state.epoch !== feed.owner.epoch || !ACTIVE.has(this.scheduler.status)) return;
    if (state.status === 'fault') { this._error(state.fault); return; }
    if (state.status === 'paused') return;
    if (!['playing', 'buffering'].includes(state.status)) return;
    const now = this.clock(), period = feed.chunkFrames / feed.sample.sampleRate;
    if (!Number.isFinite(now) || now < 0 || (feed.arrivalOrigin !== null && now < feed.arrivalOrigin)) {
      this._error('invalid_feed_clock'); return;
    }
    if (feed.arrivalOrigin === null) feed.arrivalOrigin = now;
    if (feed.starve && !feed.starved && feed.index / feed.sample.sampleRate >= 1) {
      feed.starved = true; feed.starveUntil = now + 1.2;
      this._event('starvation', { delayMs: 1200 });
    }
    if (feed.starveUntil !== null && now + 1e-9 < feed.starveUntil) {
      this._scheduleFeed(feed, Math.ceil((feed.starveUntil - now) * 1000)); return;
    }
    // Arrival count comes from an absolute monotonic origin, never from how many
    // setTimeout callbacks happened to run. Late callbacks catch up in batches of
    // at most eight and yield; their delay does not become permanent underfeeding.
    const initial = feed.initial;
    const due = Math.max(0, Math.floor((now - feed.arrivalOrigin + 1e-9) / period) - feed.arrivalSent);
    let count = feed.providerFast ? 8 : (initial ? 4 : Math.min(8, due));
    if (feed.starve && !feed.starved) {
      count = Math.min(count, Math.ceil((feed.sample.sampleRate - feed.index) / feed.chunkFrames));
    }
    feed.initial = false;
    let sent = 0, backpressure = false;
    for (let i = 0; i < count && feed.index < feed.sample.samples.length; i++) {
      const end = Math.min(feed.index + feed.chunkFrames, feed.sample.samples.length);
      const seconds = (end - feed.index) / feed.sample.sampleRate;
      state = this.audio.snapshot();
      if (state.queuedSeconds + seconds > this.audio.maxBufferedSeconds + 1e-9) { backpressure = true; break; }
      const started = performance.now();
      const accepted = this.audio.append({ epoch: feed.owner.epoch, sequence: feed.sequence,
        samples: feed.sample.samples.subarray(feed.index, end) });
      this.metrics.pcmPushMaxMs = Math.max(this.metrics.pcmPushMaxMs, performance.now() - started);
      if (!accepted) { this._error(this.audio.lastError ?? 'pcm_append_failed'); return; }
      this.metrics.pcmChunks++; this.metrics.pcmFrames += end - feed.index;
      feed.index = end; feed.sequence++;
      sent++;
      if (!initial && !feed.providerFast) feed.arrivalSent++;
    }
    this.metrics.pcmBatchMaxChunks = Math.max(this.metrics.pcmBatchMaxChunks, sent);
    if (feed.index === feed.sample.samples.length) {
      this._feedState = null;
      if (!this.audio.finish(feed.owner.epoch)) { this._error(this.audio.lastError ?? 'audio_finish_failed'); return; }
      this.scheduler.providerDone(feed.owner);
      return;
    }
    const delay = backpressure ? feed.chunkMs : feed.providerFast ? 0
      : Math.max(0, Math.ceil((feed.arrivalOrigin + (feed.arrivalSent + 1) * period - this.clock()) * 1000));
    this._scheduleFeed(feed, delay);
  }

  pause() {
    if (!this._current(this.owner) || !ACTIVE.has(this.scheduler.status)) return false;
    ++this._operation;
    // Capture any content consumed since the previous RAF before freezing time.
    this.sync(); this._clearTimer();
    try {
      const accepted = this.audio.pause();
      if (accepted) { this.metrics.pauses++; this.sync(); this._event('pause'); }
      return accepted;
    } catch (error) { return this._error(error?.message ?? error); }
  }

  async resume() {
    if (!this._current(this.owner) || !ACTIVE.has(this.scheduler.status)) return false;
    const owner = this.owner, operation = ++this._operation;
    const wasPaused = this.audio.snapshot().status === 'paused';
    const played = await this.audio.resume();
    if (operation !== this._operation || !this._current(owner)) return false;
    if (!played) return this._error(this.audio.lastError ?? 'audio_resume_failed');
    if (this._feedState) {
      // A local pause is not provider debt. Resume begins a fresh arrival cadence
      // while retaining the PCM already queued and any remaining deliberate gap.
      if (wasPaused) { this._feedState.arrivalOrigin = null; this._feedState.arrivalSent = 0; }
      this._feed(this._feedState);
    }
    this.metrics.resumes++; this.sync(); this._event('resume');
    return !this.scheduler.fault && !['fault', 'cancelled'].includes(this.audio.status);
  }

  cancel(reason = 'barge_in') {
    ++this._operation; this._clearFeed();
    const owner = this.owner;
    if (!owner) return false;
    this.sidecar.cancel(owner);
    let accepted = false;
    if (this._current(owner) && ACTIVE.has(this.scheduler.status)) {
      accepted = this.scheduler.interrupt({ ...owner, reason });
    } else if (same(owner, this.scheduler.identity) && this.audio.epoch === owner.epoch) {
      // Ended controllers are inactive, but their natural wall-clock recovery may remain.
      let stopped = false, retracted = false;
      try { stopped = this.audio.cancel() === true; } catch (error) { this.lastError = error.message; }
      try { retracted = this._sink({ type: 'retract', identity: owner, atWall: this.clock(), reason }) === true; }
      catch (error) { this.lastError = error.message; }
      accepted = stopped && retracted && !this.scheduler.fault;
    }
    if (!accepted && this.scheduler.fault) this.lastError = this.scheduler.fault;
    if (this.audio.status === 'fault') this._handledAudioFaultEpoch = this.audio.epoch;
    this.metrics.cancels++; this._event('cancel', { accepted, reason });
    return accepted;
  }

  sync() {
    let audio = this.audio.snapshot();
    if (this._disposed || !this.owner || audio.epoch !== this.owner.epoch) return audio;
    if (audio.status === 'fault') {
      // A failed cleanup requires an explicit host retry, not one retry per RAF.
      if (this._handledAudioFaultEpoch !== audio.epoch) {
        this._handledAudioFaultEpoch = audio.epoch;
        this._error(audio.fault ?? 'audio_fault');
      }
      return this.audio.snapshot();
    }
    if (same(this.owner, this.scheduler.identity) && ACTIVE.has(this.scheduler.status)
      && ['buffering', 'playing', 'paused', 'ended'].includes(audio.status)) {
      this.scheduler.playback({ ...this.owner, status: audio.status, time: audio.time });
      if (this.scheduler.fault) { this.lastError = this.scheduler.fault; this._clearFeed(); this.sidecar.cancel(this.owner); }
      if (audio.status === 'ended') { this._clearFeed(); this.sidecar.cancel(this.owner); }
      audio = this.audio.snapshot();
    }
    return audio;
  }

  enqueue(cue, owner = this.owner) {
    if (!this._current(owner)) return this._reject('wrong_owner');
    if (!cue || typeof cue !== 'object' || Array.isArray(cue)) return this._reject('invalid_cue');
    return this.scheduler.enqueue({ ...cue, ...owner, id: cue.id ?? `manual-${++this._cueSequence}` });
  }

  pushSubtitle(text, { owner = this.owner, itemId = 'reply-text', sequence } = {}) {
    if (!this._current(owner)) return this._reject('wrong_owner');
    if (!this._sidecarEnabled) return { accepted: false, reason: 'sidecar_disabled' };
    const next = this._subtitleSequences.get(itemId) ?? 0;
    const value = sequence ?? next;
    const result = this.sidecar.push({ ...owner, itemId, sequence: value, text });
    if (result.accepted && this._subtitleSequences.size < this.sidecar.maxItems) {
      this._subtitleSequences.set(itemId, Math.max(next, value + 1));
    } else if (result.accepted && this._subtitleSequences.has(itemId)) {
      this._subtitleSequences.set(itemId, Math.max(next, value + 1));
    }
    return result;
  }

  finishSubtitles(owner = this.owner) {
    return this._current(owner) && this._sidecarEnabled && this.sidecar.finish(owner);
  }

  snapshot() {
    return { owner: copy(this.owner), audio: this.audio.snapshot(), scheduler: this.scheduler.snapshot(),
      sidecar: this.sidecar.snapshot(), events: structuredClone(this.events), metrics: { ...this.metrics },
      duration: this.duration, lastError: this.lastError, disposed: this._disposed };
  }

  dispose() {
    if (this._disposed) return;
    this.cancel('disposed'); this.sidecar.dispose(); this._disposed = true;
    this._clearFeed();
  }
}
