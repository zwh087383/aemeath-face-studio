import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import { FullBodyController } from '../../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';
import { ACTIVITY_LIBRARY, sampleActivity } from '../../preview/core/activity-library.js';
import { ACTIVITY_PROP_LAYOUT, propGripPair } from '../../preview/core/activity-prop-layout.js';
import { PARTITIONED_DESK } from '../../preview/core/activity-desk-layout.js';
import { createActivityProps } from '../../realtime/activities/props.mjs';
import { toWorld, rootRotation } from '../../preview/core/full-body-ik.js';
import { qmul } from '../../preview/core/motion-math.js';
import { pulledOutDeskEntryFixture } from '../../preview/core/activity-seat-access.js';

const skeleton = skeletonFromInspection(JSON.parse(fs.readFileSync(new URL('../../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const copy = value => structuredClone(value);
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
export const HELD_VARIANTS = Object.values(ACTIVITY_LIBRARY).filter(d => d.heldVariant);
export const CONTINUATIONS = Object.values(ACTIVITY_LIBRARY).filter(d => d.continuation);

export function fixture(setup, { safeSeat = true } = {}) {
  const c = new FullBodyController({ skeleton }), props = createActivityProps(new THREE.Scene());
  let initialRoot = null;
  if (safeSeat && setup.chair === true) {
    const safe = pulledOutDeskEntryFixture(c.context, { props: setup }); setup = safe.sceneProps; initialRoot = safe.initialRoot;
  }
  props.update(setup, { anchor: c.anchor, root: c.root, pose: c.pose, time: 0 });
  c.setRenderedPropsSnapshot(props.snapshot());
  if (initialRoot) assert.equal(c.adoptSupportedState({ pose: c.standing(initialRoot), sceneProps: copy(c.sceneProps) }), true);
  const steps = [];
  function step() {
    c.update(c.now + 1 / 30, 1 / 30);
    const hands = c.handAnchors();
    props.update({ ...c.sceneProps, ...c.pose.props }, { anchors: { leftHand: hands.L, rightHand: hands.R },
      root: c.root, anchor: c.pose.anchor ?? c.anchor, pose: c.pose, snapshot: c.snapshot(), time: c.now });
    const measured = props.snapshot(); c.setRenderedPropsSnapshot(measured); c.setPropTransferReceipts(measured);
    return measured;
  }
  function run(id, options = {}, inspect = () => {}) {
    if (/^take_.*_seated$/.test(id) && c.seatAccess('approach_desk_seated').accepted) run('approach_desk_seated');
    assert.equal(c.play(id, { context: { deskLayout: 'partitioned', ...(id === 'stand_up_from_desk' ? { deskRetreat: 5.5 } : {}) }, ...options }), true, `${id}: rejected`);
    assert.equal(c.activeId, id, `${id}: unexpected implicit prerequisite`);
    const began = c.now; let frames = 0;
    for (; !c.done && frames < 1200; frames++) inspect(step());
    assert.equal(c.done, true, `${id}: ${c.status}, ${c.pose.preparationBlocker ?? ''}`);
    const result = { id, frames, seconds: c.now - began, support: c.pose.support, variant: c.snapshot().variant };
    steps.push(result); return result;
  }
  return { c, props, steps, step, run, setup: copy(setup), initialRoot: copy(initialRoot) };
}

export function measuredGrip(f, id, row) {
  assert.equal(row.visible, true); assert.equal(row.measured, true);
  const pair = propGripPair(id, row.openness), hands = f.c.handAnchors();
  const points = row.attachment === 'both' ? [['L', pair.left], ['R', pair.right]]
    : [[row.attachment === 'left' ? 'L' : 'R', f.c.pose.props[id].grip ?? ACTIVITY_PROP_LAYOUT[id].grip]];
  return Math.max(...points.map(([side, grip]) => new THREE.Vector3(...grip)
    .multiply(new THREE.Vector3(...row.scale)).applyQuaternion(new THREE.Quaternion(...row.quaternion))
    .add(new THREE.Vector3(...row.position)).distanceTo(new THREE.Vector3(...hands[side].position))));
}

// Compare every authored root, trunk, pelvis and foot channel, after the same
// world transform. Hands intentionally use a named holding variant instead of
// pretending that an empty-handed arm swing has still taken place.
function verifySourceAmplitude(c, id) {
  const source = sampleActivity(id, c.elapsed, c.sampleContext), q = rootRotation(c.anchor);
  source.root = { position: toWorld(c.anchor, source.root.position), yaw: c.anchor.yaw + source.root.yaw };
  for (const side of ['L', 'R']) {
    source.feet[side].position = toWorld(c.anchor, source.feet[side].position);
    source.feet[side].rotation = qmul(q, source.feet[side].rotation ?? rootRotation(source.root));
  }
  for (const channel of ['root', 'pelvis', 'body', 'feet']) assert.deepEqual(c.pose[channel], source[channel], `${id}: source ${channel} reduced`);
}

export function auditHeldVariant(id) {
  const d = ACTIVITY_LIBRARY[id], index = HELD_VARIANTS.findIndex(v => v.id === id);
  assert.ok(d?.heldVariant);
  const prop = index % 2 ? 'mug' : 'book';
  const setup = { table: true, [prop]: copy(PARTITIONED_DESK.setupProps[prop]), ...(d.category === 'seated' ? { chair: true } : {}) };
  const f = fixture(setup), { c, props } = f;
  try {
    if (d.initialSupport === 'seated') f.run('sit_down');
    if (id === 'sit_down') {
      // Acquire at a reachable desk before approaching the pulled-out chair.
      const root = { position: [0, 0, 0], yaw: 0 };
      assert.equal(c.adoptSupportedState({ pose: c.standing(root), sceneProps: copy(c.sceneProps) }), true);
    }
    f.run(`take_${prop}_${d.initialSupport === 'seated' ? 'seated' : 'standing'}`);
    const receipt = copy(props.snapshot().acquisitionReceipts[prop]);
    assert.equal(receipt.released, true); assert.ok(receipt.gripError < .025);
    if (d.category === 'locomotion') { f.run('walk_backward'); f.run('walk_backward'); }
    if (['stand_up', 'approach_desk_seated'].includes(id)) {
      f.run('stand_up_from_desk', { context: { deskLayout: 'partitioned', deskRetreat: 7 } }); f.run('sit_down');
    }
    const before = props.snapshot(), held = before.props[prop].attachment;
    const result = { id, variant: d.heldVariant, prop, attachment: held, fixture: copy(f.setup), initialRoot: copy(f.initialRoot), prerequisites: copy(f.steps),
      acquiredByActualContact: receipt, maxGripError: 0, maxAnkleError: 0, maxSeatHeightError: 0,
      sourceAmplitudeFrames: 0, heldFrames: 0, freeArmSourceFrames: 0, seatContactFrames: 0, feetSupportedRiseFrames: 0 };
    result.execution = f.run(id, {}, measured => {
      const row = measured.props[prop]; assert.equal(row.attachment, held, `${id}: lost ${prop}`);
      assert.deepEqual(measured.acquisitionReceipts[prop], receipt, `${id}: re-acquired prop`);
      assert.equal(measured.placementReceipts[prop], undefined, `${id}: released prop`);
      const gripError = measuredGrip(f, prop, row);
      result.maxGripError = Math.max(result.maxGripError, gripError); assert.ok(gripError < .025, `${id}: grip ${gripError}`);
      const ankleError = Math.max(c.diagnostics.legs.L.error, c.diagnostics.legs.R.error);
      result.maxAnkleError = Math.max(result.maxAnkleError, ankleError); assert.ok(ankleError < 1e-6);
      assert.deepEqual(measured.props.table.position, before.props.table.position, `${id}: moved table`);
      if (c.pose.support === 'seated') {
        assert.equal(measured.props.chair.visible, true);
        // 10.55 is the activity rig's calibrated seat-contact datum. The PMX
        // root bone is higher and is not a skin contact point on the cushion.
        const pelvis = toWorld(c.pose.root, [c.pose.pelvis.offset[0], 10.55 + c.pose.pelvis.offset[1], c.pose.pelvis.offset[2]]);
        const seatHeightError = Math.abs(pelvis[1] - measured.props.chair.position[1] - ACTIVITY_PROP_LAYOUT.chair.seatTop);
        if (['rise', 'desk_rise'].includes(c.pose.phase)) {
          // Source labels the beginning of a rise as seated until t=1; the
          // actual seat contact has already yielded to both planted feet.
          assert.equal(c.pose.feet.L.contact && c.pose.feet.R.contact, true);
          result.feetSupportedRiseFrames++;
        } else {
          result.maxSeatHeightError = Math.max(result.maxSeatHeightError, seatHeightError);
          assert.ok(seatHeightError < .06, `${id}: seat height ${seatHeightError}`);
          assert.ok(Math.abs(pelvis[0] - measured.props.chair.position[0]) < 3.3);
          assert.ok(Math.abs(pelvis[2] - measured.props.chair.position[2]) < 2.6);
          result.seatContactFrames++;
        }
      }
      if (!c.bridge) {
        assert.equal(c.snapshot().variant, d.heldVariant);
        verifySourceAmplitude(c, id); result.sourceAmplitudeFrames++;
        if (held === 'right') {
          assert.deepEqual(c.pose.hands.L, sampleActivity(id, c.elapsed, c.sampleContext).hands.L, `${id}: free arm source`);
          result.freeArmSourceFrames++;
        }
      }
      result.heldFrames++;
    });
    assert.ok(result.sourceAmplitudeFrames > 20); assert.equal(c.speed, 1); assert.equal(c.duration, d.duration);
    assert.equal(c.pose.support, d.endSupport); assert.equal(props.snapshot().props[prop].attachment, held);
    result.after = { support: c.pose.support, variant: c.snapshot().variant, prop: props.snapshot().props[prop], root: copy(c.root) };
    result.pass = true; return result;
  } finally { props.dispose(); }
}

export function sourceHashes() {
  return Object.fromEntries(['preview/core/full-body-controller.js', 'preview/core/activity-library.js', 'preview/core/activity-continuation.js', 'preview/core/activity-seat-access.js',
    'preview/core/activity-prop-execution.js', 'realtime/activities/props.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ids = process.argv.includes('--ids') ? process.argv[process.argv.indexOf('--ids') + 1].split(',') : HELD_VARIANTS.map(d => d.id);
  const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : 'outputs/library-expansion-20261027/activity-held-variants.json';
  const report = { at: new Date().toISOString(), evidence: 'Actual controller, PMX FK and props contacts; no GPU, cloud or human naturalness acceptance', sourceHashes: sourceHashes(), rows: [] };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (const id of ids) {
    try { report.rows.push(auditHeldVariant(id)); } catch (error) { report.rows.push({ id, pass: false, error: error.stack }); process.exitCode = 1; }
    fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ id, pass: report.rows.at(-1).pass, error: report.rows.at(-1).error }));
  }
}
