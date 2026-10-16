/** Deterministic offline resampling for the synthetic audio-input probe. */
export function resample16k(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new TypeError('PCM input required');
  const size = Math.floor(samples.length * 16000 / sampleRate), out = new Int16Array(size), ratio = sampleRate / 16000;
  for (let i = 0; i < size; i++) {
    const start = i * ratio, end = (i + 1) * ratio; let total = 0, area = 0;
    for (let j = Math.floor(start); j < Math.ceil(end) && j < samples.length; j++) {
      if (!Number.isFinite(samples[j])) throw new TypeError('Non-finite PCM');
      const weight = Math.min(end, j + 1) - Math.max(start, j); total += samples[j] * weight; area += weight;
    }
    out[i] = Math.round(Math.max(-1, Math.min(1, total / area)) * 32767);
  }
  return out;
}
export function pcmBase64(samples) {
  if (!(samples instanceof Int16Array) || samples.length > 16000) throw new TypeError('Bounded PCM16 required');
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
}
export function decodePcm24k(base64) {
  if (typeof base64 !== 'string' || base64.length > 512000) throw new TypeError('Invalid output PCM size');
  const binary = atob(base64); if (!binary.length || binary.length % 2) throw new TypeError('Invalid PCM16');
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), data = new DataView(bytes.buffer), pcm = new Float32Array(bytes.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.getInt16(i * 2, true) / 32768;
  return pcm;
}
export function rms16(samples) { let sum = 0; for (const x of samples) sum += (x / 32768) ** 2; return Math.sqrt(sum / Math.max(1, samples.length)); }

export async function captureMicrophone(context, onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  try {
    await context.audioWorklet.addModule(new URL('./mic-worklet.mjs', import.meta.url));
    const source = context.createMediaStreamSource(stream), processor = new AudioWorkletNode(context, 'qwen-mic-pcm'), silent = context.createGain(); silent.gain.value = 0;
    let stopped = false;
    processor.port.onmessage = event => { if (!stopped) onChunk(new Int16Array(event.data.pcm), event.data.rms); };
    source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    return { stop() { if (stopped) return; stopped = true; processor.port.onmessage = null;
      for(const node of [source,processor,silent]) {try{node.disconnect();}catch{/* release all tracks even after a node failure */}}
      for(const track of stream.getTracks()) {try{track.stop();}catch{/* continue releasing remaining tracks */}}
    } };
  } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
}
