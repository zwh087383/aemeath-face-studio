import test from 'node:test';
import assert from 'node:assert/strict';
import { C, CHANNELS, VOWELS } from '../preview/core/profile.js';
import { FaceController } from '../preview/core/controller.js';
import { ExpressionChoreographer, blendExpressionOverlay, sampleGestureExpression } from '../preview/core/expression-choreography.js';

const articulation = [...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat];
const pose = values => Object.assign(new Float32Array(CHANNELS.length), Object.fromEntries(Object.entries(values).map(([k, v]) => [C[k], v])));
const listening = { mode: 'listening', warmth: .35, tension: .03, uncertainty: 0 };

test('an empty newly started expression does not normalize away the visible expression', () => {
  const single = new ExpressionChoreographer(), overlap = new ExpressionChoreographer();
  single.update(0); overlap.update(0);
  for (let n = 1; n <= 30; n++) {
    const active = { id: 'laugh-1', gesture: 'laugh', age: .95, expressionWeight: 1 };
    const a = single.update(n / 60, [active]);
    const b = overlap.update(n / 60, [active, { id: 'new-empty', gesture: 'wave', age: 0, expressionWeight: 1 }]);
    assert.deepEqual(b, a);
  }
});

test('cancelling a still-rising expression decays its rendered contribution without pursuing the old apex', () => {
  const expression = new ExpressionChoreographer(); expression.update(0);
  const gesture = { id: 'early-laugh', gesture: 'laugh', age: .95, expressionWeight: 1 };
  expression.update(1 / 60, [gesture]);
  let last = Float32Array.from(expression.weights);
  assert.ok(last[C.smileEyes] > 0 && last[C.smileEyes] < .3, 'cancel before filter catches up');
  for (let n = 2; n <= 100; n++) {
    const next = Float32Array.from(expression.update(n / 60, [{ ...gesture, recovering: true }]));
    assert.ok(next.every((x, i) => x <= last[i] + 1e-7), `old face rebounds at ${n}`);
    last = next;
  }
  assert.ok(last.every(x => x < 1e-4));
  const retired = Float32Array.from(expression.update(2, [gesture]));
  assert.ok(retired.every((x, i) => x <= last[i] + 1e-7), 'replayed non-recovering snapshot cannot resurrect same id');
});

test('cancelled expression keeps releasing during transport pause but unrelated active expressions stay frozen', () => {
  const expression = new ExpressionChoreographer(); expression.update(0);
  const gesture = { id: 'surprise-1', gesture: 'surprise', age: .3, expressionWeight: 1 };
  expression.update(.03, [gesture]);
  const before = Float32Array.from(expression.weights);
  assert.deepEqual(expression.update(.06, [gesture], { paused: true }), before);
  const released = expression.update(.09, [{ ...gesture, recovering: true }], { paused: true });
  assert.ok(released[C.eyeWide] < before[C.eyeWide]);
});

test('persistent attitude lowers old brows and eye shapes while speech and independent blink retain ownership', () => {
  const expression = new ExpressionChoreographer(); expression.update(0);
  for (let n = 1; n <= 120; n++) expression.update(n / 60, [], { attitude: listening });
  const base = pose({ browAnger: .8, browFocus: .6, eyeSharp: .7, smileEyes: .8, blink: .35, a: .2, mouthWide: .3 });
  const result = blendExpressionOverlay(base, expression.weights, { attitude: expression.attitude, mouthMode: 'speech' });
  assert.ok(result[C.browAnger] < .02);
  assert.ok(result[C.browFocus] < .02);
  assert.ok(result[C.eyeSharp] < .02);
  assert.ok(result[C.smileEyes] < .01);
  assert.equal(result[C.blink], base[C.blink]);
  assert.equal(result[C.a], base[C.a]); assert.equal(result[C.mouthWide], base[C.mouthWide]);
  assert.ok(result[C.smile] > .09 && result[C.smile] < .12);
  expression.update(2.2, [], { attitude: listening });
  assert.ok(blendExpressionOverlay(base, expression.weights, { attitude: expression.attitude, mouthMode: 'closed' })[C.smile] > .09,
    'attitude outlives the gesture and speech');
});

test('same preset and gesture corner target is not added twice', () => {
  const base = pose({ smile: .55, browSmile: .65 });
  const overlay = pose({ smile: .55, browSmile: .65 });
  const mixed = blendExpressionOverlay(base, overlay, { mouthMode: 'expression' });
  assert.equal(mixed[C.smile], base[C.smile]); assert.equal(mixed[C.browSmile], base[C.browSmile]);
});

test('explicit mouth modes distinguish closed, silent expression, and speech even with zero lip samples', () => {
  const face = new FaceController(); face.setPreset('happy', 1); face.begin(1);
  const zeros = { weights: new Float32Array(CHANNELS.length), closure: 0 };
  const overlay = sampleGestureExpression('laugh', .95);
  for (let n = 0; n < 30; n++) face.update(n / 60, 1 / 60, zeros, false, { mouthMode: 'speech' });
  let mixed = blendExpressionOverlay(face.weights, overlay, { mouthMode: 'speech' });
  assert.ok(articulation.every(i => mixed[i] === 0), 'empty audio does not grant the expression track mouth ownership');
  face.playback(1, 'ended', .5);
  for (let n = 30; n < 60; n++) face.update(n / 60, 1 / 60, zeros, false, { mouthMode: 'expression' });
  mixed = blendExpressionOverlay(face.weights, overlay, { mouthMode: 'expression' });
  assert.ok(mixed[C.a] > .3, 'explicit silent laugh can open its mouth after ended');
  face.update(1, 1 / 60, zeros, false, { mouthMode: 'closed' });
  mixed = blendExpressionOverlay(face.weights, overlay, { mouthMode: 'closed' });
  assert.ok(articulation.every(i => mixed[i] === 0));
  assert.ok(mixed[C.smile] > .3, 'closed articulation does not erase safe corner attitude');
  const invalid = blendExpressionOverlay(face.weights, overlay, { mouthMode: 'typo' });
  assert.ok(articulation.every(i => invalid[i] === 0), 'invalid explicit modes fail closed');
});

test('pause freezes rising preset, attitude and head; mouth closes and blink can proceed independently', () => {
  const face = new FaceController(); face.setPreset('surprise', 1); face.begin(1);
  face.playback(1, 'playing', .02);
  const lip = { weights: pose({ a: .6 }), closure: 0 };
  face.update(.02, .02, lip, true, { mouthMode: 'speech' });
  const faceBefore = Float32Array.from(face.weights), headBefore = { ...face.head };
  face.playback(1, 'paused', .02);
  face.nextBlink = .1;
  for (let n = 2; n <= 10; n++) face.update(n * .02, .02, lip, true, { mouthMode: 'closed', paused: true });
  assert.equal(face.weights[C.browUp], faceBefore[C.browUp]);
  assert.ok(face.weights[C.eyeWide] <= faceBefore[C.eyeWide], 'independent blink may temporarily occlude the held eye pose');
  assert.deepEqual(face.head, headBefore);
  assert.ok(face.weights[C.blink] > 0);
  assert.ok(articulation.every(i => face.weights[i] === 0));
  for (let n = 11; n <= 30; n++) face.update(n * .02, .02, lip, true, { mouthMode: 'closed', paused: true });
  assert.equal(face.weights[C.eyeWide], faceBefore[C.eyeWide], 'held eye pose returns after independent blink');
  face.playback(1, 'playing', .04);
  face.update(.62, .02, lip, false, { mouthMode: 'speech' });
  assert.ok(face.weights[C.browUp] > faceBefore[C.browUp]);

  const expression = new ExpressionChoreographer(); expression.update(0);
  expression.update(.02, [], { attitude: { ...listening, warmth: 1 } });
  const before = { weights: Float32Array.from(expression.attitude.weights), weight: expression.attitude.weight };
  expression.update(10, [], { attitude: listening, paused: true });
  assert.deepEqual(expression.attitude, before);
  expression.update(10.02, [], { attitude: listening });
  assert.ok(expression.attitude.weight - before.weight < .15, 'resume uses a frame interval, not paused wall time');
});

test('base preset cancellation does not continue to approach an undisplayed target', () => {
  const face = new FaceController(); face.begin(1);
  face.enqueue({ id: 'surprise', kind: 'expression', preset: 'surprise', clock: 'audio', epoch: 1, at: 0, duration: 2 });
  face.playback(1, 'playing', .22); face.update(.02, .02, null, false, { mouthMode: 'closed' });
  let last = face.weights[C.browUp]; assert.ok(last > 0);
  face.cancel(1);
  for (let n = 2; n <= 30; n++) {
    face.update(n * .02, .02, null, false, { mouthMode: 'closed' });
    assert.ok(face.weights[C.browUp] <= last); last = face.weights[C.browUp];
  }
});
