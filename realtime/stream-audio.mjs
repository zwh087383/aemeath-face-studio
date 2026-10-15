/** Mono PCM streaming player. Media time advances only over scheduled content;
 * AudioContext time is submission evidence, not a physical speaker measurement.
 * No provider credentials, microphone access, or character dependencies.
 */
export class StreamingAudioTransport {
  constructor(context, {
    leadSeconds = 0.04, maxBufferedSeconds = 20,
    maxRetainedSeconds = 120, volume = 0.12,
  } = {}) {
    if (!context || !['resume', 'createBuffer', 'createBufferSource', 'createGain']
      .every(name => typeof context[name] === 'function')) throw new TypeError('AudioContext required');
    for (const [name, value] of Object.entries({ leadSeconds, maxBufferedSeconds, maxRetainedSeconds })) {
      if (!Number.isFinite(value) || (name === 'leadSeconds' ? value < 0 : value <= 0)) {
        throw new RangeError(`Invalid ${name}`);
      }
    }
    this.context = context;
    this.leadSeconds = leadSeconds;
    this.maxBufferedSeconds = maxBufferedSeconds;
    this.maxRetainedSeconds = maxRetainedSeconds;
    this.volume = 0.12;
    this.epoch = 0;
    this.status = 'idle';
    this.fault = null;
    this.lastError = null;
    this._position = 0;
    this._frames = 0;
    this._sampleRate = 24000;
    this._sequence = 0;
    this._finished = false;
    this._wanted = false;
    this._operation = 0;
    this._generation = 0;
    this._chunks = [];
    this._sources = [];
    this._gain = null;
    this.setVolume(volume);
  }

  get receivedDuration() { return this._frames / this._sampleRate; }

  _reject(reason) { this.lastError = reason; return false; }

  _recordFault(error) {
    this.fault = error instanceof Error ? error.message : String(error);
    this.lastError = this.fault;
    this.status = 'fault';
    this._wanted = false;
    ++this._operation;
  }

  // Attempt every cleanup operation, even after one fails. Failed handles stay
  // reachable for explicit cancel() retry; unknown cleanup is never success.
  _cut() {
    ++this._generation;
    const errors = [];
    const attempt = fn => { try { fn(); return true; } catch (error) { errors.push(error); return false; } };
    if (this._gain) {
      attempt(() => this._gain.gain.cancelScheduledValues(this.context.currentTime));
      attempt(() => this._gain.gain.setValueAtTime(0, this.context.currentTime));
    }
    const pending = [];
    for (const entry of this._sources) {
      entry.source.onended = null;
      const stopped = !entry.started || entry.stopped || attempt(() => entry.source.stop());
      const disconnected = entry.disconnected || attempt(() => entry.source.disconnect());
      entry.stopped = stopped;
      entry.disconnected = disconnected;
      entry.chunk.entry = null;
      if (!stopped || !disconnected) pending.push(entry);
    }
    this._sources = pending;
    if (this._gain && attempt(() => this._gain.disconnect())) this._gain = null;
    if (errors.length) throw new AggregateError(errors, `Audio cleanup failed: ${errors.map(e => e.message || e).join('; ')}`);
  }

  _fail(error) {
    this._recordFault(error);
    try { this._cut(); } catch (cleanupError) {
      this._recordFault(new Error(`${this.fault}; ${cleanupError.message}`));
    }
  }

  _refresh() {
    if (['idle', 'cancelled', 'fault'].includes(this.status)) return;
    if (this.context.state === 'closed') { this._fail(new Error('AudioContext closed')); return; }
    const now = this.context.currentTime;
    for (const entry of this._sources) {
      if (now >= entry.start) {
        this._position = Math.max(this._position,
          now >= entry.end ? entry.mediaEnd
            : Math.min(entry.mediaEnd, entry.mediaStart + Math.max(0, now - entry.start)));
      }
    }
    this._position = Math.min(this.receivedDuration, this._position);
    const remaining = [];
    for (const entry of this._sources) {
      if (now < entry.end) { remaining.push(entry); continue; }
      entry.source.onended = null;
      try { entry.source.disconnect(); } catch (error) { this._fail(error); return; }
      entry.chunk.entry = null;
    }
    this._sources = remaining;
    this._chunks = this._chunks.filter(chunk => chunk.end > this._position);
    if (this._finished && this._position >= this.receivedDuration) {
      this.status = 'ended';
      this._wanted = false;
      if (this._gain) {
        try { this._gain.disconnect(); this._gain = null; }
        catch (error) { this._fail(error); }
      }
    } else if (this.status === 'paused' && !this._wanted) {
      // Explicit pause survives append(), finish(), and snapshot().
    } else if (this._wanted && this.context.state !== 'running') {
      this.status = 'paused';
    } else {
      this.status = this._wanted && remaining.some(e => now >= e.start && now < e.end)
        ? 'playing' : 'buffering';
    }
  }

  _schedule() {
    if (!this._wanted || this.context.state !== 'running' || ['fault', 'ended', 'cancelled'].includes(this.status)) return;
    const now = this.context.currentTime;
    let next = this._sources.at(-1)?.end;
    if (next === undefined || next < now) next = now + this.leadSeconds;
    try {
      for (const chunk of this._chunks) {
        if (chunk.entry || chunk.end <= this._position) continue;
        if (!this._gain) {
          this._gain = this.context.createGain();
          this._gain.gain.value = this.volume;
          this._gain.connect(this.context.destination);
        }
        const source = this.context.createBufferSource();
        const offset = Math.max(0, this._position - chunk.start);
        const mediaStart = chunk.start + offset;
        const duration = chunk.end - mediaStart;
        const entry = { source, chunk, start: next, end: next + duration,
          mediaStart, mediaEnd: chunk.end, generation: this._generation,
          started: false, stopped: false, disconnected: false };
        // Register before browser calls so a partially failed start is cleaned.
        this._sources.push(entry);
        chunk.entry = entry;
        source.buffer = chunk.buffer;
        source.connect(this._gain);
        source.onended = () => {
          if (entry.generation !== this._generation || !this._sources.includes(entry)) return;
          this._refresh();
        };
        source.start(next, offset, duration);
        entry.started = true;
        next = entry.end;
      }
      this._refresh();
    } catch (error) { this._fail(error); }
  }

  begin(epoch, { sampleRate = 24000 } = {}) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) return this._reject('epoch_must_increase');
    if (!Number.isInteger(sampleRate) || sampleRate < 3000 || sampleRate > 384000) return this._reject('invalid_sample_rate');
    if (this.status === 'fault') return this._reject('cleanup_required');
    if (this.context.state === 'closed') return this._reject('context_closed');
    ++this._operation;
    this._refresh();
    if (this.status === 'fault') return false;
    try { this._cut(); } catch (error) { this._recordFault(error); return false; }
    this.epoch = epoch;
    this._sampleRate = sampleRate;
    this._position = 0;
    this._frames = 0;
    this._sequence = 0;
    this._chunks = [];
    this._finished = false;
    this._wanted = false;
    this.fault = null;
    this.lastError = null;
    this.status = 'buffering';
    return true;
  }

  append({ epoch, sequence, samples } = {}) {
    this._refresh();
    if (epoch !== this.epoch || this.epoch === 0) return this._reject('stale_epoch');
    if (['fault', 'cancelled', 'ended', 'idle'].includes(this.status) || this._finished) return this._reject('stream_not_accepting');
    if (!Number.isSafeInteger(sequence) || sequence !== this._sequence) return this._reject('non_contiguous_sequence');
    if (!(samples instanceof Float32Array) || !samples.length) return this._reject('invalid_samples');
    const duration = samples.length / this._sampleRate;
    if (this.receivedDuration - this._position + duration > this.maxBufferedSeconds + 1e-9) return this._reject('buffer_limit');
    const retained = this._chunks.reduce((sum, chunk) => sum + chunk.buffer.length / this._sampleRate, 0);
    if (retained + duration > this.maxRetainedSeconds + 1e-9 || this._chunks.length >= 4096) return this._reject('retention_limit');
    for (const sample of samples) if (!Number.isFinite(sample)) return this._reject('non_finite_samples');
    try {
      const buffer = this.context.createBuffer(1, samples.length, this._sampleRate);
      buffer.getChannelData(0).set(samples);
      const start = this.receivedDuration;
      this._frames += samples.length;
      this._chunks.push({ buffer, start, end: this.receivedDuration, entry: null });
      ++this._sequence;
      this.lastError = null;
      this._schedule();
      return this.status !== 'fault';
    } catch (error) { this._fail(error); return false; }
  }

  async play() {
    if (!this.epoch || ['fault', 'cancelled', 'ended'].includes(this.status)) return this._reject('stream_not_playable');
    const operation = ++this._operation;
    const epoch = this.epoch;
    try { await this.context.resume(); } catch (error) {
      if (operation === this._operation && epoch === this.epoch) this._fail(error);
      return false;
    }
    if (operation !== this._operation || epoch !== this.epoch) return false;
    if (this.context.state !== 'running') { this._fail(new Error('AudioContext did not resume')); return false; }
    this._wanted = true;
    this._refresh();
    this._schedule();
    return this.status !== 'fault';
  }

  resume() { return this.play(); }

  pause() {
    if (!this.epoch || ['idle', 'cancelled', 'ended', 'fault'].includes(this.status)) return false;
    ++this._operation;
    this._refresh();
    if (this.status === 'fault') throw new Error(this.fault);
    if (this.status === 'ended') return false;
    this._wanted = false;
    try { this._cut(); } catch (error) { this._recordFault(error); throw error; }
    this.status = 'paused';
    return true;
  }

  cancel() {
    ++this._operation;
    this._refresh();
    this._wanted = false;
    this._chunks = [];
    this._finished = true;
    try { this._cut(); } catch (error) { this._recordFault(error); throw error; }
    this.fault = null;
    this.lastError = null;
    this.status = 'cancelled';
    return true;
  }

  finish(epoch) {
    this._refresh();
    if (epoch !== this.epoch || !this.epoch || ['idle', 'cancelled', 'fault'].includes(this.status)) return this._reject('stale_or_inactive_epoch');
    this._finished = true;
    this._refresh();
    return this.status !== 'fault';
  }

  setVolume(value) {
    if (!Number.isFinite(value)) return false;
    this.volume = Math.max(0, Math.min(1, value));
    if (this._gain) {
      try { this._gain.gain.setValueAtTime(this.volume, this.context.currentTime); }
      catch (error) { this._fail(error); return false; }
    }
    return true;
  }

  snapshot() {
    this._refresh();
    this._schedule();
    const now = this.context.currentTime;
    return {
      epoch: this.epoch, status: this.status, time: this._position,
      receivedDuration: this.receivedDuration,
      queuedSeconds: this.status === 'cancelled' ? 0 : Math.max(0, this.receivedDuration - this._position),
      retainedSeconds: this._chunks.reduce((sum, chunk) => sum + chunk.buffer.length / this._sampleRate, 0),
      sourceActive: this.status === 'playing' && this.context.state === 'running'
        && this._sources.some(e => now >= e.start && now < e.end && !e.stopped && !e.disconnected),
      sourceCount: this._sources.length, context: this.context.state,
      finished: this._finished, nextSequence: this._sequence,
      sampleRate: this._sampleRate, volume: this.volume,
      fault: this.fault, lastError: this.lastError,
    };
  }
}
