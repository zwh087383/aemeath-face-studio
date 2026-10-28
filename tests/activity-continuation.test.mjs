import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIVITY_LIBRARY, sampleActivity } from '../preview/core/activity-library.js';
import { createActivityContinuation, sampleActivityContinuation, releaseActivityContinuation } from '../preview/core/activity-continuation.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { enforceActivityPropContacts } from '../preview/core/activity-prop-execution.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const fresh = () => new FullBodyController({ skeleton });
const advance = (c, seconds) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) c.update(c.now + 1 / 60, 1 / 60); };
const context = { deskLayout: 'partitioned' };
const geometry = pose => { const p = structuredClone(pose); for (const key of ['time', 'duration', 'done', 'terminal', 'continuation']) delete p[key]; return p; };
function closeGeometry(a, b, message) {
  if (typeof a === 'number' && typeof b === 'number') { assert.ok(Math.abs(a - b) < 1e-10, message); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a), Object.keys(b), message);
    for (const key of Object.keys(a)) closeGeometry(a[key], b[key], `${message}.${key}`);
  } else assert.deepEqual(a, b, message);
}
const numeric = value => typeof value === 'number' ? [value] : Array.isArray(value) ? value.flatMap(numeric)
  : value && typeof value === 'object' ? Object.values(value).flatMap(numeric) : [];
const values = p => numeric({ body: p.body, hands: p.hands, pelvis: p.pelvis, root: p.root, props: p.props, plans: p.propContactPlans });

test('all 76 default activities use their source sampler unchanged', () => {
  assert.equal(Object.keys(ACTIVITY_LIBRARY).length, 76);
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY)) {
    const plan = createActivityContinuation(definition);
    assert.equal(plan, null);
    for (const t of [0, definition.duration * .37, definition.duration]) {
      assert.deepEqual(sampleActivityContinuation(plan, t, time => sampleActivity(id, time, context)), sampleActivity(id, t, context), `${id} at ${t}`);
    }
  }
});

test('each declared working middle preserves exact source entry and exit at irregular durations', () => {
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY).filter(([, d]) => d.continuation)) {
    for (const extra of [.13, 17.37]) {
      const plan = createActivityContinuation(definition, { targetDuration: definition.duration + extra });
      const sample = t => sampleActivity(id, t, context), final = t => sampleActivityContinuation(plan, t, sample);
      for (const t of [0, .5, plan.start]) assert.deepEqual(geometry(final(t)), geometry(sample(t)), `${id}: entry ${t}`);
      for (const t of [plan.end, (plan.end + definition.duration) / 2, definition.duration]) {
        closeGeometry(geometry(final(t + extra)), geometry(sample(t)), `${id}: exit ${t}`);
      }
      assert.equal(final(plan.duration - .01).done, false); assert.equal(final(plan.duration).done, true);
    }
  }
});

test('overlapped middle loops and arbitrary exit seams preserve pose and velocity, including contact targets', () => {
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY).filter(([, d]) => d.continuation)) {
    const plan = createActivityContinuation(definition, { targetDuration: definition.duration + 17.37 }), h = 1e-5;
    const sample = t => values(sampleActivityContinuation(plan, t, time => sampleActivity(id, time, context)));
    const seam = plan.end - plan.blend, period = plan.end - plan.start - plan.blend;
    const tailStart = plan.duration - (definition.duration - plan.end);
    for (const t of [seam, seam + plan.blend, seam + period, seam + period + plan.blend, tailStart - plan.blend, tailStart]) {
      const a = sample(t - h), b = sample(t), c = sample(t + h);
      assert.equal(a.length, c.length);
      for (let i = 0; i < b.length; i++) {
        assert.ok(Math.abs(a[i] - c[i]) < .001, `${id} C0 ${t} channel ${i}`);
        assert.ok(Math.abs((b[i] - a[i]) / h - (c[i] - b[i]) / h) < .025, `${id} C1 ${t} channel ${i}`);
      }
    }
  }
});

test('long typing opens once, works with the lid open, then closes once at source speed', () => {
  const definition = ACTIVITY_LIBRARY.type_at_desk, plan = createActivityContinuation(definition, { targetDuration: 31.37 });
  const sample = t => sampleActivityContinuation(plan, t, time => sampleActivity('type_at_desk', time, context));
  assert.equal(sample(0).props.laptop.openness, 0);
  const tailStart = plan.duration - (definition.duration - plan.end);
  for (let t = 2; t < tailStart; t += .07) assert.equal(sample(t).props.laptop.openness, 1, `lid at ${t}`);
  for (let t = 6.4; t <= 8; t += .1) assert.ok(Math.abs(sample(t + 23.37).props.laptop.openness - sampleActivity('type_at_desk', t, context).props.laptop.openness) < 1e-10);
  assert.ok(sample(plan.duration).props.laptop.openness < 1e-12);
});

test('holding retains source object events and release allocates a complete exit', () => {
  const d = ACTIVITY_LIBRARY.study_at_desk, plan = createActivityContinuation(d, { hold: true });
  const sample = t => sampleActivityContinuation(plan, t, time => sampleActivity('study_at_desk', time, context));
  const afterTurn = sample(4.5).props.book;
  assert.equal(afterTurn.pageTurn, 1);
  for (const t of [15, 37, 89]) {
    assert.equal(sample(t).done, false);
    assert.equal(sample(t).props.book.pageTurn, 1);
    assert.equal(sample(t).props.book.attachment, afterTurn.attachment);
  }
  assert.equal(releaseActivityContinuation(plan, 89), true);
  assert.ok(plan.duration >= 89 + plan.blend + d.duration - plan.end);
  assert.equal(sample(plan.duration).done, true);
  assert.equal(releaseActivityContinuation(plan, 90), false);
});

test('micro variation never uncurls a holding or surface-contact hand', () => {
  for (const id of ['read_seated', 'write_at_desk', 'type_at_desk']) {
    const d = ACTIVITY_LIBRARY[id], plain = createActivityContinuation(d, { targetDuration: 25 }), micro = createActivityContinuation(d, { targetDuration: 25, microSet: ['gaze_shift', 'finger_release'] });
    const sampler = t => sampleActivity(id, t, context), a = sampleActivityContinuation(plain, 12.1, sampler), b = sampleActivityContinuation(micro, 12.1, sampler);
    assert.equal(a.hands.R.curl, b.hands.R.curl, id);
    assert.ok(b.continuation.micro.suppressed.includes('finger_release:R:contact'));
    assert.notEqual(a.body.gazeYaw ?? 0, b.body.gazeYaw);
  }
});

function seatedController() {
  const c = fresh(), pose = sampleActivity('sit_relax', 2, c.context);
  assert.equal(c.adoptSupportedState({ pose, sceneProps: { chair: { visible: true }, table: { visible: true } } }), true);
  return c;
}

test('attention keeps a typing task and its open laptop; only a matching explicit resume advances it', () => {
  const c = seatedController();
  assert.equal(c.play('type_at_desk', { hold: true, context }), true); advance(c, 3.5);
  assert.equal(c.pose.props.laptop.openness, 1);
  const revision = c.revision, feet = structuredClone(c.pose.feet), pelvis = structuredClone(c.pose.pelvis);
  assert.equal(c.pauseForAttention({ id: 'user-voice-1' }), true); advance(c, 1.7);
  const pausedTime = c.elapsed; advance(c, 2);
  assert.ok(c.elapsed - pausedTime < 1e-6); assert.equal(c.snapshot().status, 'attention-paused');
  assert.equal(c.pose.props.laptop.openness, 1); assert.deepEqual(c.pose.feet, feet); assert.deepEqual(c.pose.pelvis, pelvis);
  assert.ok(c.snapshot().pose.body.headPitch < c.pose.body.headPitch);
  assert.equal(c.resumeFromAttention('older-voice'), false);
  assert.equal(c.resumeFromAttention('user-voice-1'), true); advance(c, 1.2);
  assert.ok(c.elapsed > pausedTime + .9); assert.equal(c.revision, revision); assert.equal(c.pose.props.laptop.openness, 1);
  assert.equal(c.snapshot().attention, null);
});

test('a stop while attention-paused invalidates resume, keeps seat and prop ownership, and can safely play a new activity', () => {
  const c = seatedController(); c.play('type_at_desk', { hold: true, context }); advance(c, 3.5);
  assert.equal(c.pauseForAttention({ id: 'call' }), true); advance(c, 1);
  c.stop(); advance(c, 1);
  assert.equal(c.resumeFromAttention('call'), false); assert.equal(c.done, true); assert.equal(c.pose.support, 'seated');
  assert.equal(c.pose.props.laptop.openness, 1);
  const stopped = c.elapsed; advance(c, 2); assert.equal(c.elapsed, stopped);
  assert.equal(c.play('sit_relax'), true); advance(c, 1); assert.equal(c.activeId, 'sit_relax');
});

test('duration options preserve default speed and reject unsupported or shorter actions without disturbing owner', () => {
  const c = seatedController(); c.play('sit_relax', { speed: .7 }); assert.equal(c.speed, .7);
  const id = c.activeId, revision = c.revision;
  assert.equal(c.play('jump_vertical', { targetDuration: 20 }), false);
  assert.equal(c.play('type_at_desk', { targetDuration: 2 }), false);
  assert.equal(c.play('sit_relax', { microSet: ['invented-semantic-action'] }), false);
  assert.equal(c.activeId, id); assert.equal(c.revision, revision);
  assert.equal(c.play('sit_relax', { targetDuration: 20, speed: .7 }), true); assert.equal(c.speed, 1);
});

test('explicit finish during attention exits without reopening the laptop or allowing a stale resume', () => {
  const c = seatedController(); c.play('type_at_desk', { hold: true, context }); advance(c, 3.5);
  c.pauseForAttention({ id: 'interruption' }); advance(c, 1.5);
  const oldHead = c.snapshot().pose.body.headPitch;
  assert.equal(c.releaseHold(), true); assert.equal(c.resumeFromAttention('interruption'), false);
  c.update(c.now + 1 / 60, 1 / 60);
  assert.ok(Math.abs(c.snapshot().pose.body.headPitch - oldHead) < .01);
  let lastOpenness = 1;
  for (let i = 0; i < 300 && !c.done; i++) {
    c.update(c.now + 1 / 60, 1 / 60);
    assert.ok(c.pose.props.laptop.openness <= lastOpenness + 1e-9);
    lastOpenness = c.pose.props.laptop.openness;
  }
  assert.equal(c.done, true); assert.ok(lastOpenness < 1e-10); assert.equal(c.snapshot().attention, null);
});

test('read pause preserves the measured held book and resumes the same acquisition epoch', () => {
  const c = fresh(), initial = sampleActivity('read_seated', 3, c.context);
  initial.propContacts = enforceActivityPropContacts(c.rig, initial);
  assert.equal(initial.propContacts.ready, true);
  assert.equal(c.adoptSupportedState({ pose: initial, sceneProps: { chair: { visible: true } } }), true);
  assert.equal(c.play('read_seated', { hold: true }), true); advance(c, 3.5);
  const revision = c.revision;
  assert.equal(c.activeId, 'read_seated'); assert.equal(c.pauseForAttention({ id: 'reader-called' }), true); advance(c, 1.5);
  const book = structuredClone(c.pose.props.book.worldTransform), elapsed = c.elapsed;
  for (let i = 0; i < 90; i++) {
    c.update(c.now + 1 / 60, 1 / 60);
    assert.equal(c.pose.props.book.attachment, 'both'); assert.equal(c.snapshot().diagnostics.propContacts.ready, true);
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(c.pose.props.book.worldTransform.position[axis] - book.position[axis]) < .001);
  }
  assert.ok(c.elapsed - elapsed < 1e-6);
  assert.equal(c.resumeFromAttention('reader-called'), true); advance(c, 1);
  assert.equal(c.revision, revision); assert.equal(c.activeId, 'read_seated'); assert.equal(c.afterPrerequisite, null);
  assert.equal(c.pose.props.book.attachment, 'both');
});

test('read-only duration preparation reserves the actual entry bridge and refuses an impossible range atomically', () => {
  const c = seatedController(), before = structuredClone(c.snapshot()), locals = structuredClone([...c.locals]);
  const range = c.preparePlay('type_at_desk', { totalSeconds: [8, 8.1], context });
  assert.equal(range.accepted, false); assert.equal(range.reason, 'unreachable_total_duration');
  assert.ok(range.minimumSeconds >= 8.42);
  assert.deepEqual(c.snapshot(), before); assert.deepEqual([...c.locals], locals);
  const scalar = c.preparePlay('type_at_desk', { totalSeconds: 8, context });
  assert.equal(scalar.accepted, true); assert.equal(scalar.exact, false); assert.ok(scalar.totalSeconds >= 8.42);
  const prepared = c.preparePlay('type_at_desk', { totalSeconds: [18.21, 19.29], durationChoice: .25, context });
  assert.equal(prepared.accepted, true); assert.equal(prepared.exact, true);
  assert.ok(Math.abs(prepared.totalSeconds - 18.48) < 1e-9); assert.deepEqual(c.snapshot(), before);
  assert.equal(c.play('type_at_desk', prepared.options), true);
  assert.equal(c.bridge.duration, prepared.entrySeconds); assert.equal(c.duration, prepared.bodySeconds);
  assert.ok(Math.abs(c.bridge.duration + c.duration - prepared.totalSeconds) < 1e-9);
});

test('read-only preparation can evaluate a measured adoption without replacing a live activity or retaining its attention object', () => {
  const c = seatedController(); c.play('type_at_desk', { hold: true, context }); advance(c, 3.5);
  c.pauseForAttention({ id: 'keep-live-task' }); advance(c, 1);
  const before = structuredClone(c.snapshot()), overlay = c.attentionOverlay;
  const prepared = c.preparePlay('sit_relax', { totalSeconds: [10, 12] });
  assert.equal(prepared.accepted, true); assert.deepEqual(c.snapshot(), before); assert.equal(c.attentionOverlay, overlay);
  const standing = fresh(), seated = sampleActivity('sit_relax', 2, standing.context), old = structuredClone(standing.snapshot());
  const captured = standing.preparePlay('type_at_desk', { totalSeconds: [10, 12], context }, { adopt: { pose: seated, sceneProps: { chair: { visible: true }, table: { visible: true } } } });
  assert.equal(captured.accepted, true); assert.deepEqual(standing.snapshot(), old); assert.equal(standing.pose.support, 'standing');
});

test('explicit finish of a finite extended task uses its original exit and closes the laptop exactly once', () => {
  const c=seatedController();c.play('type_at_desk',{targetDuration:90,context});advance(c,12.7);
  assert.equal(c.pose.props.laptop.openness,1);c.pauseForAttention({id:'finite-work-paused'});advance(c,1.5);
  const before=structuredClone(c.snapshot().pose),time=c.elapsed;
  assert.equal(c.releaseHold(),true);assert.ok(c.duration<90);assert.ok(c.duration>=time+c.continuation.blend+c.continuation.sourceDuration-c.continuation.end);
  assert.equal(c.resumeFromAttention('finite-work-paused'),false);
  c.update(c.now+1/60,1/60);assert.ok(Math.abs(c.snapshot().pose.body.headPitch-before.body.headPitch)<.01);
  let openness=1;
  for(let i=0;i<360&&!c.done;i++){c.update(c.now+1/60,1/60);assert.ok(c.pose.props.laptop.openness<=openness+1e-9);openness=c.pose.props.laptop.openness;}
  assert.equal(c.done,true);assert.ok(openness<1e-10);assert.equal(c.activeId,'type_at_desk');assert.equal(c.stopMode,null);
});
