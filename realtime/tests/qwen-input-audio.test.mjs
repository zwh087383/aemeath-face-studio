import test from 'node:test';
import assert from 'node:assert/strict';
import { resample16k, pcmBase64, decodePcm24k, rms16 } from '../qwen/input-audio.mjs';
test('resampling preserves duration and rejects malformed input', () => {
  for (const rate of [16000, 24000, 44100, 48000]) {
    const pcm = resample16k(new Float32Array(rate).fill(.5), rate);
    assert.equal(pcm.length, 16000); assert.ok(pcm.every(x => x === 16384));
  }
  assert.throws(() => resample16k(new Float32Array([NaN]), 16000));
});
test('network PCM is little endian and output decoding preserves signed values', () => {
  const pcm = new Int16Array([-32768, -1, 0, 1, 32767]);
  assert.deepEqual([...decodePcm24k(pcmBase64(pcm))], [...pcm].map(x => x / 32768));
  assert.equal(rms16(new Int16Array(320)), 0);
  assert.throws(() => decodePcm24k('AQ=='));
  assert.throws(() => pcmBase64(new Int16Array(16001)));
});
