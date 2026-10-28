import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { ActivityDirector, initializeEmptyActivityScene } from '../realtime/activities/director.mjs';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { ACTIVITY_LIBRARY, ACTIVITY_SEQUENCES, sampleActivity } from '../preview/core/activity-library.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { toWorld } from '../preview/core/full-body-ik.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createActivityProps } = await import('../realtime/activities/props.mjs');
hooks.deregister();

// Cross-layer acceptance uses the real catalog, director, body solver and PMX.
// No fake providers, timers, forced support states, or first-three-step shortcut.
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
function makeRun() {
  const body = new FullBodyController({ skeleton }), director = new ActivityDirector(body), props = createActivityProps(new THREE.Scene());
  let wall = 0;
  return { body, director, props, tick() {
    wall += 1 / 30;
    const clock = director.tick(wall);
    body.update(clock.now, clock.dt, { paused: clock.paused });
    const anchors = body.handAnchors();
    props.update(body.pose.props, { anchors: { leftHand: anchors.L, rightHand: anchors.R }, root: body.root,
      anchor: body.pose.anchor ?? body.anchor, pose: body.pose, snapshot: body.snapshot(), time: body.now });
    body.setRenderedPropsSnapshot(props.snapshot());
    body.setPropTransferReceipts(props.snapshot());
    return director.snapshot();
  } };
}
const stepId = value => typeof value === 'string' ? value : value.activity;
function exitColliders(props) {
  const parts = [];
  for (const id of ['table', 'chair']) props.objects[id].traverse(part => {
    if (!part.isMesh || !part.visible) return;
    part.geometry.computeBoundingBox(); part.updateWorldMatrix(true, false);
    parts.push({ id, name: part.name, inverse: part.matrixWorld.clone().invert(), bounds: part.geometry.boundingBox.clone() });
  });
  return parts;
}
function segmentCrosses(start, end, collider) {
  const a = new THREE.Vector3(...start).applyMatrix4(collider.inverse), b = new THREE.Vector3(...end).applyMatrix4(collider.inverse);
  if (collider.bounds.containsPoint(a) || collider.bounds.containsPoint(b)) return true;
  const direction = b.clone().sub(a), length = direction.length();
  if (length < 1e-10) return false;
  const hit = new THREE.Ray(a, direction.divideScalar(length)).intersectBox(collider.bounds, new THREE.Vector3());
  return !!hit && hit.distanceTo(a) <= length + 1e-9;
}
function legExitHits(body, colliders) {
  const hits = [];
  for (const side of ['L', 'R']) {
    const names = body.rig.legs[side].names;
    const points = ['hip', 'knee', 'ankle'].map(key => toWorld(body.root, body.fk.get(names[key]).position));
    for (let segment = 0; segment < 2; segment++) for (const collider of colliders) {
      if (segmentCrosses(points[segment], points[segment + 1], collider)) hits.push({ side, segment, propId: collider.id, part: collider.name });
    }
  }
  return hits;
}
function assertLegExitClear(body, colliders, frame) {
  const hits = legExitHits(body, colliders);
  assert.equal(hits.length, 0, `reading exit frame ${frame}/${body.activeId} crosses actual prop geometry bounds: ${JSON.stringify(hits)}`);
}

assert.equal(Object.keys(ACTIVITY_SEQUENCES).length, 7, 'audit every published continuous sequence');
for (const [id, sequence] of Object.entries(ACTIVITY_SEQUENCES)) {
  test(`real sequence ${id} executes all ${sequence.steps.length} steps and retains its final world state`, () => {
    const run = makeRun(), { body, director } = run, ids = sequence.steps.map(stepId);
    const entered = [], completed = [], doneAtStep = new Set();
    initializeEmptyActivityScene(body, run.props, sequence);
    assert.equal(director.playSequence(id), true, JSON.stringify(director.lastRejection));
    let previousIndex = -1, previousRoot = [...body.root.position], maxFrameTravel = 0, exitSamples = 0, colliders = null;
    for (let frame = 0; frame < 9000 && director.sequence; frame++) {
      const beforeIndex = director.sequence.index;
      if (beforeIndex !== previousIndex) {
        entered.push(beforeIndex); previousIndex = beforeIndex;
      }
      run.tick();
      assert.equal(body.diagnostics.finite, true, `${id}: non-finite bones`);
      for (const side of ['L', 'R']) assert.ok(body.diagnostics.legs[side].error < .03,
        `${id}/${beforeIndex}/${side}: world ankle error ${body.diagnostics.legs[side].error}`);
      const travel = distance(body.root.position, previousRoot);
      maxFrameTravel = Math.max(maxFrameTravel, travel);
      // Larger running clips may travel .4 units per 30Hz frame. This rejects
      // world-origin resets while allowing the authored physical displacement.
      assert.ok(travel < 1.2, `${id}/${beforeIndex}: root teleported ${travel}`);
      previousRoot = [...body.root.position];
      const currentIndex = director.sequence?.index;
      if (id === 'reading_break' && currentIndex !== undefined && currentIndex >= 9) {
        colliders ??= exitColliders(run.props); assertLegExitClear(body, colliders, frame); exitSamples++;
      }
      if (currentIndex !== undefined && body.done && body.activeId === ids[currentIndex] && !doneAtStep.has(currentIndex)) {
        doneAtStep.add(currentIndex);
        const definition = ACTIVITY_LIBRARY[ids[currentIndex]], final = sampleActivity(ids[currentIndex], definition.duration, body.sampleContext);
        const expectedRoot = toWorld(body.anchor, final.root.position);
        assert.equal(body.pose.support, definition.endSupport, `${id}/${currentIndex}: wrong final support`);
        assert.ok(distance(body.root.position, expectedRoot) < 1e-7, `${id}/${currentIndex}: lost root displacement`);
        assert.ok(Math.abs(body.root.yaw - body.anchor.yaw - final.root.yaw) < 1e-7, `${id}/${currentIndex}: lost final turn`);
        completed.push({ step: currentIndex + 1, activity: body.activeId, at: director.time,
          root: structuredClone(body.root), anchor: structuredClone(body.anchor), support: body.pose.support,
          transfer: body.transferOperation(definition) ? structuredClone(body.propTransferReceipts[definition.propId]) : null });
        if (body.transferOperation(definition)) {
          assert.equal(body.propTransferReceipts[definition.propId]?.released, true, 'placement completed without actual renderer handoff');
          assert.equal(body.propTransferReceipts[definition.propId]?.operation, body.transferOperation(definition));
          assert.ok(body.transferOperation(definition) === 'place' ? run.props.snapshot().props[definition.propId].attachment === 'table'
            : ['left', 'right', 'both'].includes(run.props.snapshot().props[definition.propId].attachment));
        }
      }
    }
    assert.equal(director.sequence, null, `${id}: sequence did not end within 300 simulated seconds`);
    assert.equal(body.done, true); assert.equal(body.activeId, ids.at(-1));
    assert.deepEqual(entered, ids.map((_, index) => index), `${id}: skipped or resurrected sequence step`);
    assert.deepEqual(completed.map(item => item.activity), ids, `${id}: incomplete step, including a prerequisite falsely treated as completion`);
    const events = director.snapshot().events;
    assert.deepEqual(events.filter(event => event.type === 'step').map(event => event.id), ids.slice(1));
    assert.equal(events.filter(event => event.type === 'sequence-ended' && event.id === id).length, 1);
    assert.equal(events.filter(event => event.type === 'sequence-rejected').length, 0);
    const finalPose = structuredClone(body.pose), finalRoot = structuredClone(body.root), generation = director.generation;
    for (let frame = 0; frame < 150; frame++) run.tick();
    assert.deepEqual(body.pose, finalPose, `${id}: old activity resumed after sequence end`);
    assert.deepEqual(body.root, finalRoot); assert.equal(director.generation, generation);
    assert.equal(director.sequence, null);
    if (id === 'reading_break') {
      assert.equal(completed.length, 12);
      const at = activity => completed.find(step => step.activity === activity);
      assert.deepEqual(at('read_seated').anchor, at('page_turn_seated').anchor, 'turning a page changed chair anchor');
      assert.deepEqual(at('page_turn_seated').anchor, at('close_book').anchor, 'later reading steps changed chair anchor');
      assert.equal(ids[2], 'take_book_seated', 'book must be genuinely acquired before reading');
      assert.equal(ids[7], 'put_book_seated', 'read sequence must place its book before rising');
      assert.equal(ids[8], 'stand_up_from_desk', 'read sequence must move the chair clear of the desk before rising');
      assert.equal(sequence.steps[8].context.deskRetreat, 7, 'reading uses the separately verified farther chair retreat');
      assert.deepEqual(ids.slice(9), ['walk_left', 'turn_around', 'walk_forward'], 'exit must route around the retained table and chair');
      assert.ok(distance(at('stand_up_from_desk').root.position, [0, 0, -2.594705891609192]) < 1e-7);
      assert.ok(distance(at('walk_left').root.position, [10, 0, -2.594705891609192]) < 1e-7);
      assert.ok(distance(finalRoot.position, [10, 0, -20.594705891609192]) < 1e-7);
      assert.ok(Math.abs(finalRoot.yaw - Math.PI) < 1e-7); assert.ok(exitSamples > 300, 'exit path was not actually sampled');
    }
    if (id === 'quiet_afternoon') {
      assert.equal(body.pose.support, 'seated'); assert.equal(body.pose.props.chair, true);
    }
    if (id === 'desk_session') {
      assert.equal(ids.at(-1), 'stand_up_from_desk', 'desk exit must retreat the chair before standing');
      assert.equal(body.pose.support, 'standing');
      assert.ok(Math.abs(finalRoot.position[2] + 2.594705891609192) < 1e-7, 'desk exit lost the measured 7-unit chair retreat');
      assert.ok(Math.abs(run.props.snapshot().props.chair.position[2] + 8.2) < 1e-7, 'desk chair did not remain at its attained pull-out location');
      assert.equal(Object.hasOwn(body.pose.props, 'table'), false, 'desk exit must not relocate the persistent table');
    }
    console.log(JSON.stringify({ acceptance: 'whole-real-sequence', id, steps: completed,
      simulatedSeconds: completed.at(-1).at, maximumRootTravelPer30HzFrame: maxFrameTravel, exitSamples }));
    run.props.dispose();
  });
}

test('director interruption during a real sequence jump retires all remaining steps and lets the body land', () => {
  const run = makeRun(), { body, director } = run;
  assert.equal(director.playSequence('agility_practice'), true);
  let airborne = false;
  for (let frame = 0; frame < 5000; frame++) {
    run.tick();
    if (body.activeId === 'jump_forward' && body.pose.support === 'airborne') { airborne = true; break; }
  }
  assert.equal(airborne, true, 'test must reach the actual penultimate jump, not force airborne state');
  assert.equal(director.sequence.index, 6);
  const before = body.snapshot(), generation = director.generation;
  const stepsBefore = director.events.filter(event => event.type === 'step').length;
  director.stop();
  assert.equal(director.sequence, null); assert.equal(director.generation, generation + 1);
  assert.equal(body.status, 'landing'); assert.deepEqual(body.root, before.root, 'stop teleported the airborne root');
  for (let frame = 0; frame < 300 && !body.done; frame++) {
    run.tick();
    for (const side of ['L', 'R']) assert.ok(body.diagnostics.legs[side].error < .03, `landing broke ${side} ankle target`);
  }
  assert.equal(body.done, true); assert.equal(body.status, 'idle'); assert.equal(body.pose.support, 'standing');
  assert.equal(body.activeId, null); assert.equal(body.snapshot().queued, null);
  assert.ok(Math.abs(body.root.position[1] - body.anchor.position[1]) < 1e-7);
  const landed = structuredClone(body.pose);
  for (let frame = 0; frame < 300; frame++) run.tick();
  assert.equal(director.sequence, null); assert.deepEqual(body.pose, landed);
  assert.equal(director.events.filter(event => event.type === 'step').length, stepsBefore, 'cancelled balance step was dispatched');
  assert.equal(director.events.some(event => event.type === 'sequence-ended'), false, 'cancel must not masquerade as natural completion');
  run.props.dispose();
});

test('the exit clearance probe detects an unsafe straight walk through the retained tabletop', () => {
  const run = makeRun(), { body, director } = run; initializeEmptyActivityScene(body, run.props, ACTIVITY_SEQUENCES.reading_break);
  assert.equal(director.playSequence('reading_break'), true, JSON.stringify(director.lastRejection));
  for (let frame = 0; frame < 9000; frame++) {
    run.tick();
    if (director.sequence?.index === 8 && body.activeId === 'stand_up_from_desk' && body.done) break;
  }
  assert.equal(director.sequence.index, 8); assert.equal(body.done, true);
  const colliders = exitColliders(run.props).filter(part => part.id === 'table');
  const before = body.snapshot(), admission = body.routeAdmission('walk_forward');
  assert.equal(admission.accepted, false); assert.equal(admission.obstacle, 'table');
  assert.equal(body.play('walk_forward'), false); assert.deepEqual(body.snapshot(), before);
  // The negative control uses a detached source-only probe, never bypasses the live guard.
  const probe = body.preparationProbe(); probe.start({ id: 'walk_forward', options: { speed: 1, loop: false, context: {} } });
  let detected = null;
  for (let frame = 0; frame < 1000 && !probe.done; frame++) {
    probe.update(probe.now + 1 / 30, 1 / 30); const hits = legExitHits(probe, colliders);
    if (hits.length) { detected = { frame, hits, root: structuredClone(probe.root) }; break; }
  }
  assert.ok(detected, 'collision regression would fail to detect the former straight exit');
  console.log(JSON.stringify({ acceptance: 'unsafe-exit-negative-control', ...detected }));
  run.props.dispose();
});
