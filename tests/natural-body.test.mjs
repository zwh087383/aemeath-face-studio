import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMotion, poseSample, distance } from '../scripts/check-coordinated-motion.mjs';

test('continuous attention reaches eyes and head before an arm preparation envelope', () => {
  const c = makeMotion(); c.trigger('greet', 'fixed-greet', 2);
  const behavior = { body: { gazeYaw: -.10, headYaw: -.03, lean: .025 } };
  for (let i = 1; i <= 6; i++) c.update(2 + i / 60, 1 / 60, { behavior });
  assert.equal(c.snapshot().gestures[0].phase, 'prepare');
  assert.ok(c.snapshot().gaze.yaw < -.045, 'attention is not multiplied by near-zero hand envelope');
  assert.ok(c.snapshot().head.yaw < -.001);
});

test('hands keep retains chest participation with bounded posture targets and no gesture', () => {
  const c = makeMotion(), before = poseSample(c);
  for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60, { behavior: { body: { lean: .03, headRoll: -.01 } } });
  const after = poseSample(c);
  assert.equal(c.snapshot().gestures.length, 0);
  assert.equal(c.snapshot().posture, 'relaxed');
  assert.ok(c.snapshot().body.lean > .025);
  for (const side of ['L', 'R']) assert.ok(distance(before.hands[side][0], after.hands[side][0]) < .5, 'small chest carriage, no raised-hand posture');
  c.update(4.1, .1, { behavior: { body: { lean: Infinity, headYaw: NaN, gazeYaw: 999 } } });
  assert.ok(c.snapshot().gaze.targetYaw <= .3);
  for (const q of c.locals.values()) assert.ok(q.every(Number.isFinite));
});

test('full authored wave peak keeps torso amplitude and hands at equal progress', () => {
  const a = makeMotion(), b = makeMotion();
  a.inspect('wave', a.profile.gestures.wave.apex); b.inspect('wave', b.profile.gestures.wave.apex);
  for (let i = 1; i <= 120; i++) {
    a.update(2 + i / 60, 1 / 60);
    b.update(2 + i / 60, 1 / 60, { behavior: { body: { lean: .03, headPitch: .02 } } });
  }
  assert.deepEqual(b.snapshot().body, a.snapshot().body);
  for (const side of ['L', 'R']) assert.ok(distance(poseSample(a).hands[side][0], poseSample(b).hands[side][0]) < 1e-10);
});
