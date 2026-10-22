import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ActivityDirector } from '../realtime/activities/director.mjs';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { ACTIVITY_LIBRARY, ACTIVITY_SEQUENCES, sampleActivity } from '../preview/core/activity-library.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { toWorld } from '../preview/core/full-body-ik.js';

// Cross-layer acceptance uses the real catalog, director, body solver and PMX.
// No fake providers, timers, forced support states, or first-three-step shortcut.
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
function makeRun() {
  const body = new FullBodyController({ skeleton }), director = new ActivityDirector(body);
  let wall = 0;
  return { body, director, tick() {
    wall += 1 / 30;
    const clock = director.tick(wall);
    body.update(clock.now, clock.dt, { paused: clock.paused });
    return director.snapshot();
  } };
}
const stepId = value => typeof value === 'string' ? value : value.activity;

assert.equal(Object.keys(ACTIVITY_SEQUENCES).length, 7, 'audit every published continuous sequence');
for (const [id, sequence] of Object.entries(ACTIVITY_SEQUENCES)) {
  test(`real sequence ${id} executes all ${sequence.steps.length} steps and retains its final world state`, () => {
    const run = makeRun(), { body, director } = run, ids = sequence.steps.map(stepId);
    const entered = [], completed = [], doneAtStep = new Set();
    assert.equal(director.playSequence(id), true);
    let previousIndex = -1, previousRoot = [...body.root.position], maxFrameTravel = 0;
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
      if (currentIndex !== undefined && body.done && body.activeId === ids[currentIndex] && !doneAtStep.has(currentIndex)) {
        doneAtStep.add(currentIndex);
        const definition = ACTIVITY_LIBRARY[ids[currentIndex]], final = sampleActivity(ids[currentIndex], definition.duration, body.context);
        const expectedRoot = toWorld(body.anchor, final.root.position);
        assert.equal(body.pose.support, definition.endSupport, `${id}/${currentIndex}: wrong final support`);
        assert.ok(distance(body.root.position, expectedRoot) < 1e-7, `${id}/${currentIndex}: lost root displacement`);
        assert.ok(Math.abs(body.root.yaw - body.anchor.yaw - final.root.yaw) < 1e-7, `${id}/${currentIndex}: lost final turn`);
        completed.push({ step: currentIndex + 1, activity: body.activeId, at: director.time,
          root: structuredClone(body.root), anchor: structuredClone(body.anchor), support: body.pose.support });
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
      assert.equal(completed.length, 8);
      assert.deepEqual(completed[2].anchor, completed[3].anchor, 'turning a page changed chair anchor');
      assert.deepEqual(completed[3].anchor, completed[5].anchor, 'later reading steps changed chair anchor');
      assert.ok(finalRoot.position[2] > 25, 'read/stand/walk must retain the first walk displacement');
    }
    if (id === 'quiet_afternoon') {
      assert.equal(body.pose.support, 'seated'); assert.equal(body.pose.props.chair, true);
    }
    if (id === 'desk_session') {
      assert.equal(ids.at(-1), 'stand_up_from_desk', 'desk exit must retreat the chair before standing');
      assert.equal(body.pose.support, 'standing');
      assert.ok(finalRoot.position[2] > .8 && finalRoot.position[2] < 1.1, 'desk exit lost the 3.5-unit chair retreat');
      assert.ok(body.pose.props.chair.position[2] < -4.6, 'desk chair did not remain behind the table');
      assert.equal(Object.hasOwn(body.pose.props, 'table'), false, 'desk exit must not relocate the persistent table');
    }
    console.log(JSON.stringify({ acceptance: 'whole-real-sequence', id, steps: completed,
      simulatedSeconds: completed.at(-1).at, maximumRootTravelPer30HzFrame: maxFrameTravel }));
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
});
