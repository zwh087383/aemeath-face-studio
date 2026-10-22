import test from 'node:test';
import assert from 'node:assert/strict';
import { GESTURES, GESTURE_IDS, EXPANDED_GESTURE_IDS } from '../preview/core/motion-profile.js';
import { C, CHANNELS, VOWELS } from '../preview/core/profile.js';
import { sampleGestureExpression, ExpressionChoreographer, blendExpressionOverlay } from '../preview/core/expression-choreography.js';

test('public vocabulary remains scheduler-compatible and every performance has a complete expression envelope', () => {
  assert.equal(GESTURE_IDS.length, 16 + EXPANDED_GESTURE_IDS.length);
  for (const legacy of ['wave', 'chest', 'shrug', 'explain']) assert.ok(GESTURE_IDS.includes(legacy));
  for (const id of GESTURE_IDS) {
    assert.match(id, /^[a-z][a-z0-9_]*$/);
    const g = GESTURES[id];
    assert.ok(g.keys.body.length >= 3);
    assert.ok(g.apex > 0 && g.apex < g.duration);
    assert.deepEqual(Object.keys(g.keys).sort(), [...g.tracks].sort());
    for (const keys of Object.values(g.keys)) {
      assert.equal(keys[0][0], 0);
      for (let i = 1; i < keys.length; i++) assert.ok(keys[i][0] > keys[i - 1][0], `${id} nonmonotone clock`);
    }
    assert.ok(sampleGestureExpression(id, 0).every(x => x === 0));
    assert.ok(sampleGestureExpression(id, g.duration).every(x => x === 0));
    let peak = 0, maxStep = 0, prev = sampleGestureExpression(id, 0);
    for (let i = 1; i <= Math.ceil(g.duration * 120); i++) {
      const next = sampleGestureExpression(id, Math.min(i / 120, g.duration));
      for (let c = 0; c < next.length; c++) {
        assert.ok(Number.isFinite(next[c]) && next[c] >= 0 && next[c] <= 1);
        peak = Math.max(peak, next[c]); maxStep = Math.max(maxStep, Math.abs(next[c] - prev[c]));
      }
      prev = next;
    }
    assert.ok(peak > .2, `${id} expression is imperceptible`);
    assert.ok(maxStep < .065, `${id} expression pops: ${maxStep}`);
  }
});

test('bow, look-up, shy and surprise have distinct authored intentions rather than duplicated hand presets', () => {
  const bow = GESTURES.bow_smile, up = GESTURES.look_up, shy = GESTURES.shy, surprise = GESTURES.surprise;
  assert.ok(Math.max(...bow.keys.body.map(k => k[1].lean)) >= .3);
  assert.ok(Math.min(...up.keys.body.map(k => k[1].headPitch)) <= -.18);
  assert.ok(Math.min(...up.keys.body.map(k => k[1].lean)) < -.1);
  assert.ok(shy.keys.body.some(k => k[1].headYaw > .14 && k[1].gazeYaw < 0), 'eyes return before head');
  assert.ok(surprise.keys.body.some(k => k[1].lean < -.1));
  assert.ok(surprise.keys.body.some(k => k[1].lean > .07));
  assert.ok(sampleGestureExpression('bow_smile', 1.18)[C.smile] > .5);
  assert.ok(sampleGestureExpression('surprise', .3)[C.eyeWide] > .6);
  assert.ok(sampleGestureExpression('surprise', 2.5)[C.eyeWide] < .05);
  for (const id of GESTURE_IDS.filter(id => !['wave', 'chest', 'shrug', 'explain'].includes(id))) {
    const g = GESTURES[id];
    assert.ok(g.keys.L && g.keys.R);
    assert.notDeepEqual(g.keys.L.map(k => k[0]), g.keys.R.map(k => k[0]), `${id} arms start/settle in lockstep`);
    assert.ok(g.keys.R.some(k => k[1].curl < g.keys.R[0][1].curl), `${id} fingers never release`);
  }
});

test('interruption and replacement release from the displayed expression, and pause freezes it', () => {
  const c = new ExpressionChoreographer(); c.update(0);
  for (let i = 1; i <= 60; i++) c.update(i / 60, [{ gesture: 'laugh', age: .95, expressionWeight: 1 }]);
  const peak = Float32Array.from(c.weights);
  assert.ok(peak[C.smileEyes] > .7);
  assert.deepEqual(c.update(1.2, [{ gesture: 'laugh', age: .95, expressionWeight: 1 }], { paused: true }), peak);
  const replaced = Float32Array.from(c.update(1.2167, [{ gesture: 'surprise', age: .75, expressionWeight: 1 }]));
  assert.ok(replaced[C.smileEyes] > .5, 'replacement must retain outgoing expression initially');
  assert.ok(replaced[C.eyeWide] < .25, 'replacement must not snap to incoming expression');
  let last = replaced;
  for (let i = 1; i <= 180; i++) {
    const next = Float32Array.from(c.update(1.2167 + i / 60, []));
    assert.ok(next.every((x, j) => x <= last[j] + 1e-7), 'cleared cue release must not rebound');
    last = next;
  }
  assert.ok(c.weights.every(x => x < 1e-5));
});

test('speech retains vowel articulation and closed consonants while brows and smile remain expressive', () => {
  const base = new Float32Array(CHANNELS.length);
  base[C.a] = .23; base[C.u] = .31; base[C.mouthNarrow] = .33; base[C.smile] = .07; base[C.blink] = .9;
  const saved = Float32Array.from(base), overlay = sampleGestureExpression('laugh', .95);
  const open = blendExpressionOverlay(base, overlay, { speechActivity: .1 });
  for (const i of [...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat]) assert.equal(open[i], base[i]);
  assert.ok(open[C.smile] > base[C.smile] && open[C.smile] < .32);
  assert.ok(open[C.browSmile] > .5);
  assert.equal(open[C.blink], base[C.blink]);
  assert.ok(open[C.smileEyes] + open[C.blink] <= 1 + 1e-7);
  const closed = blendExpressionOverlay(base, overlay, { speechActivity: true, closure: 1 });
  assert.equal(closed[C.smile], base[C.smile]);
  assert.deepEqual(base, saved);
  const scratch = new Float32Array(CHANNELS.length);
  assert.equal(blendExpressionOverlay(base, overlay, { out: scratch }), scratch);
});

test('empty expression preserves a valid face and an invalid timestamp cannot poison the layer', () => {
  const base = new Float32Array(CHANNELS.length);
  base[C.blink] = .4; base[C.eyeWide] = .4; base[C.smileEyes] = .2;
  base[C.smile] = .3; base[C.browSad] = .15;
  assert.deepEqual(blendExpressionOverlay(base, new Float32Array(CHANNELS.length)), base);
  const c = new ExpressionChoreographer(); c.update(0);
  c.update(.1, [{ gesture: 'laugh', age: 1, strength: 1 }]);
  const before = Float32Array.from(c.weights);
  assert.deepEqual(c.update(NaN, []), before);
  assert.ok(c.update(.2, []).every(Number.isFinite));
});
