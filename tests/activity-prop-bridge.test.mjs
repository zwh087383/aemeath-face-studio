import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { buildFullBodyRig } from '../preview/core/full-body-ik.js';
import { sampleActivity } from '../preview/core/activity-library.js';
import { enforceActivityPropContacts, buildHeldPropBridge, sampleHeldPropBridgeFrame, applyHeldPropBridge } from '../preview/core/activity-prop-execution.js';
import { qeuler, qaxis, qmul } from '../preview/core/motion-math.js';

const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'three' ? {
  url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
const { createActivityProps } = await import('../realtime/activities/props.mjs'); hooks.deregister();
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const spin = (q, velocity, dt) => qmul(qaxis(velocity, Math.hypot(...velocity) * dt), q);
function omega(before, after, dt) {
  const delta = new THREE.Quaternion(...after).multiply(new THREE.Quaternion(...before).invert()).normalize();
  if (delta.w < 0) { delta.x *= -1; delta.y *= -1; delta.z *= -1; delta.w *= -1; }
  const sine = Math.hypot(delta.x, delta.y, delta.z), factor = sine < 1e-10 ? 2 : 2 * Math.atan2(sine, delta.w) / sine;
  return [delta.x, delta.y, delta.z].map(v => v * factor / dt);
}
const heldPose = transform => ({ props: { book: { visible: true, attachment: 'both', openness: .8, worldTransform: transform } } });

test('rigid frame rotation respects both non-collinear world angular velocities and quaternion signs including tiny turns', () => {
  const T = .83, epsilon = 1e-6, dt = 1e-5;
  for (const rotation of [[.8, -.4, .3], [1e-9, -2e-9, 3e-9], [0, 0, 0], [2.8, .2, -.1]]) for (const sign of [1, -1]) {
    const start = { position: [1, 8, 3], quaternion: qeuler(.2, -.3, .1) }, end = { position: [2, 9, 2], quaternion: qmul(qeuler(...rotation), qeuler(.2, -.3, .1)).map(v => v * sign) };
    const v0 = [.4, -.2, .1], v1 = [-.2, .1, .3], w0 = [.25, -.1, .32], w1 = [-.13, .34, .17];
    const previous = { position: start.position.map((v, i) => v - v0[i] * dt), quaternion: spin(start.quaternion, w0, -dt).map(v => v * sign) };
    const probe = { position: end.position.map((v, i) => v + v1[i] * dt), quaternion: spin(end.quaternion, w1, dt) };
    const bridge = buildHeldPropBridge(heldPose(start), heldPose(end), { previousFrom: heldPose(previous), fromDt: dt, targetProbe: heldPose(probe), targetDt: dt, duration: T }).book;
    const first = sampleHeldPropBridgeFrame(bridge, 0), second = sampleHeldPropBridgeFrame(bridge, epsilon);
    const penultimate = sampleHeldPropBridgeFrame(bridge, T - epsilon), last = sampleHeldPropBridgeFrame(bridge, T);
    for (const [actual, expected] of [[omega(first.quaternion, second.quaternion, epsilon), w0], [omega(penultimate.quaternion, last.quaternion, epsilon), w1],
      [second.position.map((v, i) => (v - first.position[i]) / epsilon), v0], [last.position.map((v, i) => (v - penultimate.position[i]) / epsilon), v1]])
      assert.ok(distance(actual, expected) < 1e-5, `${rotation}/${sign}: ${actual} vs ${expected}`);
    assert.deepEqual(first.position, start.position); assert.ok(distance(last.position, end.position) < 1e-10);
    assert.ok(new THREE.Quaternion(...last.quaternion).angleTo(new THREE.Quaternion(...end.quaternion)) < 1e-6);
  }
});

test('page-turn hand ownership preserves the supporting hand and does not recapture a released table prop', () => {
  const rig = buildFullBodyRig(skeleton), from = sampleActivity('page_turn_seated', 2.7, rig.context), target = sampleActivity('read_seated', 0, rig.context);
  enforceActivityPropContacts(rig, from); enforceActivityPropContacts(rig, target);
  assert.equal(from.props.book.attachment, 'left');
  const frames = buildHeldPropBridge(from, target), out = structuredClone(from), freeHand = structuredClone(out.hands.R);
  assert.equal(frames.book.attachmentDuring, 'left');
  const result = applyHeldPropBridge(rig, out, frames, .21, .42);
  assert.equal(result.ready, true); assert.deepEqual(out.hands.R, freeHand, 'page-turn right hand is not snapped to a grip early');
  assert.equal(out.props.book.attachment, 'left');
  applyHeldPropBridge(rig, out, frames, .42, .42); assert.equal(out.props.book.attachment, 'both');
  const released = structuredClone(target); released.props.book.attachment = 'table';
  assert.deepEqual(buildHeldPropBridge(from, released), {}, 'a legitimate table release must not restore hand ownership');
});

function realRun() {
  const body = new FullBodyController({ skeleton }), props = createActivityProps(new THREE.Scene()); let now = 0;
  props.update({ table: true, book: { visible: true, attachment: 'table', openness: .8 } }, { anchor: body.anchor, time: 0 });
  body.setRenderedPropsSnapshot(props.snapshot());
  return { body, props, step(dt = 1 / 60) {
    now += dt; body.update(now, dt); const hands = body.handAnchors();
    props.update(body.pose.props, { anchors: { leftHand: hands.L, rightHand: hands.R }, anchor: body.pose.anchor ?? body.anchor,
      root: body.root, pose: body.pose, snapshot: body.snapshot(), time: now });
    body.setRenderedPropsSnapshot(props.snapshot()); body.setPropTransferReceipts(props.snapshot()); return props.snapshot().props.book;
  }, until(predicate, maximum = 4000, dt = 1 / 60) {
    for (let i = 0; i < maximum; i++) { const state = this.step(dt); if (predicate(state)) return state; }
    throw Error(`actual activity did not reach condition: ${body.activeId}/${body.status}`);
  } };
}

for (const next of ['turn_left', 'sit_talk', 'walk_forward']) test(`reading -> ${next} keeps both actual PMX palms on a fixed book throughout every bridge and clip`, () => {
  const run = realRun(); run.body.play('read_seated'); run.until(() => run.body.done);
  if (next === 'sit_talk') {
    const before = run.body.snapshot(), beforeProps = run.props.snapshot();
    assert.equal(run.body.play(next), false, 'the named right-hand gesture needs a free hand; holding a book is not permission to erase it');
    assert.deepEqual(run.body.snapshot(), before); assert.deepEqual(run.props.snapshot(), beforeProps); run.props.dispose(); return;
  }
  assert.equal(run.body.play(next), true); let frames = 0, maximumGripError = 0, maximumBodyLean = 0, last, maximumObjectStep = 0;
  do {
    const state = run.step(); assert.equal(state.visible, true); assert.deepEqual(state.scale, [1, 1, 1]);
    maximumGripError = Math.max(maximumGripError, state.gripError ?? 0); maximumBodyLean = Math.max(maximumBodyLean, Math.abs(run.body.pose.body.lean ?? 0));
    assert.ok((state.gripError ?? 0) < .025, `${next}/${frames}: ${state.gripError}`);
    if (last) maximumObjectStep = Math.max(maximumObjectStep, distance(last.position, state.position));
    last = state; frames++; assert.ok(frames < 4000);
  } while (!run.body.done);
  assert.ok(frames > 200); assert.ok(maximumObjectStep < .2, `${next}: visible object jump ${maximumObjectStep}`);
  console.log(JSON.stringify({ acceptance: 'actual-pmx-held-prop-cross-activity', next, frames, maximumGripError, maximumObjectStep, maximumBodyLean }));
  run.props.dispose();
});

test('a moving held book cancels from its measured world linear and angular velocity without slipping or changing size', () => {
  const run = realRun(); run.body.play('read_seated'); run.until(() => run.body.done);
  run.body.play('turn_left'); run.until(() => run.body.activeId === 'turn_left' && !run.body.bridge && run.body.elapsed >= 1.137, 8000, 1 / 240);
  const previous = run.step(1 / 240), before = run.step(1 / 240);
  const velocityBefore = before.position.map((v, i) => (v - previous.position[i]) * 240), omegaBefore = omega(previous.quaternion, before.quaternion, 1 / 240);
  assert.ok(Math.hypot(...velocityBefore) > .1 || Math.hypot(...omegaBefore) > .1, 'must probe actual motion, not a zero-speed key');
  const poseBefore = structuredClone(run.body.pose); run.body.stop(); assert.deepEqual(run.body.pose, poseBefore, 'stop command itself is C0');
  const after = run.step(1e-6), velocityAfter = after.position.map((v, i) => (v - before.position[i]) / 1e-6), omegaAfter = omega(before.quaternion, after.quaternion, 1e-6);
  assert.ok(distance(velocityBefore, velocityAfter) < .003, `${velocityBefore} vs ${velocityAfter}`);
  assert.ok(distance(omegaBefore, omegaAfter) < .003, `${omegaBefore} vs ${omegaAfter}`);
  run.until(state => {
    assert.ok((state.gripError ?? 0) < .025); assert.deepEqual(state.scale, [1, 1, 1]); return run.body.done;
  });
  console.log(JSON.stringify({ acceptance: 'actual-held-book-cancel-c1', velocityBefore, velocityAfter, omegaBefore, omegaAfter }));
  run.props.dispose();
});
