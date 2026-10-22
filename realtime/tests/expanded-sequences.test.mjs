import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerformanceDirector, STORIES, performanceSteps } from '../performance/director.mjs';
import { EXPANDED_STORIES } from '../performance/expanded-sequences.mjs';
import { FaceController } from '../../preview/core/controller.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json', import.meta.url))));
function fixture() {
  const motion = new MotionController({ skeleton, seed: 724 }), face = new FaceController();
  face.headSway = false;
  const director = new PerformanceDirector({ motion, face }), events = [];
  const record = director.record.bind(director);
  director.record = (type, details) => { events.push({ type, at: director.now, ...details }); record(type, details); };
  let wall = 0;
  const frame = () => {
    const { now, dt } = director.tick(wall);
    face.update(now, dt, null, !director.paused, { mouthMode: 'expression', paused: director.paused });
    motion.update(now, dt, { face: face.head, actions: face.activeActions, speech: 0, paused: director.paused });
  };
  const advance = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) { wall += 1 / 60; frame(); } };
  const until = (predicate, seconds = 100) => {
    for (let i = 0; i < seconds * 60; i++) { if (predicate()) return; advance(1 / 60); }
    assert.fail(`condition not reached after ${seconds}s; ${JSON.stringify(director.snapshot())}`);
  };
  frame();
  return { motion, face, director, events, frame, advance, until };
}

test('expanded catalog has sixteen finite authored scenes and resolves every body/face/action cue', () => {
  assert.equal(Object.keys(EXPANDED_STORIES).length, 16);
  for (const [id, story] of Object.entries(EXPANDED_STORIES)) {
    assert.equal(STORIES[id], story);
    assert.ok(performanceSteps(story), `${id}: every cue resolves before playback`);
    assert.ok(story.durationHint >= 15 && story.durationHint <= 60);
    assert.equal(story.maxCycles, 2);
    assert.ok(story.steps.some(step => step.rest > 0));
    assert.ok(story.steps.some(step => !step.gesture && step.duration >= 1));
  }
  for (const steps of [[], [{ gesture: '__proto__' }], [{ delay: NaN }], [{ face: { preset: 'smile', intensity: Infinity } }],
    [{ action: { action: 'nod', duration: 31 } }], [{ face: { preset: 'smile', offset: 61 } }]]) {
    assert.equal(performanceSteps({ steps }), null);
  }
});

test('all expanded scenes finish in a bounded duration with actual expressions, rests and finite bone transforms', () => {
  const measured = [];
  for (const [id, story] of Object.entries(EXPANDED_STORIES)) {
    const f = fixture(), expressionFrames = new Set(); let rests = 0;
    assert.equal(f.director.playStory(id, false), true, id);
    const started = f.director.now;
    for (let i = 0; f.director.story && i < 90 * 60; i++) {
      const before = f.events.filter(event => event.type === 'gesture').length;
      f.advance(1 / 60);
      assert.ok(f.events.filter(event => event.type === 'gesture').length - before <= 1, `${id}: at most one start per frame`);
      if (f.director.snapshot().sequence?.phase === 'rest') rests++;
      if (f.face.snapshot().executedCues.some(cue => cue.kind === 'expression')) expressionFrames.add(f.face.activePreset);
      if (i % 60 === 0) assert.ok([...f.motion.locals.values()].flatMap(q => [...q]).every(Number.isFinite), id);
    }
    assert.equal(f.director.story, null, id);
    assert.deepEqual(f.events.filter(event => event.type === 'step').map(event => event.step), story.steps.map((_, i) => i), id);
    assert.deepEqual(f.events.filter(event => event.type === 'gesture').map(event => event.gesture), story.gestures, id);
    assert.ok(expressionFrames.size >= 2, `${id}: expressions must actually enter composition`);
    assert.ok(rests > 20, `${id}: visible rests`);
    assert.equal(f.motion.pending.length, 0); assert.equal(f.face.cues.length, 0);
    assert.equal(f.motion.gestures.length, 0, `${id}: final gesture finishes before scene completion`);
    measured.push({ id, seconds: +(f.director.now - started).toFixed(2) });
    assert.ok(f.director.now - started >= 15 && f.director.now - started <= 65, `${id}: useful finite scene duration`);
    assert.ok(Math.abs(f.director.now - started - story.durationHint) < 1, `${id}: duration hint follows measured full playback`);
  }
  console.log('Measured scene durations at speed 1:', JSON.stringify(measured));
});

for (const phase of ['delay', 'playing', 'rest']) {
  test(`pause freezes ${phase}, expression, head and body without clock catch-up`, () => {
    const f = fixture(); f.director.playStory('first_meeting', false);
    f.until(() => f.director.snapshot().sequence?.phase === phase);
    if (phase === 'playing') f.advance(.2);
    f.director.pause(); f.frame();
    const time = f.director.now, sequence = f.director.snapshot().sequence;
    const weights = [...f.face.weights], head = { ...f.face.head }, bones = [...f.motion.locals].map(([name, q]) => [name, [...q]]);
    f.advance(4);
    assert.equal(f.director.now, time); assert.deepEqual(f.director.snapshot().sequence, sequence);
    assert.deepEqual([...f.face.weights], weights); assert.deepEqual(f.face.head, head);
    assert.deepEqual([...f.motion.locals].map(([name, q]) => [name, [...q]]), bones);
    f.director.pause(); f.advance(.1);
    assert.ok(Math.abs(f.director.now - time - .1) < 1e-8);
    f.until(() => !f.director.story);
  });
}

for (const phase of ['delay', 'rest', 'prepare', 'stroke', 'hold', 'recover']) {
  test(`stop during ${phase} drops every future cue and retracts from the current pose`, () => {
    const f = fixture(); f.director.playStory('first_meeting', true);
    f.until(() => ['delay', 'rest'].includes(phase) ? f.director.snapshot().sequence?.phase === phase
      : f.motion.snapshot().gestures.some(g => g.id === f.director.activeId && g.phase === phase));
    const old = f.director.epoch, count = f.events.filter(event => event.type === 'step').length;
    const before = [...f.motion.locals].map(([name, q]) => [name, [...q]]);
    f.director.stop();
    assert.deepEqual([...f.motion.locals].map(([name, q]) => [name, [...q]]), before, 'stop captures, not snaps, the pose');
    assert.equal(f.face.cues.length, 0); assert.equal(f.motion.pending.length, 0);
    f.advance(6);
    assert.equal(f.director.story, null); assert.equal(f.director.sequence, null);
    assert.equal(f.events.filter(event => event.type === 'step').length, count);
    assert.equal(f.motion.gestures.length, 0); assert.equal(f.face.cues.length, 0);
    assert.equal(f.motion.playback(old, 'playing', 20), false);
    assert.equal(f.face.playback(old, 'playing', 20), false);
  });
}

test('manual body, expression and head action overrides invalidate future sequence cues and prior epochs', () => {
  for (const override of [f => f.director.play('comfort'), f => f.director.playExpression('grateful', .7),
    f => f.director.playAction('acknowledge', { intensity: .6 })]) {
    const f = fixture(); f.director.playStory('quiet_company', false); f.advance(.8);
    assert.ok(f.face.cues.some(cue => cue.at > f.face.time), 'there is an actual future micro cue to cancel');
    const old = f.director.epoch, count = f.events.filter(event => event.type === 'step').length;
    assert.equal(override(f), true); assert.ok(f.director.epoch > old);
    f.advance(10);
    assert.equal(f.director.story, null); assert.equal(f.director.sequence, null);
    assert.equal(f.events.filter(event => event.type === 'step').length, count);
    assert.equal(f.face.cues.some(cue => cue.epoch === old), false);
    assert.equal(f.motion.playback(old, 'playing', 20), false);
    assert.equal(f.face.playback(old, 'playing', 20), false);
  }
});

test('an external newer audio epoch prevents a sleeping sequence from waking or cancelling that owner', () => {
  const f = fixture(); f.director.playStory('quiet_company', false); f.advance(.1);
  const old = f.director.epoch, next = old + 1;
  f.face.begin(next); f.motion.begin(next); f.advance(3);
  assert.equal(f.director.story, null); assert.equal(f.director.sequence, null);
  assert.equal(f.face.epoch, next); assert.equal(f.motion.epoch, next);
  assert.equal(f.face.active, true); assert.equal(f.motion.active, true);
  assert.equal(f.events.some(event => event.type === 'step'), false);
});

test('expanded repeat is finite and finishes the last body recovery before the next cycle', () => {
  const f = fixture(); f.director.playStory('first_meeting', true);
  let seenCycle = 1, lastFinalCue = null;
  f.until(() => {
    const sequence = f.director.snapshot().sequence;
    if (sequence && sequence.step === sequence.total) lastFinalCue = f.director.activeId;
    if (sequence && sequence.cycle !== seenCycle) {
      assert.equal(f.motion.snapshot().gestures.some(g => g.id === lastFinalCue), false);
      seenCycle = sequence.cycle;
    }
    return !f.director.story;
  }, 150);
  assert.equal(seenCycle, 2);
  assert.equal(f.events.find(event => event.type === 'story-ended')?.cycles, 2);
  assert.equal(f.motion.gestures.length, 0);
});

test('cooldown waits do not submit rejected motor cues and default face duration is not truncated', () => {
  const f = fixture(); f.director.playStory('quiet_company', false);
  f.director.sequence.steps = [{ gesture: 'wave' }];
  f.motion.lastStart.set('wave', f.director.now + 2);
  const rejected = f.motion.rejected;
  f.advance(3);
  assert.equal(f.director.snapshot().sequence.phase, 'cooldown');
  assert.equal(f.motion.rejected, rejected);
  f.advance(1); assert.equal(f.events.filter(event => event.type === 'gesture').length, 1);
  f.until(() => !f.director.story);

  f.director.playStory('quiet_company', false);
  f.director.sequence.steps = [{ face: { preset: 'smile' } }];
  f.advance(1); assert.equal(f.director.story, 'quiet_company');
  assert.equal(f.face.cues[0].duration, 2);
  f.advance(1); assert.equal(f.director.story, 'quiet_company');
  f.advance(1); assert.equal(f.director.story, null);
});
