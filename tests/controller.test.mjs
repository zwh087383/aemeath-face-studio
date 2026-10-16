import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FaceController } from '../preview/core/controller.js';
import { LipTrack } from '../preview/core/lip-track.js';
import { C, CHANNELS, PRESETS, VOWELS } from '../preview/core/profile.js';

const read = name => JSON.parse(readFileSync(new URL(`../outputs/${name}`, import.meta.url), 'utf8'));
const track = new LipTrack(read('chinese-probe.json'), read('waveform.json'));
const sumMouth = c => VOWELS.reduce((s, i) => s + c.weights[i], 0);
const tick = (c, until, lip = null, start = 0) => { for (let t = start; t < until; t += 1 / 60) c.update(t, 1 / 60, lip, false); };
const cue = overrides => ({ id: 'cue', epoch: 1, kind: 'action', action: 'nod', at: .2, duration: .86, ...overrides });

test('all eight expressions remain finite and bounded during the actual lip track', () => {
  for (const preset of PRESETS) {
    const c = new FaceController(); c.setPreset(preset.id, 1); c.begin(1);
    for (let t = 0; t < track.data.audio_seconds; t += 1 / 60) {
      c.playback(1, 'playing', t); c.update(t, 1 / 60, track.sample(t, 1.5));
      assert.ok([...c.weights].every(x => Number.isFinite(x) && x >= 0 && x <= 1), preset.id);
      assert.ok(sumMouth(c) <= .720001, preset.id);
      assert.ok(c.weights[C.blink] + Math.max(c.weights[C.smileEyes], c.weights[C.wink]) <= 1.000001);
    }
  }
});

test('speaking surprise keeps its brow but does not force an open mouth in silence', () => {
  const c = new FaceController(); c.setPreset('surprise'); c.begin(1);
  tick(c, 1, { weights: new Float32Array(CHANNELS.length), closure: 0 });
  assert.ok(c.weights[C.browUp] > .5); assert.equal(sumMouth(c), 0);
});

test('closed lips attenuate smile without wiping the eyes', () => {
  const c = new FaceController(); c.setPreset('smile'); c.begin(1);
  tick(c, 1, { weights: new Float32Array(CHANNELS.length), closure: 1 });
  assert.ok(c.weights[C.smile] < .13); assert.ok(c.weights[C.eyeSmile] > .2);
});

test('pause freezes audio-scoped gesture and expression; resume continues the same cue', () => {
  const c = new FaceController(); c.begin(1); c.enqueue(cue({ at: 0, duration: 2 }));
  c.enqueue(cue({ id: 'face', kind: 'expression', preset: 'shy', at: 0, duration: 3 }));
  c.playback(1, 'playing', .5); tick(c, .5);
  c.playback(1, 'paused', .5); tick(c, 5, null, .5);
  assert.equal(c.cues.length, 2); assert.equal(c.activePreset, 'shy');
  assert.ok(c.activeActions.includes('nod')); assert.equal(sumMouth(c), 0);
  c.playback(1, 'playing', 2.5); c.update(5.1, .1);
  assert.equal(c.activeActions.length, 0); assert.equal(c.activePreset, 'shy');
});

test('cancellation closes an open mouth within 120ms, revokes gestures and rejects stale events', () => {
  const c = new FaceController(); c.begin(1);
  const w = new Float32Array(CHANNELS.length); w[C.a] = .7;
  c.playback(1, 'playing', .3); c.enqueue(cue({ at: .3 })); tick(c, .5, { weights: w });
  assert.ok(sumMouth(c) > .6); assert.equal(c.cancel(1), true);
  assert.equal(c.enqueue(cue({ id: 'late', at: .4 })), false);
  assert.equal(c.playback(1, 'playing', .6), false); assert.equal(c.begin(1), false);
  tick(c, .62, { weights: w }, .5);
  assert.ok(sumMouth(c) < .01); assert.equal(c.cues.length, 0); assert.equal(c.activeActions.length, 0);
  assert.equal(c.status, 'cancelled');
});

test('old completion cannot end the next utterance', () => {
  const c = new FaceController(); c.begin(1); c.cancel(1); c.begin(2);
  assert.equal(c.playback(1, 'ended', 9), false); assert.equal(c.cancel(1), false);
  assert.equal(c.active, true); assert.equal(c.epoch, 2);
});

test('cue IDs deduplicate; invalid, expired and late gesture input is rejected', () => {
  const c = new FaceController(); c.begin(1); c.playback(1, 'playing', 1);
  assert.equal(c.enqueue(cue({ at: 1 })), true); assert.equal(c.enqueue(cue({ at: 1 })), false);
  for (const bad of [{ action: '__proto__' }, { duration: NaN }, { strength: Infinity }, { clock: 'unknown' }, { at: -.5 }, { at: 99 }, { at: .1 }, { at: .7 }]) {
    assert.equal(c.enqueue(cue({ id: JSON.stringify(bad), ...bad })), false, JSON.stringify(bad));
  }
  assert.equal(c.setPreset('constructor'), false);
});

test('ambient actions work without audio, are debounced, and expire', () => {
  const c = new FaceController(); c.update(1, .016, null, false);
  assert.equal(c.trigger('nod', 'first', 1), true); assert.equal(c.trigger('nod', 'duplicate', 1.1), false);
  c.update(1.25, .1, null, false); assert.ok(c.head.pitch > 0); assert.deepEqual(c.activeActions, ['nod']);
  tick(c, 2.5, null, 1.3); assert.equal(c.cues.length, 0); assert.ok(Math.abs(c.head.pitch) < .001);
});

test('track returns silence at end, negative and invalid positions', () => {
  for (const t of [-1, NaN, Infinity, track.data.audio_seconds, 200]) {
    assert.ok([...track.sample(t).weights].every(x => x === 0));
  }
});

test('natural blink does not jump closed during a wink transition', () => {
  const c = new FaceController(); c.setPreset('playful', 1); tick(c, 1);
  c.enqueue(cue({ id: 'blink', clock: 'wall', action: 'blink', at: 1, duration: .24 }));
  for (let t = 1; t < 1.4; t += .016) { c.update(t, .016, null, false); assert.ok(c.weights[C.wink] + c.weights[C.blink] <= 1.000001); }
});
