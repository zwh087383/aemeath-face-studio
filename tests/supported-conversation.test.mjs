import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parser } from '../preview/node_modules/mmd-parser/build/mmdparser.module.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { sampleActivity } from '../preview/core/activity-library.js';
import { sampleSupportedConversation, SupportedConversationOverlay, captureSupportedPoseFromMeasured } from '../preview/core/supported-conversation.js';
import { AEMEATH_CHIN_CONTACT } from '../preview/core/head-relative-contact.js';
import { solveFullBodyPose, toWorld, rootRotation } from '../preview/core/full-body-ik.js';
import { enforceActivityPropContacts } from '../preview/core/activity-prop-execution.js';
import { qmul, qrotate, len, sub, add, scale, dot } from '../preview/core/motion-math.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const fresh = () => new FullBodyController({ skeleton });
const distance = (a, b) => len(sub(a, b));
let privatePmx;
function pmx() {
  if (!privatePmx) {
    const buffer = readFileSync(new URL('../assets/Aemeath/鸣潮_爱弥斯1.05.pmx', import.meta.url));
    privatePmx = new Parser().parsePmx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), true);
  }
  return privatePmx;
}
function measured(c, pose) {
  c.pose = structuredClone(pose); c.root = structuredClone(pose.root); c.solve();
  const rig = c.rig, names = { head: rig.torso.head.name, neck: rig.torso.neck.name, pelvis: rig.support.root,
    lowerBody: rig.support.pelvis, chest: rig.torso.chest.name, spine: rig.torso.spine.name, upperChest: rig.torso.upperChest.name,
    leftWrist: rig.sides.L.names.wrist, rightWrist: rig.sides.R.names.wrist,
    leftMiddle: rig.sides.L.names.fingers.middle[0], rightMiddle: rig.sides.R.names.fingers.middle[0],
    leftShoulder: rig.sides.L.names.arm, rightShoulder: rig.sides.R.names.arm,
    leftElbow: rig.sides.L.names.elbow, rightElbow: rig.sides.R.names.elbow,
    leftAnkle: rig.legs.L.names.ankle, rightAnkle: rig.legs.R.names.ankle };
  const root = structuredClone(pose.root), bones = {}, rotations = {};
  for (const [key, name] of Object.entries(names)) {
    const frame = c.fk.get(name); bones[key] = toWorld(root, frame.position); rotations[key] = qmul(rootRotation(root), frame.rotation);
  }
  return { root, bones, rotations, support: pose.support, seatSupported: pose.support === 'seated',
    props: structuredClone(c.pose.props), contacts: Object.fromEntries(['L', 'R'].map(side => [side, !!pose.feet[side].contact])) };
}

test('supported gestures retain actual feet, seat and held book contacts while moving the head', () => {
  const c = fresh(), p = sampleActivity('read_seated', 3, c.context);
  p.propContacts = enforceActivityPropContacts(c.rig, p);
  measured(c, p); const pose = structuredClone(c.pose), original = structuredClone(pose);
  for (const kind of ['listen', 'nod', 'shake', 'tilt_left', 'tilt_right', 'glance_left', 'glance_right']) {
    const result = sampleSupportedConversation(pose, { kind, phase: .25, strength: .8 }, { rig: c.rig });
    assert.equal(result.accepted, true, `${kind}: ${result.reason}`);
    assert.deepEqual(result.pose.root, original.root); assert.deepEqual(result.pose.pelvis, original.pelvis); assert.deepEqual(result.pose.feet, original.feet);
    assert.equal(result.pose.props.book.attachment, 'both'); assert.equal(result.contact.ready, true);
    assert.notDeepEqual(result.pose.body, pose.body);
  }
  assert.deepEqual(pose, original, 'base task is never mutated or cumulatively tilted');
  assert.equal(sampleSupportedConversation(pose, { kind: 'finger_release', phase: .5 }, { rig: c.rig }).reason, 'no-free-hand');
  assert.equal(sampleSupportedConversation(pose, { kind: 'chin_tap', phase: .5 }, { rig: c.rig }).reason, 'chin-contact-needs-free-right-hand');
});

test('overlay cancellation returns to current task and never schedules another gesture', () => {
  const c = fresh(), p = sampleActivity('sit_relax', 2, c.context), overlay = new SupportedConversationOverlay();
  assert.equal(overlay.begin({ id: 'chosen-nod', kind: 'nod', duration: 2 }), true);
  for (let i = 0; i < 30; i++) overlay.update(1 / 60, p, { rig: c.rig });
  const before = overlay.snapshot().elapsed;
  assert.equal(overlay.begin({ id: 'chosen-nod', kind: 'nod' }), true); assert.equal(overlay.snapshot().elapsed, before);
  assert.equal(overlay.begin({ id: 'new-semantic-shake', kind: 'shake' }), false);
  assert.equal(overlay.cancel('older-id'), false); assert.equal(overlay.cancel('chosen-nod'), true);
  let result;
  for (let i = 0; i < 25; i++) result = overlay.update(1 / 60, p, { rig: c.rig });
  assert.equal(overlay.snapshot(), null); assert.deepEqual(result.pose, p);
});

test('measured native-like seated and standing poses preserve world root, support, chest, and feet on adoption', () => {
  for (const seated of [false, true]) {
    const c = fresh(), p = seated ? sampleActivity('sit_relax', 2, c.context) : structuredClone(c.pose);
    p.root = { position: [3.2, .6, -4.3], yaw: .72 };
    for (const side of ['L', 'R']) { p.feet[side].position = toWorld(p.root, p.feet[side].position); p.feet[side].rotation = rootRotation(p.root); }
    Object.assign(p.body, { lean: .17, twist: -.18, side: .07, headPitch: -.12, headYaw: .25, headRoll: .06 });
    const state = measured(c, p), result = captureSupportedPoseFromMeasured(c, state);
    assert.equal(result.accepted, true, result.reason); assert.ok(result.diagnostics.torsoOrientationError < 1e-7); assert.ok(result.diagnostics.headOrientationError < 1e-7);
    assert.deepEqual(result.pose.root, p.root); assert.equal(result.pose.support, p.support);
    for (const side of ['L', 'R']) assert.ok(distance(result.pose.feet[side].position, p.feet[side].position) < 1e-6);
    assert.ok(distance(result.pose.pelvis.offset, p.pelvis.offset) < 1e-6);
    assert.equal(c.adoptSupportedState({ pose: result.pose, sceneProps: state.props }), true);
    assert.equal(c.done, true); assert.equal(c.activeId, null); assert.equal(c.snapshot().support, p.support);
  }
});

test('unverified seat, unknown support and incomplete measured frames are rejected without changing the owner', () => {
  const c = fresh(), state = measured(c, sampleActivity('sit_relax', 2, c.context));
  assert.equal(captureSupportedPoseFromMeasured(c, { ...state, seatSupported: false }).reason, 'verified-seat-required');
  assert.equal(captureSupportedPoseFromMeasured(c, { ...state, support: 'unknown' }).reason, 'measured-support-required');
  const missing = structuredClone(state); delete missing.bones.upperChest;
  assert.equal(captureSupportedPoseFromMeasured(c, missing).reason, 'measured-bone-frames-required');
});

test('chin marker is an actual head-skinned underside face vertex in the private PMX', () => {
  const model = pmx();
  const marker = AEMEATH_CHIN_CONTACT, vertex = model.vertices[marker.vertexIndex], headIndex = model.bones.findIndex(bone => bone.name === marker.bone);
  assert.ok(vertex.skinIndices.every(index => index === headIndex));
  const expected = add(model.bones[headIndex].position, marker.localPosition);
  assert.ok(distance(vertex.position, expected) < 1e-7); assert.ok(distance(vertex.normal, marker.localNormal) < 1e-7);
  assert.ok(vertex.normal[1] < -.9, 'surface is under the chin, not in front of the mouth');
  const vowel = model.morphs.find(morph => morph.name === 'あ');
  assert.ok(vowel.elements.some(e => e.index === marker.vertexIndex), 'renderer must account for animated skin when supplied');
});

test('chin tip contact follows live head rotation, translated root, seat and rendered mouth-morph point', () => {
  for (const seated of [false, true]) for (const headYaw of [-.35, 0, .35]) {
    const c = fresh(), p = seated ? sampleActivity('sit_relax', 2, c.context) : structuredClone(c.pose);
    p.root = { position: [2, 0, -3], yaw: -.6 };
    for (const side of ['L', 'R']) p.feet[side].position = toWorld(p.root, p.feet[side].position);
    p.body.headYaw = headYaw; p.body.headPitch = .08;
    const a = sampleSupportedConversation(p, { kind: 'chin_tap', phase: .5, strength: 1 }, { rig: c.rig });
    assert.equal(a.accepted, true, a.reason); assert.ok(a.contact.error < .01); assert.equal(a.contact.atContact, true);
    assert.deepEqual(a.pose.root, p.root); assert.deepEqual(a.pose.feet, p.feet); assert.deepEqual(a.pose.pelvis, p.pelvis);
    const shifted = add(a.contact.surface, scale(a.contact.normal, .04));
    const b = sampleSupportedConversation(p, { kind: 'chin_tap', phase: .5, chinSurface: { position: shifted, normal: a.contact.normal } }, { rig: c.rig });
    assert.equal(b.accepted, true); assert.ok(b.contact.error < .01); assert.ok(distance(b.contact.actual, a.contact.actual) > .03);
    const voiced = sampleSupportedConversation(p, { kind: 'chin_tap', phase: .5, voicing: true }, { rig: c.rig });
    assert.equal(voiced.accepted, true); assert.ok(distance(voiced.contact.actual, voiced.contact.surface) > .58);
    for (const phase of [0, 1]) assert.deepEqual(sampleSupportedConversation(p, { kind: 'chin_tap', phase }, { rig: c.rig }).pose.hands, p.hands);
  }
});

test('voicing retreat is continuous and the chin gesture cannot occupy a typing or holding hand', () => {
  const c = fresh(), p = structuredClone(c.pose), overlay = new SupportedConversationOverlay();
  overlay.begin({ id: 'chosen-chin', kind: 'chin_tap', duration: 3 });
  let last, next;
  for (let i = 0; i < 90; i++) last = overlay.update(1 / 60, p, { rig: c.rig });
  for (let i = 0; i < 12; i++) {
    next = overlay.update(1 / 60, p, { rig: c.rig, voicing: true });
    assert.equal(next.accepted, true); assert.ok(distance(next.contact.actual, last.contact.actual) < .16);
    last = next;
  }
  assert.ok(next.contact.clearance > .58);
  const typing = sampleActivity('type_at_desk', 3, { ...c.context, deskLayout: 'partitioned' });
  assert.equal(sampleSupportedConversation(typing, { kind: 'chin_tap', phase: .5 }, { rig: c.rig }).reason, 'chin-contact-needs-free-right-hand');
});

test('soft chin touch still reaches the measured surface and cancellation returns without frozen contact', () => {
  const c = fresh(), p = structuredClone(c.pose);
  for (const strength of [.2, .5, 1]) {
    const touch = sampleSupportedConversation(p, { kind: 'chin_tap', phase: .5, strength }, { rig: c.rig });
    assert.equal(touch.accepted, true); assert.equal(touch.contact.atContact, true); assert.ok(touch.contact.error < .01);
  }
  const overlay = new SupportedConversationOverlay(); overlay.begin({ id: 'soft-touch', kind: 'chin_tap', duration: 3, strength: .3 });
  for (let i = 0; i < 90; i++) overlay.update(1 / 60, p, { rig: c.rig });
  assert.equal(overlay.cancel('soft-touch'), true);
  let result; for (let i = 0; i < 25; i++) result = overlay.update(1 / 60, p, { rig: c.rig });
  assert.equal(overlay.snapshot(), null); assert.deepEqual(result.pose, p);
});

test('chin touch keeps its index contact while the other fingers fold naturally and zero dt preserves the pose', () => {
  const c = fresh(), source = structuredClone(c.pose), overlay = new SupportedConversationOverlay();
  overlay.begin({ id: 'index-touch', kind: 'chin_tap', duration: 2.4, strength: .65 });
  let result; for (let i = 0; i < 72; i++) result = overlay.update(1 / 60, source, { rig: c.rig });
  const zero = overlay.update(0, source, { rig: c.rig }); assert.deepEqual(zero, result);
  assert.equal(result.accepted, true); assert.ok(result.contact.error < .01);
  const fk = new Map(); solveFullBodyPose(c.rig, result.pose, new Map(), fk);
  const index = fk.get(c.rig.sides.R.names.tips.index).position;
  for (const finger of ['middle', 'ring', 'pinky']) {
    const tip = fk.get(c.rig.sides.R.names.tips[finger]).position;
    assert.ok(tip[1] < index[1] - .6, `${finger} remained straight beside index`);
  }
  const ordinary = structuredClone(source), explicit = structuredClone(source);
  for (const side of ['L', 'R']) explicit.hands[side].fingerCurls = Object.fromEntries(['index', 'middle', 'ring', 'pinky'].map(name => [name, explicit.hands[side].curl]));
  const originalLocals = new Map(), explicitLocals = new Map();
  solveFullBodyPose(c.rig, ordinary, originalLocals); solveFullBodyPose(c.rig, explicit, explicitLocals);
  assert.deepEqual([...originalLocals], [...explicitLocals], 'default finger curls must preserve every existing bone rotation');
});

test('real skinned finger surfaces remain outside the underside chin plane during contact and voicing', () => {
  const model = pmx(), c = fresh();
  const vertices = model.vertices.map(vertex => ({ vertex, influences: vertex.skinIndices.map((bone, i) => ({ bone: model.bones[bone], weight: vertex.skinWeights[i] })).filter(v => v.weight > 1e-5) }))
    .filter(row => row.influences.length && row.influences.every(v => /^右(親指|人指|中指|薬指|小指)/.test(v.bone.name)));
  assert.ok(vertices.length > 2000);
  for (const headYaw of [-.35, 0, .35]) for (const voicing of [false, true]) {
    const source = structuredClone(c.pose); source.body.headYaw = headYaw;
    const result = sampleSupportedConversation(source, { kind: 'chin_tap', phase: .5, voicing }, { rig: c.rig });
    assert.equal(result.accepted, true);
    const fk = new Map(); solveFullBodyPose(c.rig, result.pose, new Map(), fk);
    let minimum = Infinity;
    for (const { vertex, influences } of vertices) {
      const skinned = influences.reduce((sum, { bone, weight }) => {
        const frame = fk.get(bone.name); assert.ok(frame, bone.name);
        return add(sum, scale(add(frame.position, qrotate(frame.rotation, sub(vertex.position, bone.position))), weight));
      }, [0, 0, 0]);
      const gap = dot(sub(toWorld(source.root, skinned), result.contact.surface), result.contact.normal);
      minimum = Math.min(minimum, gap);
    }
    assert.ok(minimum > 0, `finger skin crossed chin underside at yaw ${headYaw}: ${minimum}`);
    if (voicing) assert.ok(minimum > .45, `voice clearance at yaw ${headYaw}: ${minimum}`);
  }
});
