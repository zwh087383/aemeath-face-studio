import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmLipTrack } from '../qwen/pcm-lip-track.mjs';
import { C, CHANNELS, VOWELS } from '../../preview/core/profile.js';

const owner = (epoch = 1) => ({ connectionId: 'connection-1', responseId: `response-${epoch}`, epoch });
const copy = result => ({ weights: Array.from(result.weights), energy: result.energy, closure: result.closure });
const wave = (rate, seconds, frequency = 260, amplitude = .2) => Float32Array.from(
  { length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));
const opening = result => VOWELS.reduce((sum, i) => sum + result.weights[i], 0);
const setup = (rate = 24000, options) => {
  const track = new PcmLipTrack(options), id = owner(); assert.equal(track.begin(id, rate), true); return { track, id };
};
function assertZero(result) {
  assert.equal(result.weights.length, CHANNELS.length);
  assert.ok(Array.from(result.weights).every(value => value === 0));
  assert.equal(result.energy, 0); assert.equal(result.closure, 0);
}
function assertBounded(result) {
  assert.ok(Array.from(result.weights).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.ok(opening(result) <= .720001);
  assert.ok(Number.isFinite(result.energy) && result.energy >= 0 && result.energy <= 1);
  for (let i = 0; i < CHANNELS.length; i++) {
    if (![...VOWELS, C.mouthWide, C.mouthNarrow].includes(i)) assert.equal(result.weights[i], 0);
  }
}

test('actual PCM produces bounded mouth movement; silence and absent audio stay closed', () => {
  const { track, id } = setup();
  assertZero(track.sample(id, 0));
  assert.equal(track.append(id, 0, new Float32Array(480)), true);
  assertZero(track.sample(id, .01));
  assert.equal(track.append(id, 1, wave(24000, .1)), true);
  const result = copy(track.sample(id, .07));
  assert.ok(opening(result) > .1); assert.ok(result.energy > .01); assertBounded(result);
  assertZero(track.sample(id, .12));
  assertZero(track.sample(id, 8));
  const snapshot = track.snapshot();
  assert.equal(snapshot.audio2Face, false); assert.equal(snapshot.phonemeRecognition, false);
});

test('all chunk splits produce identical finished features at integer and fractional frame sample rates', () => {
  for (const rate of [3000, 3001, 8000, 11025, 16000, 22050, 24000, 44100, 48000, 384000]) {
    const pcm = wave(rate, .137, 710), whole = setup(rate), parts = setup(rate);
    assert.equal(whole.track.append(whole.id, 0, pcm), true);
    let at = 0, sequence = 0;
    while (at < pcm.length) {
      const length = [1, 7, 29, 499, 67, 2][sequence % 6];
      assert.equal(parts.track.append(parts.id, sequence++, pcm.subarray(at, at + length)), true);
      at += length;
    }
    assert.equal(whole.track.finish(whole.id), true); assert.equal(parts.track.finish(parts.id), true);
    assert.equal(whole.track.snapshot().frames, 7);
    for (let i = 0; i < 27; i++) {
      const when = i * .005;
      assert.deepEqual(copy(parts.track.sample(parts.id, when)), copy(whole.track.sample(whole.id, when)), `${rate} Hz @ ${when}`);
    }
  }
});

test('partial frame is available without waiting for more PCM and finish preserves its exact extent', () => {
  const { track, id } = setup();
  assert.equal(track.append(id, 0, wave(24000, .005)), true);
  assert.equal(track.snapshot().frames, 0); assert.equal(track.snapshot().pendingSamples, 120);
  const before = copy(track.sample(id, .003)); assert.ok(opening(before) > 0);
  assertZero(track.sample(id, .006));
  assert.equal(track.finish(id), true);
  assert.equal(track.snapshot().frames, 1); assert.equal(track.snapshot().pendingSamples, 0);
  assert.deepEqual(copy(track.sample(id, .003)), before);
  assertZero(track.sample(id, .005));
  assert.equal(track.append(id, 1, wave(24000, .01)), false);
});

test('partial features also match different input chunk splits before finish', () => {
  const a = setup(11025), b = setup(11025), pcm = wave(11025, .027);
  a.track.append(a.id, 0, pcm);
  b.track.append(b.id, 0, pcm.subarray(0, 13)); b.track.append(b.id, 1, pcm.subarray(13));
  assert.deepEqual(copy(a.track.sample(a.id, .025)), copy(b.track.sample(b.id, .025)));
});

test('complete owner fence, epoch monotonicity and cancel block old responses without changing a new response', () => {
  const { track, id } = setup(); track.append(id, 0, wave(24000, .04));
  const badOwners = [null, {}, { ...id, connectionId: 'other' }, { ...id, responseId: 'other' }, { ...id, epoch: 2 }];
  const first = copy(track.sample(id, .01));
  for (const bad of badOwners) {
    assert.equal(track.append(bad, 1, wave(24000, .01)), false);
    assert.equal(track.finish(bad), false); assert.equal(track.cancel(bad), false);
    assertZero(track.sample(bad, .01));
    assert.deepEqual(copy(track.sample(id, .01)), first);
  }
  assert.equal(track.cancel(id), true); assertZero(track.sample(id, .01));
  assert.equal(track.snapshot().frames, 0); assert.equal(track.snapshot().receivedSamples, 0);
  assert.equal(track.begin(id, 24000), false);
  const newer = owner(2); assert.equal(track.begin(newer, 24000), true);
  track.append(newer, 0, wave(24000, .04, 1000));
  const second = copy(track.sample(newer, .01));
  assert.equal(track.cancel(id), false); assertZero(track.sample(id, .01));
  assert.deepEqual(copy(track.sample(newer, .01)), second);
});

test('begin copies identity and invalid begin cannot destroy a currently playing track', () => {
  const { track, id } = setup(); track.append(id, 0, wave(24000, .04));
  const expected = copy(track.sample(id, .01)); id.responseId = 'mutated';
  const original = owner(); assert.deepEqual(copy(track.sample(original, .01)), expected);
  for (const rate of [NaN, 0, -1, 2999, 384001, 24000.1, Infinity, '24000']) {
    assert.equal(track.begin(owner(2), rate), false);
    assert.deepEqual(copy(track.sample(original, .01)), expected);
  }
  for (const bad of [{ ...owner(2), epoch: 0 }, { ...owner(2), epoch: 1.5 },
    { ...owner(2), connectionId: '' }, { ...owner(2), responseId: 4 }]) {
    assert.equal(track.begin(bad, 24000), false);
  }
});

test('rejected sequence, invalid PCM and nonfinite packet are atomic even after a valid prefix', () => {
  const a = setup(), b = setup(), prefix = wave(24000, .007), suffix = wave(24000, .023, 1000);
  a.track.append(a.id, 0, prefix); b.track.append(b.id, 0, prefix);
  for (const sequence of [-1, 0, 2, .5, NaN, '1']) assert.equal(a.track.append(a.id, sequence, suffix), false);
  for (const invalid of [null, [], new Float64Array(12), new Float32Array(0),
    Float32Array.of(.2, .3, NaN), Float32Array.of(.2, Infinity), Float32Array.of(-Infinity)]) {
    assert.equal(a.track.append(a.id, 1, invalid), false);
    assert.equal(a.track.snapshot().receivedSamples, prefix.length);
    assert.equal(a.track.snapshot().nextSequence, 1);
  }
  assert.equal(a.track.append(a.id, 1, suffix), true); assert.equal(b.track.append(b.id, 1, suffix), true);
  for (const when of [.001, .015, .025]) assert.deepEqual(copy(a.track.sample(a.id, when)), copy(b.track.sample(b.id, when)));
});

test('finite extreme PCM is saturated and numerical output remains bounded', () => {
  const { track, id } = setup();
  const extreme = Float32Array.from({ length: 4800 }, (_, i) => i % 2 ? 3e38 : -3e38);
  assert.equal(track.append(id, 0, extreme), true);
  assert.equal(track.snapshot().metrics.clippedSamples, 4800);
  for (const when of [.001, .015, .025, .15, .19]) assertBounded(track.sample(id, when));
});

test('different spectra give different conservative poses without changing expression channels', () => {
  const low = setup(), middle = setup(), high = setup();
  low.track.append(low.id, 0, wave(24000, .2, 200));
  middle.track.append(middle.id, 0, wave(24000, .2, 1500));
  high.track.append(high.id, 0, wave(24000, .2, 6000));
  const a = copy(low.track.sample(low.id, .15)), b = copy(middle.track.sample(middle.id, .15)), c = copy(high.track.sample(high.id, .15));
  for (const result of [a, b, c]) assertBounded(result);
  assert.ok(a.weights[C.o] > b.weights[C.o]);
  assert.ok(b.weights[C.i] > a.weights[C.i]);
  assert.ok(opening(c) < opening(a));
});

test('DC bias decays to a closed mouth, while a speech-frequency wave remains active', () => {
  const { track, id } = setup(); track.append(id, 0, new Float32Array(24000).fill(.8));
  const result = copy(track.sample(id, .9));
  assert.equal(opening(result), 0); assert.ok(result.energy < 1e-8);
  assert.ok(result.weights.every(value => value === 0));
  track.append(id, 1, wave(24000, .1));
  assert.ok(opening(track.sample(id, 1.07)) > .1);
});

test('history and per-call work limits reject atomically and finish never exceeds the frame limit', () => {
  const { track, id } = setup(11025, { maxSeconds: .05, maxFrames: 2 });
  assert.equal(track.append(id, 0, wave(11025, .04)), true);
  assert.equal(track.snapshot().frames, 2);
  assert.equal(track.append(id, 1, Float32Array.of(.1)), false);
  assert.equal(track.snapshot().lastError, 'mouth_history_limit');
  assert.equal(track.finish(id), true); assert.equal(track.snapshot().frames, 2);
  const limited = setup(8000, { maxSeconds: .005 });
  assert.equal(limited.track.append(limited.id, 0, wave(8000, .006)), false);
  assert.equal(limited.track.snapshot().receivedSamples, 0);
  const chunky = setup(3000);
  assert.equal(chunky.track.append(chunky.id, 0, new Float32Array(6001)), false);
  assert.equal(chunky.track.snapshot().lastError, 'pcm_chunk_too_large');
  assert.equal(chunky.track.snapshot().receivedSamples, 0);
});

test('default two-minute storage limit is enforced, without retaining raw PCM', () => {
  const { track, id } = setup(3000), block = new Float32Array(6000);
  for (let sequence = 0; sequence < 60; sequence++) assert.equal(track.append(id, sequence, block), true);
  assert.equal(track.snapshot().frames, 6000); assert.equal(track.snapshot().receivedDuration, 120);
  assert.equal(track.append(id, 60, Float32Array.of(.1)), false);
  assert.equal(track.finish(id), true); assert.equal(track.snapshot().frames, 6000);
  assertZero(track.sample(id, 120));
  assert.ok(track.frames.every(frame => Object.values(frame).every(value => typeof value === 'number')));
});

test('invalid sample times, completion without PCM and borrowed result are deterministic', () => {
  const { track, id } = setup(); track.append(id, 0, wave(24000, .04));
  const borrowed = track.sample(id, .01); assert.ok(opening(borrowed) > 0);
  for (const when of [NaN, Infinity, -Infinity, -.01, '0.01', null]) {
    assert.strictEqual(track.sample(id, when), borrowed); assertZero(borrowed);
  }
  const empty = setup(); assert.equal(empty.track.finish(empty.id), true); assertZero(empty.track.sample(empty.id, 0));
  assert.equal(empty.track.finish(empty.id), false);
  for (const options of [{ maxSeconds: 121 }, { maxSeconds: 0 }, { maxFrames: 6001 }, { maxFrames: 0 }, { maxFrames: 1.2 }]) {
    assert.throws(() => new PcmLipTrack(options), RangeError);
  }
});
