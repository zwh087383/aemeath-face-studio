import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { buildFullBodyRig, solveFullBodyPose, toWorld } from '../preview/core/full-body-ik.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { POSTURES } from '../preview/core/motion-profile.js';
import { ACTIVITY_LIBRARY, sampleActivity } from '../preview/core/activity-library.js';
import { smoother, lerp3 } from '../preview/core/motion-math.js';
import { enforceActivityPropContacts } from '../preview/core/activity-prop-execution.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const moduleHooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createActivityProps } = await import('../realtime/activities/props.mjs');
moduleHooks.deregister();
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const fixtureLibrary = { walk: { duration: 2 }, jump: { duration: 1.4 }, sit: { duration: 1.4, endState: 'seated' },
  read: { duration: 3, endState: 'seated', seatedStartTime: 1.4 }, stand_up: { duration: 1.4, startState: 'seated' } };
const neutral = context => ({ root: { position: [0, 0, 0], yaw: 0 }, pelvis: { offset: [0, 0, 0] }, body: {},
  hands: structuredClone(POSTURES.relaxed), feet: Object.fromEntries(['L', 'R'].map(side => [side, { position: [...context.feet[side]], contact: true }])),
  support: 'standing', phase: 'stance', face: { preset: 'neutral', intensity: .5 }, props: {} });
function fixtureSampler(id, t, context) {
  const pose = neutral(context), duration = fixtureLibrary[id].duration, u = Math.min(1, t / duration);
  if (id === 'walk') {
    pose.root.position[2] = 4 * smoother(u); pose.pelvis.offset[1] = -.3 * Math.sin(Math.PI * u);
    for (const [side, begin] of [['L', .15], ['R', .55]]) {
      const phase = Math.max(0, Math.min(1, (u - begin) / .3));
      pose.feet[side].position[2] += 4 * smoother(phase);
      pose.feet[side].position[1] += .6 * Math.sin(Math.PI * phase);
      pose.feet[side].contact = phase === 0 || phase === 1;
    }
  } else if (id === 'jump') {
    const flight = Math.max(0, Math.min(1, (t - .3) / .7));
    pose.root.position = [0, 2.2 * Math.sin(Math.PI * flight), 2 * smoother(flight)];
    pose.pelvis.offset[1] = t < .3 ? -.55 * Math.sin(Math.PI * t / .3) : t > 1 ? -.45 * Math.sin(Math.PI * (t - 1) / .4) : 0;
    pose.support = t > .3 && t < 1 ? 'airborne' : 'standing';
    for (const side of ['L', 'R']) {
      pose.feet[side].position = pose.feet[side].position.map((v, i) => v + pose.root.position[i]);
      pose.feet[side].contact = pose.support !== 'airborne';
    }
  } else {
    const sit = id === 'stand_up' ? 1 - smoother(u) : smoother(Math.min(1, t / 1.4));
    pose.pelvis.offset = [0, -4.45 * sit, -1.2 * sit];
    pose.body = { lean: .12 * sit, headPitch: .1 * sit };
    if (id === 'stand_up') pose.root.position[2] = 4.4 * smoother(u);
    for (const side of ['L', 'R']) pose.feet[side].position[2] += id === 'stand_up' ? 4.4 : 4.4 * sit;
    pose.support = sit > .999 ? 'seated' : 'standing';
    pose.props = { chair: true, book: id === 'read' ? { visible: true, attachment: 'both' } : false };
  }
  pose.terminal = u >= 1; return pose;
}
const controller = () => new FullBodyController({ skeleton, library: fixtureLibrary, sampler: fixtureSampler });
const sceneLayers = new WeakMap();
function sceneLayer(c) { if (!sceneLayers.has(c)) sceneLayers.set(c, createActivityProps(new THREE.Scene())); return sceneLayers.get(c); }
function stepController(c, dt) {
  c.update(c.now + dt, dt);
  const anchors = c.handAnchors(), props = sceneLayer(c);
  props.update(c.pose.props, { anchors: { leftHand: anchors.L, rightHand: anchors.R }, root: c.root,
    anchor: c.pose.anchor ?? c.anchor, pose: c.pose, snapshot: c.snapshot(), time: c.now });
  c.setRenderedPropsSnapshot(props.snapshot()); c.setPropTransferReceipts(props.snapshot());
}
function prepareSource(c, id) {
  const def = ACTIVITY_LIBRARY[id], propId = def?.propId ?? (def?.reading ? 'book' : def?.kind === 'drink' ? 'mug' : def?.kind === 'write' ? 'pencil' : ['carry', 'pickup'].includes(def?.kind) ? 'box' : null);
  if (!propId) return;
  const state = { visible: true, attachment: 'table', ...(propId === 'book' ? { openness: .8 } : {}),
    ...(propId === 'pencil' ? { position: [-2.6, 8.961, 3.2], rotation: [0, 0, -Math.PI / 2] } : {}),
    ...(propId === 'box' ? { position: [0, 8.9, 3.8] } : {}) };
  const props = sceneLayer(c); props.update({ table: true, [propId]: state }, { anchor: c.anchor, time: c.now });
  c.setRenderedPropsSnapshot(props.snapshot());
  if (def.kind === 'put_prop') {
    const prior = propId === 'book' ? def.initialSupport === 'seated' ? 'read_seated' : 'read_standing'
      : propId === 'mug' ? def.initialSupport === 'seated' ? 'drink_seated' : 'drink_standing' : 'write_at_desk';
    c.play(prior);
    for (let frame = 0; frame < 1800 && !c.done; frame++) stepController(c, 1 / 30);
    assert.equal(c.done, true, `${id}: real acquisition prerequisite did not finish`);
  }
}
function advance(c, seconds) { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) stepController(c, 1 / 60); }

test('real PMX leg lengths, exact ankle targets and original leg ownership', () => {
  const rig = buildFullBodyRig(skeleton), pose = neutral(rig.context), locals = new Map(), fk = new Map();
  assert.ok(Math.abs(rig.context.legLengths.L[0] - 4.887788) < 1e-5);
  assert.ok(Math.abs(rig.context.legLengths.L[1] - 4.942139) < 1e-5);
  const result = solveFullBodyPose(rig, pose, locals, fk);
  for (const side of ['L', 'R']) assert.ok(result.legs[side].error < 1e-6);
  for (const name of locals.keys()) assert.ok(!/足D|ひざD|足首D|腰キャンセル/.test(name), `grant bone double driven: ${name}`);
});

test('lowering pelvis bends the actual femur and tibia forward while ankles stay on the floor', () => {
  const rig = buildFullBodyRig(skeleton), pose = neutral(rig.context), locals = new Map(), fk = new Map();
  pose.pelvis.offset = [0, -4.45, -1.2]; pose.support = 'seated';
  for (const side of ['L', 'R']) pose.feet[side].position[2] += 4.4;
  const result = solveFullBodyPose(rig, pose, locals, fk);
  for (const side of ['L', 'R']) {
    assert.ok(result.legs[side].error < 1e-6);
    const hip = fk.get(rig.legs[side].names.hip).position, knee = fk.get(rig.legs[side].names.knee).position;
    assert.ok(knee[2] > hip[2] + 3, 'sitting knee must bend forward visibly');
    assert.ok(hip[1] < 7 && hip[1] > 6, 'real hip must lower to seat height');
  }
});

test('root translation and yaw do not drag world-space stance feet', () => {
  const rig = buildFullBodyRig(skeleton), pose = neutral(rig.context);
  pose.root = { position: [4, 0, -3], yaw: 1.1 }; pose.pelvis.offset[1] = -.25;
  for (const side of ['L', 'R']) pose.feet[side].position = toWorld(pose.root, rig.context.feet[side]);
  const planted = structuredClone(pose.feet);
  for (let i = 0; i <= 12; i++) {
    pose.root.position[2] = -3 + i * .04; pose.root.yaw = 1.1 + i * .004;
    const result = solveFullBodyPose(rig, pose);
    for (const side of ['L', 'R']) {
      assert.deepEqual(pose.feet[side].position, planted[side].position);
      assert.ok(result.legs[side].error < 1e-6, `${side} drift ${result.legs[side].error}`);
    }
  }
});

test('paused activity freezes clock, world root, actual bone rotations and contact state exactly', () => {
  const c = controller(); c.play('walk'); advance(c, .9); c.pause(true);
  const before = c.snapshot(), beforeNow = c.now, locals = [...c.locals].map(([name, q]) => [name, [...q]]);
  advance(c, 2);
  assert.deepEqual(c.snapshot(), before); assert.deepEqual([...c.locals], locals); assert.equal(c.now, beforeNow, 'paused contact gate clock advanced');
  c.pause(false); advance(c, .3); assert.ok(c.elapsed > before.elapsed);
});

test('an airborne stop continues to the current landing then recovers without root reset', () => {
  const c = controller(); c.play('jump'); advance(c, 1.05);
  assert.equal(c.pose.support, 'airborne'); const height = c.root.position[1]; assert.ok(height > 1);
  c.stop(); assert.equal(c.status, 'landing'); assert.equal(c.root.position[1], height);
  advance(c, 1.8);
  assert.equal(c.status, 'idle'); assert.equal(c.done, true);
  assert.ok(Math.abs(c.root.position[2] - 2) < 1e-8); assert.ok(Math.abs(c.root.position[1]) < 1e-8);
  for (const side of ['L', 'R']) assert.equal(c.pose.feet[side].contact, true);
});

test('replacing an airborne clip queues ownership until landing, then starts at the landed world root', () => {
  const c = controller(); c.play('jump'); advance(c, 1.05); c.play('walk');
  assert.equal(c.snapshot().queued, 'walk'); assert.equal(c.activeId, 'jump');
  advance(c, .8); assert.equal(c.activeId, 'walk'); assert.ok(c.anchor.position[2] >= 1.99);
  advance(c, 3); assert.ok(c.root.position[2] >= 5.99);
});

test('sitting stop retains seat, pelvis, hand-held object and anchor; reading does not re-sit', () => {
  const c = controller(); c.play('sit'); advance(c, 2.2);
  assert.equal(c.pose.support, 'seated'); const anchor = structuredClone(c.anchor), pelvis = [...c.pose.pelvis.offset];
  c.stop(); advance(c, .5);
  assert.equal(c.status, 'seated'); assert.deepEqual(c.pose.pelvis.offset, pelvis); assert.equal(c.pose.props.chair, true);
  c.play('read'); assert.equal(c.elapsed, 1.4); assert.deepEqual(c.anchor, anchor); advance(c, .7);
  assert.equal(c.pose.support, 'seated'); assert.equal(c.pose.props.book.visible, true);
  c.stop(); const before = c.snapshot(); advance(c, 1); assert.deepEqual(c.pose, before.pose);
  c.play('stand_up'); advance(c, 2.1);
  assert.equal(c.pose.support, 'standing'); assert.ok(Math.abs(c.root.position[2] - 4.4) < 1e-8);
  c.play('walk'); advance(c, 3); assert.ok(Math.abs(c.root.position[2] - 8.4) < 1e-8);
});

test('invalid commands preserve current activity and grounding transitions mark lifted feet released', () => {
  const c = controller(); c.play('walk'); advance(c, 1.3); const before = c.snapshot();
  for (const id of ['invalid', 'constructor', '__proto__', 'toString']) assert.equal(c.play(id), false);
  assert.deepEqual(c.snapshot(), before);
  c.stop(); let previous = structuredClone(c.pose.feet);
  for (let i = 0; i < 60; i++) {
    stepController(c, 1 / 60);
    for (const side of ['L', 'R']) if (previous[side].contact && c.pose.feet[side].contact) {
      assert.ok(distance(previous[side].position, c.pose.feet[side].position) < 1e-8, 'a declared planted foot must not slide');
    }
    previous = structuredClone(c.pose.feet);
  }
});

test('all real activity samples remain within measured PMX limb reach and report actual FK errors', () => {
  const c = new FullBodyController({ skeleton }); let count = 0, maxLeg = 0, maxReach = 0, maxWrist = 0;
  assert.ok(Object.keys(ACTIVITY_LIBRARY).length >= 64);
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY)) {
    for (let i = 0; i <= Math.ceil(definition.duration * 30); i++) {
      const time = Math.min(definition.duration, i / 30), pose = sampleActivity(id, time, c.context);
      // The actual display now solves fixed-size prop grips before the body.
      // Exercise that same path; raw wrist hints are not the rendered targets.
      const contacts = enforceActivityPropContacts(c.rig, pose);
      const result = solveFullBodyPose(c.rig, pose, c.locals, c.fk);
      for (const side of ['L', 'R']) {
        const leg = result.legs[side], arm = result.arms[side];
        const wristError = distance(c.fk.get(c.rig.sides[side].names.wrist).position, arm.target);
        maxLeg = Math.max(maxLeg, leg.error); maxReach = Math.max(maxReach, arm.reach); maxWrist = Math.max(maxWrist, wristError);
        assert.ok(leg.error < .001, `${id}/${time.toFixed(3)}/${side}: ankle IK error ${leg.error}`);
        assert.ok(arm.reach <= .995001, `${id}/${time.toFixed(3)}/${side}: wrist beyond IK reach ${arm.reach}`);
        // Existing PMX upper-arm/twist helper rest offsets create ~.0342 units
        // of FK residual; do not confuse that measured offset with reach loss.
        assert.ok(wristError < .036, `${id}/${time.toFixed(3)}/${side}: wrist FK residual ${wristError}`);
      }
      count++;
    }
  }
  console.log(JSON.stringify({ acceptance: 'actual-pmx-library-30fps', activities: Object.keys(ACTIVITY_LIBRARY).length,
    samples: count, maximumAnkleError: maxLeg, maximumArmReachRatio: maxReach, maximumWristFkResidual: maxWrist }));
});

test('every ordinary activity completes with declared support; unarranged placement requests fail closed', () => {
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY)) {
    const c = new FullBodyController({ skeleton });
    if (!['put_prop', 'take_prop', 'pickup'].includes(definition.kind)) prepareSource(c, id);
    assert.equal(c.play(id), true);
    if (definition.initialSupport === 'seated') assert.equal(c.activeId, 'sit_down', `${id}: missing sitting prerequisite`);
    for (let frame = 0; frame < 1200 && !c.done; frame++) {
      stepController(c, 1 / 30);
      for (const side of ['L', 'R']) assert.ok(c.diagnostics.legs[side].error < .015, `${id}: transition breaks ground reach`);
    }
    if (definition.kind === 'put_prop' || definition.kind === 'take_prop' || definition.kind === 'pickup' && definition.propId) {
      assert.equal(c.done, false, `${id}: missing object/surface must not count as placed`);
      assert.ok(['place-blocked', 'take-blocked'].includes(c.status));
      assert.ok(c.pose.preparationBlocker, `${id}: blocked placement lacks reason`);
      c.stop(); advance(c, 2); assert.equal(c.done, true); continue;
    }
    assert.equal(c.done, true, `${id}: completion timeout`);
    assert.equal(c.activeId, id, `${id}: stopped at prerequisite`);
    assert.equal(c.pose.support, definition.endSupport, `${id}: final support mismatch`);
    const chair = c.pose.props.chair, chairVisible = typeof chair === 'object' ? chair.visible !== false : chair === true;
    assert.equal(chairVisible, definition.endSupport === 'seated' || definition.requires.includes('chair'), `${id}: chair support missing`);
  }
});

test('real chair interactions retain one anchor, automatically stand before walking, and finish a half-completed seat on stop', () => {
  const c = new FullBodyController({ skeleton }); c.play('sit_down');
  for (let i = 0; i < 360 && (c.pose.pelvis.offset[1] > -2 || c.pose.support === 'seated'); i++) stepController(c, 1 / 60);
  assert.ok(c.pose.pelvis.offset[1] < -2); assert.notEqual(c.pose.support, 'seated');
  c.stop(); assert.equal(c.status, 'seating'); advance(c, 3);
  assert.equal(c.status, 'seated'); const anchor = structuredClone(c.anchor);
  prepareSource(c, 'read_seated'); c.play('read_seated');
  assert.ok(c.activeId === 'read_seated' || c.snapshot().queued === 'read_seated'); advance(c, .6);
  // Finishing the last measured seat velocity may adjust the attained anchor
  // by a sub-millimetre amount; it must not reset to the room origin.
  assert.ok(distance(c.anchor.position, anchor.position) < .002); assert.equal(c.pose.support, 'seated');
  c.play('walk_forward'); assert.equal(c.activeId, 'stand_up'); assert.equal(c.snapshot().queued, 'walk_forward');
  advance(c, 11); assert.equal(c.activeId, 'walk_forward'); assert.equal(c.done, true);
  assert.ok(c.root.position[2] > 12, 'walking must continue beyond the chair rather than returning to its origin');
});

test('real activity interruption at early, middle and late phases settles finitely without stale ownership', () => {
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY)) for (const fraction of [.2, .5, .8]) {
    const c = new FullBodyController({ skeleton }); prepareSource(c, id); c.play(id);
    for (let frame = 0; frame < 1200; frame++) {
      stepController(c, 1 / 30);
      if (c.activeId === id && c.elapsed >= definition.duration * fraction) break;
    }
    c.stop();
    for (let frame = 0; frame < 300 && !c.done; frame++) {
      stepController(c, 1 / 30);
      assert.equal(c.diagnostics.finite, true);
      for (const side of ['L', 'R']) assert.ok(c.diagnostics.legs[side].error < .03, `${id}/${fraction}: cancellation leg reach ${c.diagnostics.legs[side].error}`);
    }
    assert.equal(c.done, true, `${id}/${fraction}: cancellation never settled`);
    assert.equal(c.snapshot().queued, null); assert.ok(['idle', 'seated'].includes(c.status), `${id}/${fraction}: ${c.status}`);
    const after = c.snapshot(); advance(c, .5);
    assert.deepEqual(c.pose, after.pose, `${id}/${fraction}: cancelled clip resurrected`);
  }
});

test('explicit reset clears seated and airborne pending owners without replacing the controller', () => {
  const c = new FullBodyController({ skeleton }), rig = c.rig;
  c.play('read_seated'); advance(c, 6); assert.equal(c.pose.support, 'seated'); c.pause(true); c.reset();
  assert.equal(c.rig, rig); assert.equal(c.paused, false); assert.deepEqual(c.root.position, [0, 0, 0]);
  assert.equal(c.pose.support, 'standing'); assert.deepEqual(c.pose.props, {});
  c.play('jump_forward'); advance(c, 1.7); assert.equal(c.pose.support, 'airborne'); c.play('walk_left');
  assert.equal(c.snapshot().queued, 'walk_left'); c.reset(); const after = c.snapshot(); advance(c, 4);
  assert.deepEqual(c.snapshot(), after); assert.equal(c.activeId, null);
});

test('stopping or replacing a moving desk chair brakes with the seated pelvis and fixed stance feet before read/stand', () => {
  // 4.1 s is already in the seated weight-transfer stage of standing up: its
  // root has begun moving forward, but the seat anchor must remain behind it.
  for (const stopFirst of [true, false]) for (const stopAt of [1.3, 4.1]) {
    const c = new FullBodyController({ skeleton }), props = createActivityProps(new THREE.Scene());
    prepareSource(c, 'read_seated'); c.play('read_seated');
    for (let frame = 0; frame < 1800 && !c.done; frame++) stepController(c, 1 / 30);
    assert.equal(c.done, true, 'moving-chair test must start with a genuinely acquired book');
    const renderProps = () => props.update(c.pose.props, { anchor: c.anchor, root: c.root });
    props.update({ table: true }, { anchor: c.anchor });
    const tableWorld = [...props.snapshot().props.table.position];
    c.play('stand_up_from_desk');
    for (let frame = 0; frame < 900; frame++) {
      stepController(c, 1 / 60); renderProps();
      if (c.activeId === 'stand_up_from_desk' && c.elapsed >= stopAt) break;
    }
    assert.equal(c.pose.support, 'seated'); assert.ok(c.pose.seatOffset[2] < -.5);
    const before = c.snapshot(), chairWorld = [...props.snapshot().props.chair.position];
    const attainedSeat = toWorld(before.anchor, before.pose.seatOffset);
    const initialVelocity = Math.hypot(...(c.velocity.root?.position ?? [0, 0, 0]));
    // The .38-second brake travels .4*T*v; add two 60Hz frames to allow the
    // finite-difference speed estimate. This is not an arbitrary large leash.
    const brakeBound = initialVelocity * (.38 * .4 + 2 / 60) + .002;
    let settledChairWorld = chairWorld;
    if (stopFirst) {
      c.stop(); renderProps();
      assert.equal(c.status, 'seated');
      assert.deepEqual(c.root, before.root); assert.deepEqual(c.pose.feet, before.pose.feet);
      assert.ok(distance(props.snapshot().props.chair.position, chairWorld) < 1e-8, 'holding the moved chair changed its world position');
    }
    c.play('read_seated'); renderProps();
    assert.ok(c.activeId === 'read_seated' || c.snapshot().queued === 'read_seated', 'new reading must own or await necessary chair brake');
    assert.ok(distance(c.anchor.position, attainedSeat) < 1e-8);
    assert.ok(distance(c.root.position, before.root.position) < 1e-8, 'admission reset the avatar to the old table anchor');
    let previousFeet = structuredClone(c.pose.feet), previousRoot = [...c.root.position];
    const initialSeatRelation = (() => {
      const pelvis = toWorld(c.root, c.fk.get(c.rig.support.root).position);
      const chair = props.snapshot().props.chair.position;
      return [pelvis[0] - chair[0], pelvis[2] - chair[2]];
    })();
    for (let frame = 0; frame < 500 && !c.done; frame++) {
      stepController(c, 1 / 60); renderProps();
      const chair = props.snapshot().props.chair.position;
      assert.ok(distance(chair, chairWorld) <= brakeBound, `chair brake exceeded measured-velocity travel bound ${JSON.stringify({ stopFirst, stopAt, frame, initialVelocity, brakeBound, chairWorld, chair, root: c.root, anchor: c.anchor, status: c.status })}`);
      assert.ok(distance(c.root.position, previousRoot) <= (initialVelocity + 1) / 60 + .003, 'chair/reader root snapped during braking');
      for (const side of ['L', 'R']) {
        if (previousFeet[side].contact && c.pose.feet[side].contact) assert.ok(distance(previousFeet[side].position, c.pose.feet[side].position) < 1e-8, 'planted foot slid during chair braking');
        assert.ok(c.diagnostics.legs[side].error < .03, 'chair brake lost actual foot reach');
      }
      if (c.pose.support === 'seated') {
        const pelvis = toWorld(c.root, c.fk.get(c.rig.support.root).position);
        assert.ok(distance([pelvis[0] - chair[0], pelvis[2] - chair[2]], initialSeatRelation) < .03, 'chair moved independently of supported pelvis');
      }
      assert.deepEqual(props.snapshot().props.table.position, tableWorld, 'the table followed the moving chair anchor');
      previousFeet = structuredClone(c.pose.feet); previousRoot = [...c.root.position]; settledChairWorld = [...chair];
    }
    assert.equal(c.done, true); assert.equal(c.pose.support, 'seated');
    assert.equal(c.activeId, 'read_seated');
    const settledPose = structuredClone(c.pose); advance(c, .5); renderProps();
    assert.deepEqual(c.pose, settledPose, 'settled reading moved after completion');
    assert.ok(distance(props.snapshot().props.chair.position, settledChairWorld) < 1e-8);
    const seatAnchor = structuredClone(c.anchor); c.play('stand_up');
    for (let frame = 0; frame < 400 && !c.done; frame++) {
      stepController(c, 1 / 60); renderProps();
      assert.ok(distance(props.snapshot().props.chair.position, settledChairWorld) < 1e-8, 'standing moved the braked chair');
      assert.deepEqual(props.snapshot().props.table.position, tableWorld, 'standing moved the original desk');
    }
    assert.equal(c.done, true); assert.equal(c.pose.support, 'standing');
    const end = sampleActivity('stand_up', ACTIVITY_LIBRARY.stand_up.duration, c.context);
    assert.ok(distance(c.root.position, toWorld(seatAnchor, end.root.position)) < 1e-8);
    props.dispose();
  }
});
