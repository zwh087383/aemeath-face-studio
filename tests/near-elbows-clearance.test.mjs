import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { MotionRig } from '../preview/studio/motion-rig.js';
import { forwardKinematics } from '../preview/core/motion-skeleton.js';
import { qconj, qrotate, sub } from '../preview/core/motion-math.js';
import { GESTURES } from '../preview/core/motion-profile.js';
import { makeMotion, skinCoordinated } from '../scripts/check-coordinated-motion.mjs';
import { loadModel, check } from '../scripts/check-motion-clearance.mjs';

const localArm = (c, side) => {
  const fk = forwardKinematics(c.rig, c.locals), s = c.rig.sides[side];
  const inverse = qconj(fk.get(c.rig.torso.upperChest.name).rotation);
  const at = name => qrotate(inverse, sub(fk.get(name).position, fk.get(s.names.arm).position));
  return { lateral: at(s.names.elbow)[0] * s.sign, elbow: at(s.names.elbow), wrist: at(s.names.wrist) };
};

test('ordinary elbows are measurably nearer than the previous 26-29 degree poses', () => {
  for (const [id, side, bound] of [['explain', 'L', .98], ['shy', 'R', .92], ['think', 'R', .93],
    ['comfort', 'L', .94], ['explain_firm', 'R', 1.10]]) {
    const c = makeMotion(); c.trigger(id, `near-${id}`, 2);
    let max = 0;
    for (let i = 1; i <= 600; i++) { c.update(2 + i / 60, 1 / 60); max = Math.max(max, localArm(c, side).lateral); }
    assert.ok(max < bound, `${id}: elbow lateral ${max}, bound ${bound}`);
  }
});

test('raised greetings fold forward with a close elbow and retain a clearly raised hand', () => {
  for (const id of ['wave', 'greet']) {
    const c = makeMotion(); c.inspect(id, GESTURES[id].apex);
    for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
    const p = localArm(c, 'R');
    assert.ok(p.lateral < 1.8, `${id}: close frontal silhouette ${p.lateral}`);
    assert.ok(p.elbow[2] > 1.4, `${id}: upper arm flexes forward`);
    assert.ok(p.wrist[1] > 1, `${id}: hand remains visibly above the shoulder`);
  }
});

test('cloth correction stays on actual sleeve roots and the renderer consumes the numerical locals unchanged', () => {
  const c = makeMotion(); c.inspect('wave', .28);
  for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
  const names = Object.values(c.rig.sides).flatMap(s => s.sleeves.map(b => b.name));
  assert.equal(names.length, 5); // Aemeath has one long left sleeve and a bare right forearm.
  assert.ok(names.every(name => name.startsWith('左袖子_0_')));
  const bones = names.map(name => { const b = new THREE.Bone(); b.name = name; b.position.set(...c.rig.pos(name)); return b; });
  const renderer = new MotionRig({ skeleton: { bones } });
  const before = bones.map(b => b.position.toArray());
  renderer.apply(c.locals); renderer.apply(c.locals);
  for (let i = 0; i < names.length; i++) {
    const q = c.locals.get(names[i]);
    assert.deepEqual(bones[i].quaternion.toArray(), q, 'no hidden renderer-only cloth transform or accumulated rotation');
    assert.deepEqual(bones[i].position.toArray(), before[i], 'cloth attachment stays fixed');
    const angle = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
    assert.ok(angle > .01 && angle <= .65 + 1e-8, `bounded real cloth rotation: ${angle}`);
    assert.equal(c.locals.translations.has(names[i]), false);
  }
  const fk = forwardKinematics(c.rig, c.locals), noCloth = new Map(c.locals);
  for (const name of names) noCloth.delete(name);
  noCloth.translations = c.locals.translations;
  const without = forwardKinematics(c.rig, noCloth);
  for (const s of Object.values(c.rig.sides)) for (const name of [s.names.arm, s.names.elbow, s.names.wrist]) {
    assert.deepEqual(fk.get(name), without.get(name), 'cloth clearance cannot be bought by moving the arm');
  }
});

test('previous sleeve/braid and new ribbon-sensitive recovery poses have zero sleeve or hand penetration signals', async () => {
  const model = await loadModel();
  for (const [id, ages] of [['wave', [.28, 1.6, 1.75, 1.9, 2.1, 2.5]], ['greet', [.28, 1.8, 2.2, 2.35, 2.5]]]) {
    for (const age of ages) {
      const c = makeMotion(); c.inspect(id, age);
      for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
      const mesh = check(model, skinCoordinated(model, c.locals));
      assert.equal(mesh.sleeve, 0, `${id}@${age}: ${JSON.stringify(mesh)}`);
      assert.equal(mesh.hand, 0, `${id}@${age}: hand clearance`);
    }
  }
});


test('cloth freezes with paused audio and returns smoothly after cancellation without persistent offsets', () => {
  const c = makeMotion(); c.setPosture('auto', 2); c.begin(1);
  assert.ok(c.enqueue({ id: 'cloth-pause', kind: 'gesture', gesture: 'wave', epoch: 1, at: 0 }));
  for (let i = 1; i <= 90; i++) { c.playback(1, 'playing', i / 60); c.update(2 + i / 60, 1 / 60); }
  c.playback(1, 'paused', 1.5); c.update(3.5 + 1 / 60, 1 / 60);
  const names = c.rig.sides.L.sleeves.map(s => s.name), frozen = names.map(n => [...c.locals.get(n)]);
  for (let i = 2; i <= 62; i++) c.update(3.5 + i / 60, 1 / 60);
  names.forEach((n, i) => assert.deepEqual(c.locals.get(n), frozen[i], `${n} pauses with the arm`));
  const now = c.now; assert.ok(c.cancel(1, now));
  let previous = frozen, moved = false;
  for (let i = 1; i <= 240; i++) {
    c.update(now + i / 60, 1 / 60);
    const current = names.map(n => [...c.locals.get(n)]);
    current.forEach((q, j) => {
      const angle = 2 * Math.acos(Math.min(1, Math.abs(q.reduce((v, x, k) => v + x * previous[j][k], 0))));
      assert.ok(angle < .12, `${names[j]} cancellation has no abrupt cloth rotation: ${angle}`);
      moved ||= angle > .0001;
    });
    previous = current;
  }
  assert.ok(moved, 'cancel must actually let the sleeve recover');
  const home = makeMotion('listening');
  names.forEach(n => assert.ok(c.locals.get(n).every((x, i) => Math.abs(x - home.locals.get(n)[i]) < .001), `${n} settles to the normal drape`));
});
