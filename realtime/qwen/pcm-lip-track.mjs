import { C, CHANNELS, VOWELS } from '../../preview/core/profile.js';

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const validOwner = value => value && typeof value.connectionId === 'string'
  && value.connectionId.length > 0 && value.connectionId.length <= 256
  && typeof value.responseId === 'string' && value.responseId.length > 0
  && value.responseId.length <= 256 && Number.isSafeInteger(value.epoch) && value.epoch > 0;
const same = (a, b) => validOwner(a) && b && a.connectionId === b.connectionId
  && a.responseId === b.responseId && a.epoch === b.epoch;
const clockMs = () => globalThis.performance?.now() ?? Date.now();

/** Causal, inexpensive PCM mouth movement, NOT phoneme recognition or Audio2Face.
 * Three approximate frequency bands vary a bounded open-mouth pose. Features are
 * attached to media timestamps, never arrival timestamps; the renderer must use
 * them only while its audio player is playing. No PCM, text or credentials stay
 * in the track. Every sample() result is borrowed and valid until the next call.
 *
 * append() work is bounded to two seconds of mono PCM per call. A rejected block
 * is atomic and does not advance the sequence or DSP state. The caller may drop
 * this optional mouth path without delaying or stopping audio.
 */
export class PcmLipTrack {
  constructor({ maxSeconds = 120, maxFrames = 6000 } = {}) {
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 120
      || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 6000) {
      throw new RangeError('Mouth history must be bounded to <=120 seconds and <=6000 frames');
    }
    this.maxSeconds = maxSeconds; this.maxFrames = maxFrames;
    this.owner = null; this.highestEpoch = 0; this.status = 'idle'; this.lastError = null;
    this.sampleRate = 0; this.nextSequence = 0; this.receivedSamples = 0;
    this.frames = []; this._pendingCount = 0; this._sums = [0, 0, 0, 0];
    this._previous = 0; this._highpass = 0; this._low = 0; this._middle = 0;
    this._result = { weights: new Float32Array(CHANNELS.length), closure: 0, energy: 0 };
    this.metrics = { rejected: 0, acceptedChunks: 0, clippedSamples: 0,
      analysisMsTotal: 0, analysisMsMax: 0 };
  }

  _reject(reason) { this.lastError = reason; this.metrics.rejected++; return false; }
  _zero() { this._result.weights.fill(0); this._result.closure = 0; this._result.energy = 0; return this._result; }
  _clear() {
    this.frames = []; this.receivedSamples = 0; this.nextSequence = 0;
    this._pendingCount = 0; this._sums.fill(0);
    this._previous = 0; this._highpass = 0; this._low = 0; this._middle = 0;
    this._zero();
  }

  begin(owner, sampleRate) {
    if (!validOwner(owner) || owner.epoch <= this.highestEpoch) return this._reject('invalid_or_old_owner');
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 3000 || sampleRate > 384000) {
      return this._reject('invalid_sample_rate');
    }
    this._clear(); this.owner = Object.freeze({ connectionId: owner.connectionId,
      responseId: owner.responseId, epoch: owner.epoch });
    this.highestEpoch = owner.epoch; this.sampleRate = sampleRate; this.status = 'open'; this.lastError = null;
    // First-order filters give a coarse low/mid/high balance with constant work.
    // The DC blocker stops static PCM offsets from holding the jaw open.
    this._dcAlpha = Math.exp(-2 * Math.PI * 40 / sampleRate);
    this._lowAlpha = 1 - Math.exp(-2 * Math.PI * Math.min(700, sampleRate * .20) / sampleRate);
    this._midAlpha = 1 - Math.exp(-2 * Math.PI * Math.min(2400, sampleRate * .40) / sampleRate);
    return true;
  }

  _feature(count = this._pendingCount, end = this.receivedSamples) {
    const [power, low, middle, high] = this._sums;
    const rms = Math.sqrt(Math.max(0, power / Math.max(1, count)));
    const bands = low + middle + high + 1e-12;
    const round = clamp((low / bands - .30) / .65);
    const spread = clamp(middle / bands * 1.65);
    const gate = clamp((rms - .0025) / .015);
    const opening = clamp(Math.sqrt(rms) * 1.55 * gate, 0, .68)
      * (1 - .48 * clamp(high / bands));
    return { start: (end - count) / this.sampleRate, end: end / this.sampleRate,
      rms, round, spread, opening };
  }

  append(owner, sequence, samples) {
    if (!same(owner, this.owner) || this.status !== 'open') return this._reject('inactive_or_old_owner');
    if (!Number.isSafeInteger(sequence) || sequence !== this.nextSequence) return this._reject('non_contiguous_sequence');
    if (!(samples instanceof Float32Array) || !samples.length) return this._reject('invalid_pcm');
    if (samples.length > this.sampleRate * 2) return this._reject('pcm_chunk_too_large');
    const nextCount = this.receivedSamples + samples.length;
    if (nextCount > Math.floor(this.sampleRate * this.maxSeconds)
      || nextCount > Math.round(this.maxFrames * this.sampleRate / 50)) return this._reject('mouth_history_limit');
    const started = clockMs();
    // Validate before touching DSP state: retrying the sequence cannot inherit a
    // prefix of a rejected packet. Finite out-of-range PCM is safely saturated.
    for (const value of samples) if (!Number.isFinite(value)) return this._reject('nonfinite_pcm');
    for (const value of samples) {
      const x = clamp(value, -1, 1);
      if (value !== x) this.metrics.clippedSamples++;
      const highpass = this._dcAlpha * (this._highpass + x - this._previous);
      this._previous = x; this._highpass = highpass;
      this._low += this._lowAlpha * (highpass - this._low);
      this._middle += this._midAlpha * (highpass - this._middle);
      const low = this._low, middle = this._middle - low, high = highpass - this._middle;
      this._sums[0] += highpass * highpass; this._sums[1] += low * low;
      this._sums[2] += middle * middle; this._sums[3] += high * high;
      this.receivedSamples++; this._pendingCount++;
      // Absolute rounded boundaries keep non-50-divisible sample rates on the
      // same 20 ms timeline, independently of network chunk boundaries.
      if (this.receivedSamples === Math.round((this.frames.length + 1) * this.sampleRate / 50)) {
        this.frames.push(this._feature()); this._pendingCount = 0; this._sums.fill(0);
      }
    }
    this.nextSequence++; this.metrics.acceptedChunks++; this.lastError = null;
    const elapsed = Math.max(0, clockMs() - started);
    this.metrics.analysisMsTotal += elapsed; this.metrics.analysisMsMax = Math.max(this.metrics.analysisMsMax, elapsed);
    return true;
  }

  sample(owner, playbackTime) {
    const result = this._zero();
    if (!same(owner, this.owner) || !['open', 'finished'].includes(this.status)
      || !Number.isFinite(playbackTime) || playbackTime < 0
      || playbackTime >= this.receivedSamples / this.sampleRate) return result;
    // Binary search handles rounded sample boundaries and the short final frame.
    let lo = 0, hi = this.frames.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1;
      if (this.frames[mid].end <= playbackTime) lo = mid + 1; else hi = mid;
    }
    const frame = this.frames[lo] ?? (this._pendingCount ? this._feature() : null);
    if (!frame || playbackTime < frame.start || playbackTime >= frame.end) return result;
    const { opening, round, spread, rms } = frame, w = result.weights;
    w[C.a] = opening * (1 - .65 * round - .25 * spread);
    w[C.i] = opening * spread * .35; w[C.e] = opening * spread * .18;
    w[C.u] = opening * round * .28; w[C.o] = opening * round * .40;
    w[C.mouthWide] = opening * spread * .12;
    w[C.mouthNarrow] = opening * round * .12;
    const total = VOWELS.reduce((sum, i) => sum + w[i], 0);
    if (total > .72) for (const i of VOWELS) w[i] *= .72 / total;
    result.energy = clamp(rms);
    // There is no bilabial/phoneme classifier, so do not invent a seal signal.
    return result;
  }

  finish(owner) {
    if (!same(owner, this.owner) || this.status !== 'open') return this._reject('inactive_or_old_owner');
    if (this._pendingCount) { this.frames.push(this._feature()); this._pendingCount = 0; this._sums.fill(0); }
    this.status = 'finished'; this.lastError = null; return true;
  }

  cancel(owner) {
    if (!same(owner, this.owner)) return this._reject('inactive_or_old_owner');
    this._clear(); this.status = 'cancelled'; this.lastError = null; return true;
  }

  snapshot() {
    return { mode: 'pcm_coarse_visemes', phonemeRecognition: false, audio2Face: false,
      owner: this.owner ? { ...this.owner } : null, status: this.status, sampleRate: this.sampleRate,
      nextSequence: this.nextSequence, receivedSamples: this.receivedSamples,
      receivedDuration: this.sampleRate ? this.receivedSamples / this.sampleRate : 0,
      frames: this.frames.length, pendingSamples: this._pendingCount,
      frameSeconds: .02, maxSeconds: this.maxSeconds, maxFrames: this.maxFrames,
      maxAppendSeconds: 2, lastError: this.lastError, metrics: { ...this.metrics } };
  }
}
