import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MotionController } from '../preview/core/motion-controller.js';
import { AEMEATH_MOTION_BINDING, GESTURES } from '../preview/core/motion-profile.js';
import { buildRig, forwardKinematics, handRelative, skeletonFromInspection, solveArm } from '../preview/core/motion-skeleton.js';
import { qconj, qid, qrotate, sub } from '../preview/core/motion-math.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url))));
function measure(c, side) {
  const fk = forwardKinematics(c.rig, c.locals), chest = fk.get(c.rig.torso.upperChest.name), n = c.rig.sides[side].names;
  const local = name => qrotate(qconj(chest.rotation), sub(fk.get(name).position, chest.position));
  const shoulder = local(n.arm), elbow = local(n.elbow), wrist = local(n.wrist);
  return { lateral: (elbow[0] - shoulder[0]) * c.rig.sides[side].sign, shoulder, elbow, wrist };
}
function make() {
  const c = new MotionController({ skeleton }); c.setOptions({ natural: false });
  for (let i = 1; i <= 120; i++) c.update(i / 60, 1 / 60);
  return c;
}

test('ordinary expressive gestures no longer hold the upper arm far out from the rib cage', () => {
  // PMX geometry at 63199b1 measured 1.65/1.80/1.76/1.78/1.74 units respectively.
  // Check the complete moving performance, not only a favourable authored key.
  for (const [id, side, bound] of [['explain', 'L', 1.40], ['shy', 'R', 1.50], ['think', 'R', 1.50],
    ['comfort', 'L', 1.50], ['explain_firm', 'L', 1.50]]) {
    const c = make(); c.trigger(id, `elbow-${id}`, 2);
    let maximum = 0;
    for (let i = 1; i <= 600; i++) {
      c.update(2 + i / 60, 1 / 60);
      maximum = Math.max(maximum, measure(c, side).lateral);
    }
    assert.ok(maximum < bound, `${id}/${side}: ${maximum.toFixed(3)} lateral units`);
  }
});

test('raising a hand restores elbow space instead of pinning the humerus to the torso', () => {
  for (const id of ['wave', 'greet']) {
    const c = make(); c.inspect(id, GESTURES[id].apex);
    for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
    const pose = measure(c, 'R');
    assert.ok(pose.wrist[1] - pose.shoulder[1] > 1, `${id} hand stays raised`);
    assert.ok(pose.lateral > 1.8, `${id} elbow has overhead clearance`);
  }
});

test('anatomical elbow preference remains symmetric and preserves the authored wrist reach', () => {
  const rig = buildRig(skeleton, AEMEATH_MOTION_BINDING), locals = new Map(), poses = {};
  for (const side of ['L', 'R']) {
    const sign = rig.sides[side].sign, mirror = v => [v[0] * sign, v[1], v[2]];
    const pose = { hand: mirror([2.5, 13.8, 2.2]), pole: mirror([.5, -.6, -1]),
      palm: mirror([-.05, 1, .25]), point: mirror([.58, .12, 1]), curl: .2, thumb: .1, spread: .2 };
    Object.assign(pose, handRelative(rig, side, pose));
    solveArm(rig, side, pose, qid(), rig.torso.upperChest.rest, locals);
    poses[side] = pose;
  }
  const fk = forwardKinematics(rig, locals), lateral = {};
  for (const side of ['L', 'R']) {
    const s = rig.sides[side], wrist = fk.get(s.names.wrist).position, elbow = fk.get(s.names.elbow).position;
    // The PMX's non-collinear helper offsets leave a small existing FK residual.
    assert.ok(Math.hypot(...sub(wrist, poses[side].hand)) < .06, `${side} wrist reaches its authored location`);
    lateral[side] = (elbow[0] - fk.get(s.names.arm).position[0]) * s.sign;
  }
  assert.ok(Math.abs(lateral.L - lateral.R) < .02, 'the same pose must not bias one elbow outward');
});
