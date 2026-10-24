import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { buildFullBodyRig, solveFullBodyPose } from '../preview/core/full-body-ik.js';
import { sampleActivity, ACTIVITY_LIBRARY } from '../preview/core/activity-library.js';
import { enforceActivityPropContacts, measuredPropHand, PROP_TRANSFER_TIMING, buildHeldPropBridge, sampleHeldPropBridgeFrame } from '../preview/core/activity-prop-execution.js';
import { propGripPair } from '../preview/core/activity-prop-layout.js';
import { qeuler, qaxis, qmul } from '../preview/core/motion-math.js';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createActivityProps } = await import('../realtime/activities/props.mjs'); hooks.deregister();
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const rig = buildFullBodyRig(skeleton), locals = new Map(), fk = new Map();
const origin = { position: [0, 0, 0], yaw: 0 };
function displayPose(pose, context = {}) {
  pose.anchor ??= structuredClone(origin);
  const contacts = enforceActivityPropContacts(rig, pose);
  const diagnostics = solveFullBodyPose(rig, pose, locals, fk);
  const anchors = Object.fromEntries(['L', 'R'].map(side => [`${side === 'L' ? 'left' : 'right'}Hand`, measuredPropHand(rig, pose, fk, side)]));
  return { contacts, diagnostics, avatar: { anchors, anchor: pose.anchor, root: pose.root, pose, ...context } };
}
const sample = (id, t, context = {}) => sampleActivity(id, t, { ...rig.context, ...context });

test('all real-model book recipes retain fixed geometry and measured support through closing and one-hand page turning', () => {
  const props = createActivityProps(new THREE.Scene()); let frames = 0, maximumError = 0;
  for (const id of ['read_standing', 'read_seated', 'page_turn_standing', 'page_turn_seated', 'read_look_up', 'close_book', 'study_at_desk']) {
    for (let t = 0; t <= ACTIVITY_LIBRARY[id].duration; t += 1 / 30) {
      const pose = sample(id, t), result = displayPose(pose); props.update(pose.props, result.avatar);
      const report = props.snapshot().props.book;
      assert.equal(report.visible, true, `${id}/${t}`); assert.deepEqual(report.scale, [1, 1, 1]);
      assert.equal(result.contacts.ready, true, `${id}/${t}: ${JSON.stringify(result.contacts)}`);
      maximumError = Math.max(maximumError, result.contacts.props.book.maximumGripError);
      if (report.attachment === 'both') assert.ok(report.gripError < .025, `${id}/${t}: ${report.gripError}`);
      assert.equal(result.diagnostics.finite, true); frames++;
    }
  }
  assert.ok(frames > 1300); assert.ok(maximumError < .025); props.dispose();
});

for (const [id, source] of [['put_book_standing', 'read_standing'], ['put_book_seated', 'close_book'],
  ['put_mug_standing', 'drink_standing'], ['put_mug_seated', 'drink_seated'], ['put_pencil_seated', 'write_at_desk']]) {
  test(`${id}: real PMX palms carry a fixed prop continuously to actual tabletop contact before release`, () => {
    const props = createActivityProps(new THREE.Scene());
    const previous = sample(source, ACTIVITY_LIBRARY[source].duration); displayPose(previous);
    const context = { initialPose: structuredClone(previous), initialProps: { ...structuredClone(previous.props), table: true }, activityAnchor: origin };
    const propId = ACTIVITY_LIBRARY[id].propId; let releasedAt = null, releases = 0, maxGripError = 0, maxStep = 0, lastPosition;
    for (let t = 0; t <= ACTIVITY_LIBRARY[id].duration + .3; t += 1 / 60) {
      const pose = sample(id, Math.min(t, ACTIVITY_LIBRARY[id].duration), context), result = displayPose(pose, { time: t, snapshot: { revision: 1, activeId: id } });
      props.update(pose.props, result.avatar);
      const report = props.snapshot().props[propId];
      assert.equal(report.visible, true, `${id}/${t}`); assert.deepEqual(report.scale, [1, 1, 1]);
      assert.equal(result.diagnostics.finite, true);
      if (result.contacts.props[propId]) {
        maxGripError = Math.max(maxGripError, result.contacts.props[propId].maximumGripError);
        assert.ok(result.contacts.props[propId].ready, `${id}/${t}: ${JSON.stringify(result.contacts.props[propId])}`);
      }
      if (lastPosition) maxStep = Math.max(maxStep, Math.hypot(...report.position.map((value, i) => value - lastPosition[i])));
      lastPosition = report.position;
      if (report.transfer?.released) {
        if (releasedAt === null) { releasedAt = t; releases++; }
        assert.ok(report.transfer.heightError <= .045); assert.ok(report.transfer.relativeSpeed <= .32);
        assert.ok(report.transfer.angleError <= .09); assert.ok(report.transfer.positionError <= .09);
        assert.equal(report.transfer.footprint, true); assert.equal(report.attachment, 'table');
        context.propTransferReceipts = { [propId]: report.transfer };
      }
    }
    assert.equal(releases, 1, `${id}: no real release ${JSON.stringify(props.snapshot().props[propId])}`);
    assert.ok(releasedAt >= PROP_TRANSFER_TIMING.releaseAt); assert.ok(maxGripError < .025, `${id}: ${maxGripError}`);
    assert.ok(maxStep < .15, `${id}: prop jumped ${maxStep}`);
    const final = props.snapshot().props[propId].position;
    props.update({}, { anchor: { position: [13, 0, 9], yaw: 1 } });
    assert.deepEqual(props.snapshot().props[propId].position, final, 'placed prop remains in original world frame after walking away');
    props.dispose();
  });
}

test('missing table or absent held prop cannot become a successful timed placement', () => {
  const previous = sample('read_seated', 6); displayPose(previous);
  for (const initialProps of [previous.props, { table: true }]) {
    const pose = sample('put_book_seated', 4.8, { initialPose: previous, initialProps });
    assert.ok(pose.phase.startsWith('place-blocked-'));
    assert.notEqual(pose.props.book?.transfer?.requestRelease, true);
    assert.equal(pose.props.table === true && !initialProps.table, false, 'put operation cannot invent a table');
  }
});

test('wrong grip spacing is reported without scaling or hiding the book', () => {
  const props = createActivityProps(new THREE.Scene());
  props.update({ book: { visible: true, attachment: 'both', openness: .8 } }, { anchors: { leftHand: [5, 10, 3], rightHand: [-5, 10, 3] } });
  const result = props.snapshot().props.book; assert.equal(result.visible, true); assert.ok(result.gripError > 3); assert.deepEqual(result.scale, [1, 1, 1]);
  props.dispose();
});

test('a still pose cannot release without measured velocity; a vanished or unreachable surface prevents ownership change', () => {
  for (const scenario of ['no-time', 'no-table', 'outside']) {
    const props = createActivityProps(new THREE.Scene()), openness = 1, grips = propGripPair('book', openness);
    const target = { position: scenario === 'outside' ? [20, 9.08, 3.7] : [0, 9.08, 3.7], quaternion: [0, 0, 0, 1], space: 'world' };
    const anchors = Object.fromEntries([['leftHand', grips.left], ['rightHand', grips.right]].map(([side, grip]) => [side, { position: grip.map((v, i) => v + target.position[i]), quaternion: [0, 0, 0, 1] }]));
    const config = { table: scenario !== 'no-table', book: { visible: true, attachment: 'both', openness, gripReady: true,
      transfer: { operation: 'place', to: 'table', target, requestRelease: true } } };
    for (let frame = 0; frame < 50; frame++) props.update(config, { anchors, time: scenario === 'no-time' ? undefined : frame / 60 });
    assert.equal(props.snapshot().props.book.transfer.released, false, scenario); props.dispose();
  }
});

test('rigid prop bridge preserves actual nonzero world linear and non-collinear angular boundary velocities', () => {
  const duration = .83, dt = .00001, epsilon = 1e-6;
  const start = { position: [1, 8, 3], quaternion: qeuler(.2, -.4, .1) }, end = { position: [2, 9, 2], quaternion: qeuler(-.7, .8, .3) };
  const v0 = [.4, -.2, .1], v1 = [-.2, .1, .3], w0 = [.25, -.1, .32], w1 = [-.13, .34, .17];
  const spin = (q, velocity, seconds) => qmul(qaxis(velocity, Math.hypot(...velocity) * seconds), q);
  const pose = transform => ({ props: { book: { visible: true, attachment: 'both', openness: .8, worldTransform: transform } } });
  const previous = { position: start.position.map((v, i) => v - v0[i] * dt), quaternion: spin(start.quaternion, w0, -dt) };
  const probe = { position: end.position.map((v, i) => v + v1[i] * dt), quaternion: spin(end.quaternion, w1, dt).map(v => -v) };
  const frame = buildHeldPropBridge(pose(start), pose(end), { previousFrom: pose(previous), fromDt: dt, targetProbe: pose(probe), targetDt: dt, duration }).book;
  const atStart = sampleHeldPropBridgeFrame(frame, 0), afterStart = sampleHeldPropBridgeFrame(frame, epsilon);
  const beforeEnd = sampleHeldPropBridgeFrame(frame, duration - epsilon), atEnd = sampleHeldPropBridgeFrame(frame, duration);
  const velocity = (a, b) => b.map((value, index) => (value - a[index]) / epsilon);
  const omega = (a, b) => {
    const delta = new THREE.Quaternion(...b).multiply(new THREE.Quaternion(...a).invert()).normalize();
    if (delta.w < 0) { delta.x *= -1; delta.y *= -1; delta.z *= -1; delta.w *= -1; }
    return [delta.x, delta.y, delta.z].map(v => 2 * v / epsilon);
  };
  for (const [actual, expected] of [[velocity(atStart.position, afterStart.position), v0], [velocity(beforeEnd.position, atEnd.position), v1],
    [omega(atStart.quaternion, afterStart.quaternion), w0], [omega(beforeEnd.quaternion, atEnd.quaternion), w1]]) {
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < .00001, `${actual} vs ${expected}`));
  }
  assert.deepEqual(atStart.position, start.position);
  assert.ok(new THREE.Quaternion(...atEnd.quaternion).angleTo(new THREE.Quaternion(...end.quaternion)) < 1e-6);
  const table = pose(end); table.props.book.attachment = 'table';
  assert.deepEqual(buildHeldPropBridge(pose(start), table), {}, 'actual release must detach the hands');
});
