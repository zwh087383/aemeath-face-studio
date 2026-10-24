import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { buildFullBodyRig, solveFullBodyPose } from '../preview/core/full-body-ik.js';
import { ACTIVITY_LIBRARY, sampleActivity } from '../preview/core/activity-library.js';
import { enforceActivityPropContacts, measuredPropHand } from '../preview/core/activity-prop-execution.js';

const hooks = registerHooks({ resolve(s, c, next) { return s === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, c); } });
const { createActivityProps } = await import('../realtime/activities/props.mjs'); hooks.deregister();
const rig = buildFullBodyRig(skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8'))));
const anchor = { position: [0, 0, 0], yaw: 0 }, distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
function solve(pose) {
  pose.anchor = anchor; const contacts = enforceActivityPropContacts(rig, pose), fk = new Map();
  const diagnostics = solveFullBodyPose(rig, pose, new Map(), fk);
  const hands = Object.fromEntries(['L', 'R'].map(side => [side, measuredPropHand(rig, pose, fk, side)]));
  return { contacts, diagnostics, hands };
}
const configs = {
  book: { visible: true, attachment: 'table', openness: .8 }, mug: { visible: true, attachment: 'table' },
  pencil: { visible: true, attachment: 'table', position: [-2.6, 8.961, 4.3], rotation: [0, 0, -Math.PI / 2] },
  box: { visible: true, attachment: 'table', position: [0, 8.9, 3.8] },
};

for (const id of ['take_book_standing', 'take_book_seated', 'take_mug_standing', 'take_mug_seated', 'take_pencil_seated', 'pickup_box']) {
  test(`${id}: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous`, () => {
    const definition = ACTIVITY_LIBRARY[id], propId = definition.propId, props = createActivityProps(new THREE.Scene());
    const prior = sampleActivity(definition.initialSupport === 'seated' ? 'sit_listen' : 'shoulder_roll', 0, rig.context), initial = solve(prior);
    const initialProps = { ...prior.props, table: true, [propId]: structuredClone(configs[propId]) };
    props.update(initialProps, { anchor, time: 0 }); const original = props.snapshot().props[propId];
    const context = { ...rig.context, initialProps, sceneProps: initialProps, initialPose: prior, initialHandAnchors: initial.hands, activityAnchor: anchor };
    let elapsed = 0, receipt = null, previous = original, maximumStep = 0, maximumGripError = 0, seenLift = false, maximumControllerError = 0;
    let firstLiftLinearSpeed = null, firstLiftAngularSpeed = null;
    for (let frame = 1; frame <= 480; frame++) {
      elapsed = receipt ? Math.min(definition.duration, elapsed + 1 / 60) : Math.min(1.45, elapsed + 1 / 60);
      const pose = sampleActivity(id, elapsed, context), result = solve(pose);
      maximumControllerError = Math.max(maximumControllerError, ...Object.values(result.contacts.props).map(row => row.maximumGripError));
      assert.equal(result.diagnostics.finite, true);
      props.update(pose.props, { anchor, root: pose.root, pose, time: frame / 60, snapshot: { revision: 1, activeId: id },
        anchors: { leftHand: result.hands.L, rightHand: result.hands.R } });
      const rendered = props.snapshot().props[propId]; assert.equal(rendered.visible, true); assert.deepEqual(rendered.scale, [1, 1, 1]);
      const step = distance(rendered.position, previous.position); maximumStep = Math.max(maximumStep, step);
      if (!receipt) {
        assert.ok(distance(rendered.position, original.position) < 1e-8, `${id}: table source moved before granted ownership`);
        assert.ok(new THREE.Quaternion(...rendered.quaternion).angleTo(new THREE.Quaternion(...original.quaternion)) < 1e-7);
        if (rendered.transfer?.released) {
          assert.equal(rendered.transfer.operation, 'take'); assert.equal(rendered.transfer.sourcePresent, true);
          assert.ok(rendered.transfer.gripError <= .025); assert.ok(rendered.transfer.relativeSpeed <= .32);
          assert.ok(rendered.transfer.angularSpeed <= .5); assert.ok(rendered.transfer.heightError <= .045);
          assert.equal(rendered.transfer.footprint, true); assert.ok(step < 1e-8, 'ownership frame cannot snap the visible prop');
          receipt = { ...rendered.transfer, activityElapsed: elapsed }; context.propTransferReceipts = { [propId]: receipt };
          const epsilon = 1e-5, nextPose = sampleActivity(id, elapsed + epsilon, context), next = solve(nextPose);
          props.update(nextPose.props, { anchor, pose: nextPose, time: frame / 60 + epsilon, snapshot: { revision: 1, activeId: id },
            anchors: { leftHand: next.hands.L, rightHand: next.hands.R } });
          const lifted = props.snapshot().props[propId], dq = new THREE.Quaternion(...lifted.quaternion).multiply(new THREE.Quaternion(...rendered.quaternion).invert());
          firstLiftLinearSpeed = distance(lifted.position, rendered.position) / epsilon;
          firstLiftAngularSpeed = 2 * Math.hypot(dq.x, dq.y, dq.z) / epsilon;
          assert.ok(firstLiftLinearSpeed < .001, `${id}: first lift velocity jumped to ${firstLiftLinearSpeed}`);
          assert.ok(firstLiftAngularSpeed < .001, `${id}: first lift angular velocity jumped to ${firstLiftAngularSpeed}`);
        } else assert.equal(rendered.attachment, 'table');
      } else {
        assert.ok(['left', 'right', 'both'].includes(rendered.attachment));
        if (rendered.gripError !== null) maximumGripError = Math.max(maximumGripError, rendered.gripError);
        assert.ok((rendered.gripError ?? 0) <= .025, `${id}/${elapsed}: ${rendered.gripError}`);
        seenLift ||= distance(rendered.position, original.position) > .1;
      }
      previous = rendered;
      if (receipt && elapsed >= definition.duration) break;
    }
    assert.ok(receipt, `${id}: no actual receipt; last ${JSON.stringify(previous)}`);
    assert.ok(seenLift); assert.ok(maximumStep < .15, `${id}: prop jumped ${maximumStep}`);
    assert.ok(maximumControllerError < .025, `${id}: interpolated hands not physically reachable ${maximumControllerError}`);
    console.log(JSON.stringify({ acceptance: 'actual-pmx-first-acquisition', id, acquiredAt: receipt.releasedAt, activityElapsed: receipt.activityElapsed,
      sourceContactHeightError: receipt.heightError, firstContactGripError: receipt.gripError, maximumHeldGripError: maximumGripError, maximumControllerError, maximumStep,
      firstLiftLinearSpeed, firstLiftAngularSpeed }));
    props.dispose();
  });
}

test('take cannot create an absent object or table, and unknown start hand anchors block approach', () => {
  for (const initialProps of [{ table: true }, { book: configs.book }, { table: true, book: configs.book }]) {
    const pose = sampleActivity('take_book_seated', 4.8, { ...rig.context, initialProps });
    assert.ok(pose.preparationBlocker); assert.ok(pose.phase.startsWith('take-blocked-'));
    assert.notEqual(pose.props.book?.attachment, 'both');
    assert.equal(pose.props.book?.transfer?.requestTake, undefined);
  }
});

test('actual hand acquisition and tabletop footprint are invariant under a common scene yaw', () => {
  for (const yaw of [Math.PI / 4, -Math.PI / 3]) {
    const frame = { position: [4, 0, -3], yaw }, props = createActivityProps(new THREE.Scene());
    const initialPose = sampleActivity('sit_listen', 0, rig.context); initialPose.root = structuredClone(frame); initialPose.anchor = frame;
    const initialFk = new Map(); solveFullBodyPose(rig, initialPose, new Map(), initialFk);
    const hands = Object.fromEntries(['L', 'R'].map(side => [side, measuredPropHand(rig, initialPose, initialFk, side)]));
    const initialProps = { chair: true, table: true, book: configs.book };
    props.update(initialProps, { anchor: frame, time: 0 });
    const context = { ...rig.context, initialPose, initialProps, sceneProps: initialProps, initialHandAnchors: hands, activityAnchor: frame };
    let receipt = null;
    for (let i = 1; i <= 120; i++) {
      const elapsed = Math.min(1.45, i / 60), pose = sampleActivity('take_book_seated', elapsed, context);
      pose.root = structuredClone(frame); pose.anchor = frame; enforceActivityPropContacts(rig, pose);
      const fk = new Map(); solveFullBodyPose(rig, pose, new Map(), fk);
      props.update(pose.props, { anchor: frame, root: pose.root, pose, time: i / 60,
        anchors: { leftHand: measuredPropHand(rig, pose, fk, 'L'), rightHand: measuredPropHand(rig, pose, fk, 'R') } });
      const result = props.snapshot().props.book;
      if (result.transfer?.released) { receipt = result.transfer; break; }
    }
    assert.ok(receipt, `${yaw}: valid rotated table contact was refused ${JSON.stringify(props.snapshot().props.book.transfer)}`);
    assert.equal(receipt.footprint, true); assert.ok(receipt.gripError < .025); props.dispose();
  }
});
