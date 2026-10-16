// Area-average downsampling, 20ms messages; no microphone audio is played back.
class QwenMicPcm extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.remaining = this.ratio; this.sum = 0; this.frame = new Int16Array(320); this.index = 0; this.energy = 0; }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0]?.[0]; if (!input) return true;
    for (const raw of input) {
      let weight = 1; const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      while (weight > 1e-9) {
        const take = Math.min(weight, this.remaining); this.sum += value * take; this.remaining -= take; weight -= take;
        if (this.remaining < 1e-9) {
          const sample = this.sum / this.ratio; this.frame[this.index++] = Math.round(sample * 32767); this.energy += sample * sample;
          this.remaining = this.ratio; this.sum = 0;
          if (this.index === 320) { const pcm = this.frame.buffer; this.port.postMessage({ pcm, rms: Math.sqrt(this.energy / 320) }, [pcm]); this.frame = new Int16Array(320); this.index = 0; this.energy = 0; }
        }
      }
    }
    return true;
  }
}
registerProcessor('qwen-mic-pcm', QwenMicPcm);
