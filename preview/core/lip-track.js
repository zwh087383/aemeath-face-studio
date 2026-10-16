import { C, CHANNELS, VOWELS } from './profile.js';
import { clamp } from './controller.js';

export class LipTrack {
  constructor(data, waveform) {
    if (!data.frames?.length || !data.blendshape_names?.length || !(data.fps > 0) || !(waveform.step_seconds > 0)) throw new Error('口型曲线格式不完整');
    this.data = data;
    this.waveform = waveform;
    this.indices = Object.fromEntries(data.blendshape_names.map((name, i) => [name, i]));
    this.values = new Float32Array(data.blendshape_names.length);
    this.weights = new Float32Array(CHANNELS.length);
    this.result = { weights: this.weights, closure: 0, energy: 0 };
  }

  sample(time, gain = 1, mode = 'a2f') {
    const { data, waveform, weights: w, values } = this;
    w.fill(0);
    this.result.closure = 0;
    this.result.energy = 0;
    if (!Number.isFinite(time) || time < 0 || time >= data.audio_seconds) return this.result;
    const f = Math.min(time * data.fps, data.frames.length - 1), left = Math.floor(f), right = Math.min(left + 1, data.frames.length - 1), k = f - left;
    for (let i = 0; i < values.length; i++) values[i] = clamp(data.frames[left].weights[i] * (1 - k) + data.frames[right].weights[i] * k);
    const get = name => values[this.indices[name]] || 0;
    const energy = Math.max(0, waveform.rms[Math.min(waveform.rms.length - 1, Math.floor(time / waveform.step_seconds))] || 0);
    const gate = clamp((energy - .001) / .006);
    gain = clamp(gain, 0, 1.8);
    this.result.energy = energy;
    if (mode === 'volume') w[C.a] = clamp(Math.sqrt(energy) * 1.7 * gain, 0, .72);
    else {
      const opening = clamp(get('jawOpen') - .75 * get('mouthClose')) * gain * 1.55 * gate;
      const round = clamp(get('mouthFunnel') * 1.8 + get('mouthPucker') * 1.3);
      const stretch = (get('mouthStretchLeft') + get('mouthStretchRight')) * .5;
      const closure = clamp((get('mouthClose') - get('jawOpen')) * 2);
      const seal = 1 - .9 * closure;
      this.result.closure = closure;
      w[C.a] = opening * (1 - round) * .88;
      w[C.i] = opening * stretch * .42;
      w[C.u] = get('mouthPucker') * .60 * gain * gate * seal;
      w[C.e] = opening * stretch * .22;
      w[C.o] = (opening * round * .6 + get('mouthFunnel') * .46 * gain * gate) * seal;
      w[C.mouthWide] = stretch * .13 * gain * gate;
      w[C.mouthNarrow] = get('mouthPucker') * .12 * gain * gate;
      w[C.smile] = (get('mouthSmileLeft') + get('mouthSmileRight')) * .10 * gain;
      w[C.frown] = (get('mouthFrownLeft') + get('mouthFrownRight')) * .09 * gain;
    }
    const sum = VOWELS.reduce((s, i) => s + w[i], 0);
    if (sum > .72) for (const i of VOWELS) w[i] *= .72 / sum;
    return this.result;
  }
}
