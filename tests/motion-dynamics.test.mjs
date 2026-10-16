import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MotionController } from '../preview/core/motion-controller.js';
import { AEMEATH_MOTION_BINDING } from '../preview/core/motion-profile.js';
import { buildRig, forwardKinematics, skeletonFromInspection, solveSupport } from '../preview/core/motion-skeleton.js';
import { qangle, qconj, qeuler, qrotate, sub } from '../preview/core/motion-math.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url))));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const make = () => { const c = new MotionController({ skeleton }); c.setOptions({ natural: false }); return c; };
const run = (c, from, to) => { for (let t = from + 1 / 120; t <= to + 1e-8; t += 1 / 120) c.update(t, 1 / 120); };

test('pelvis motion keeps both ankles and soles planted in the real PMX hierarchy', () => {
  const rig = buildRig(skeleton, AEMEATH_MOTION_BINDING);
  for (const [pitch, roll, shift, forward] of [[0, 0, 0, 0], [.08, .06, .22, -.22], [-.10, -.10, -.28, -.32]]) {
    const locals = new Map([['下半身', qeuler(pitch, 0, roll)]]);
    locals.translations = new Map([['腰', [shift, -Math.abs(roll) * 1.15 - Math.abs(pitch) * .45 - shift * shift * .22, forward]]]);
    const fk = solveSupport(rig, locals);
    for (const leg of Object.values(rig.legs)) {
      assert.ok(distance(fk.get(leg.names.ankle).position, skeleton.get(leg.names.ankle).position) < 1e-7);
      assert.ok(distance(fk.get(leg.names.toe).position, skeleton.get(leg.names.toe).position) < 1e-7);
      assert.ok(qangle(fk.get(leg.names.ankle).rotation) < 1e-7);
    }
  }
});

test('support at neutral preserves the bind pose instead of introducing a knee or foot pop', () => {
  const rig = buildRig(skeleton, AEMEATH_MOTION_BINDING), locals = new Map();
  solveSupport(rig, locals);
  for (const q of locals.values()) assert.ok(qangle(q) < 1e-6);
});

test('eyes start toward a new subject before the head and chest catch up', () => {
  const c = make(); c.update(0, 0);
  const body = new Float64Array(c.work.body.length); body[3] = -.15; body[4] = .25;
  c.compose(1 / 60, 1 / 60, c.work.arm, body);
  assert.ok(c.head.eyesYaw > c.head.yaw, 'eye rotation should visibly lead the head');
  assert.ok(c.head.eyesPitch < c.head.pitch, 'upward gaze should lead upward head motion');
  assert.ok(Math.abs(c.springs.chestYaw.x) < Math.abs(c.head.yaw));
});

test('torso springs carry velocity through a reversal and through interruption', () => {
  const c = make();
  c.setPosture('listening', 0); run(c, 0, .5);
  const before = c.snapshot().bodyVelocity.lean;
  assert.ok(Math.abs(before) > .005);
  c.setPosture('relaxed', .5);
  c.update(.5, 0);
  assert.equal(c.snapshot().bodyVelocity.lean, before, 'a pose switch must not reset momentum');
  c.update(.5 + 1 / 120, 1 / 120);
  assert.ok(Math.abs(c.snapshot().bodyVelocity.lean - before) < .02);
});

test('audio pause freezes gaze and body inertia and resumes from exactly that state', () => {
  const c = make(); c.begin(1);
  c.update(.1, .1, { face: { pitch: -.15, yaw: .25, roll: .1 } });
  c.playback(1, 'paused', .1);
  const before = new Map([...c.locals].map(([name, q]) => [name, q.slice()]));
  const unchanged = () => { for (const [name, q] of c.locals) assert.ok(Math.hypot(...q.map((x, i) => x - before.get(name)[i])) < 1e-12, name); };
  run(c, .1, 1.1);
  unchanged();
  c.playback(1, 'playing', .1);
  c.update(1.1, 0);
  unchanged();
});

test('large torso lean carries wrists in chest space while the head joins the bow', () => {
  const c = make(), body = new Float64Array(c.profile.postures.relaxed.body.length);
  c.compose(0, 0, c.work.arm, body);
  const chestSpaceWrists = () => {
    const fk = forwardKinematics(c.rig, c.locals), chest = fk.get(c.rig.torso.upperChest.name);
    return ['L', 'R'].map(side => qrotate(qconj(chest.rotation), sub(fk.get(c.rig.sides[side].names.wrist).position, chest.position)));
  };
  const neutralHands = chestSpaceWrists();
  body[0] = .34;
  const arms = c.work.arm;
  for (let i = 0; i < 300; i++) c.compose(i / 120, 1 / 120, arms, body);
  const fk = forwardKinematics(c.rig, c.locals);
  const spineForward = qrotate(fk.get(c.rig.torso.upperChest.name).rotation, [0, 0, 1]);
  const headForward = qrotate(fk.get(c.rig.torso.head.name).rotation, [0, 0, 1]);
  assert.ok(spineForward[1] < -.30, 'the torso itself must visibly bow');
  assert.ok(headForward[1] < -.15, 'the head should participate instead of fully cancelling the torso');
  chestSpaceWrists().forEach((hand, i) => assert.ok(distance(hand, neutralHands[i]) < 1e-6));
  assert.ok(c.snapshot().support.error < 1e-6);
});
