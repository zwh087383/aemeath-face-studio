import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PreparedFaceController } from '../preview/core/prepared-face-controller.js';
const fixture = () => new PreparedFaceController({ morphCount: 30, mouthIndices: [4, 5], recipes: [
  { id: 'look', values: { eye: .8, lip: .9 }, mapping: [{ source: 'eye', leaves: [{ index: 2, ratio: 1 }] }, { source: 'lip', leaves: [{ index: 4, ratio: 1 }] }] },
  { id: 'signed', values: { signed: -.7 }, mapping: [{ source: 'signed', leaves: [{ index: 3, ratio: 1 }] }] },
  { id: 'unknown', mapping: [] },
  { id: 'natural', kind: 'authored-expression', values: {}, mapping: [] },
] });
const run = (c, seconds, opts = {}) => { const start = c.wall ?? 0; if (c.wall === null) c.update(0, opts); for (let i = 1; i <= Math.round(seconds * 120); i++) c.update(start + i / 120, opts); };
test('cancelling preserves instantaneous nonzero expression velocity and returns to current base', () => {
  const c = fixture(); c.setBase({ 2: .2 }, 0); c.start('look', { source: 'test', generation: 1 }); run(c, .18);
  const before = c.snapshot(); assert.ok(before.velocity[2] > .05);
  assert.equal(c.cancel({ source: 'test', generation: 1 }), true);
  c.update(c.wall); assert.equal(c.snapshot().expressionWeights[2], before.expressionWeights[2]); assert.equal(c.snapshot().velocity[2], before.velocity[2]);
  c.update(c.wall + 1e-7); assert.ok(Math.abs((c.weights[2] - before.expressionWeights[2]) / 1e-7 - before.velocity[2]) < 1e-3);
  c.setBase({ 2: .37 }, 1); run(c, 2); assert.ok(Math.abs(c.weights[2] - .37) < 1e-10);
});
test('speech exclusively owns actual mouth leaves even across pause and zero lip packets', () => {
  const c = fixture(); c.setBase({ 4: .6 }, 0); c.start('look', { source: 'test', generation: 0 }); run(c, .8);
  assert.ok(c.weights[4] > .5);
  assert.equal(c.update(c.wall + .01, { speaking: true, lipWeights: { 4: .21, 5: .13 } })[4], .21);
  const paused = c.snapshot(); c.update(c.wall + 1, { paused: true, speaking: true });
  assert.equal(c.output[4], 0); assert.deepEqual(c.snapshot().expressionWeights, paused.expressionWeights);
  assert.equal(c.now, paused.time);
});
test('old base, repeated generations and foreign cancellations cannot replace a new expression', () => {
  const c = fixture(); assert.equal(c.setBase({ 2: .3 }, 3), true); assert.equal(c.setBase({ 2: 1 }, 2), false);
  c.start('look', { source: 'test', generation: 2 }); run(c, .2);
  assert.equal(c.start('signed', { source: 'test', generation: 1 }), false);
  assert.equal(c.cancel({ source: 'other', generation: 2 }), false);
  assert.equal(c.start('signed', { source: 'test', generation: 3 }), true); run(c, .8); assert.ok(c.weights[3] < -.6);
});
test('unmapped resources remain unavailable and a neutral authored recipe is a valid base-preserving expression', () => {
  const c = fixture(); assert.equal(c.start('unknown', { source: 'test', generation: 1 }), false);
  assert.equal(c.start('natural', { source: 'test', generation: 2 }), true);
  assert.throws(() => c.setBase({ 2: Infinity }, 0)); assert.throws(() => c.update(-1));
  c.update(2.13); c.update(2.13 - Number.EPSILON); assert.equal(c.wall, 2.13); assert.throws(() => c.update(2));
});
test('zero-time render and pause preserve signed tiny weights bit for bit', () => {
  const c = fixture(); c.update(0); c.weights[2] = -.000000123456789; c.velocity[2] = .0712345;
  const expected = Array.from(c.weights), velocity = Array.from(c.velocity);
  c.update(0); assert.deepEqual(Array.from(c.weights), expected); assert.deepEqual(Array.from(c.velocity), velocity);
  c.update(1, { paused: true }); assert.deepEqual(Array.from(c.weights), expected); assert.deepEqual(Array.from(c.velocity), velocity);
});
test('one response owner can stream distinct cues, while duplicates and late cancelled cues cannot revive it', () => {
  const c = fixture(), owner = { source: 'response', generation: 4 };
  assert.equal(c.start('look', owner, { cueId: 'first' }), true); run(c, .2);
  const before = c.snapshot(); assert.equal(c.start('signed', owner, { cueId: 'second' }), true);
  assert.deepEqual(c.snapshot().expressionWeights, before.expressionWeights); assert.deepEqual(c.snapshot().velocity, before.velocity);
  assert.equal(c.start('look', owner, { cueId: 'first' }), false);
  assert.equal(c.cancel(owner), true); assert.equal(c.start('look', owner, { cueId: 'late-third' }), false);
  assert.equal(c.start('look', { ...owner, generation: 5 }, { cueId: 'first' }), true);
  run(c, 3); assert.equal(c.active, null); assert.equal(c.retire({ ...owner, generation: 5 }), true);
  assert.equal(c.start('look', { ...owner, generation: 5 }, { cueId: 'late-after-end' }), false);
});
test('default native playback includes the full original curve duration before release', () => {
  const c = new PreparedFaceController({ morphCount: 2, recipes: [{ id: 'long', mapping: [{ source: 'curve', leaves: [{ index: 0, ratio: 1 }] }],
    nativeData: { duration: 4, curves: [{ name: 'curve', keys: [{ time: 0, value: 0 }, { time: 3.8, value: .2 }, { time: 4, value: .9 }] }] } }] });
  c.start('long', { source: 'test', generation: 1 }); run(c, 4.3);
  assert.equal(c.snapshot().active.hold, 4); assert.ok(c.weights[0] > .4, 'the final native rise is actually reached');
  run(c, 1); assert.equal(c.snapshot().active, null);
});
test('all current real PMX recipes are finite, recover after three cancellation phases and isolate every speech leaf', { skip: !fs.existsSync('outputs/action-execution-preparation-20261023/face-playback.json') }, () => {
  const data = JSON.parse(fs.readFileSync('outputs/action-execution-preparation-20261023/face-playback.json'));
  let measured = 0;
  for (const recipe of data.recipes) {
    if (!recipe.mapping.some(m => m.leaves.length) && !(recipe.kind === 'authored-expression' && Object.keys(recipe.values).length === 0)) continue;
    for (const cancelAt of [.13, .8, 1.72]) {
      const c = new PreparedFaceController({ recipes: data.recipes, morphCount: data.model.morphCount, mouthIndices: data.mouthIndices });
      const owner = { source: 'all-real-recipes', generation: 1 };
      c.setBase({ 14: .12 }, 1); assert.equal(c.start(recipe.id, owner), true); run(c, cancelAt, { speaking: true, lipWeights: { 52: .26, 53: .12 } });
      for (const index of data.mouthIndices) assert.equal(c.output[index], index === 52 ? .26 : index === 53 ? .12 : 0);
      assert.equal(c.cancel(owner), true); run(c, 2, { speaking: true });
      assert.ok(c.output.every(Number.isFinite)); assert.ok(Math.abs(c.output[14] - .12) < 1e-8); measured++;
    }
  }
  assert.ok(measured > 200);
});
