import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorPlanner } from '../behavior-planner.mjs';
import { selectSubtitleCues } from '../subtitle-rules.mjs';

const A = { connectionId: 'c1', responseId: 'r1', epoch: 1 };
const B = { connectionId: 'c1', responseId: 'r2', epoch: 2 };
const natural = text => selectSubtitleCues(text, { policy: 'natural' });
function harness() {
  let now = 0, seq = 0;
  const planner = new BehaviorPlanner({ clock: () => now });
  planner.setConnection('c1'); planner.begin(A);
  return { planner, time(value) { now = value; },
    plan(text, override = {}, decisionOverride = {}) {
      return planner.planCandidate({ ...natural(text), ...decisionOverride }, { owner: A,
        interactionGeneration: planner.interactionGeneration, anchor: now + .06, nowAudio: now,
        receivedAt: now, nowWall: now, candidateId: `c${++seq}`, ...override });
    } };
}

test('ordinary explanations and comfort deliberately keep hands without fallback', () => {
  for (const text of ['慢慢来，我在这里陪着你。', '你别着急，我会陪着你。',
    '这里主要有两个原因，先看第一点。', '我想一想，首先把这个问题分成两步。',
    '我来解释一下，原因是网络还没连上。', '我们把这个问题分开来看。']) {
    const result = natural(text);
    assert.equal(result.behavior.reaction.level, 'none', text);
    assert.equal(result.fallbackEligible, false, text);
    assert.equal(result.cues.some(cue => cue.kind === 'gesture'), false, text);
  }
  assert.equal(natural('慢慢来，我在这里陪着你。').behavior.intent, 'comfort');
  assert.equal(natural('我想一想，首先把这个问题分成两步。').behavior.intent, 'explanation');
});

test('short agreement is a modest head cue, greeting retains current authored wave', () => {
  for (const text of ['嗯，对。', '嗯嗯，你说得对。', '嗯，对，就是这个意思。']) {
    const result = natural(text), motion = result.cues.find(cue => cue.kind !== 'expression');
    assert.equal(result.behavior.reaction.level, 'micro'); assert.equal(motion.action, 'nod');
    assert.ok(motion.strength <= .3);
  }
  const greeting = natural('欸，你来啦！');
  assert.equal(greeting.behavior.intent, 'greeting');
  assert.equal(greeting.behavior.reaction.level, 'authored');
  assert.equal(greeting.cues.find(cue => cue.kind === 'gesture').gesture, 'wave');
  assert.equal(natural('我抬手说明。').cues.find(cue => cue.kind === 'gesture').gesture, 'explain');
});

test('new semantic intents retain actor, quotation, historical, negation and revocation guards', () => {
  for (const text of ['他对我说慢慢来。', '她很开心，朝我挥手。', '如果我点头，然后挥手。',
    '我昨天很开心，挥手告别。', '我不是说你说得对。', '讨论一下慢慢来这个词。',
    '“你来啦！”', '（慢慢来）', '我挥手，算了。']) {
    const result = natural(text);
    assert.equal(result.cues.some(cue => cue.kind !== 'expression'), false, text);
    assert.equal(result.fallbackEligible, false);
  }
  assert.equal(natural('我不同意你说得对。').cues.some(cue => cue.action === 'nod'), false);
  assert.equal(natural('对，但是我不同意。').cues.some(cue => cue.action === 'nod'), false);
  assert.equal(natural('你说得对，但是我不觉得你说得对。').cues.some(cue => cue.action === 'nod'), false);
  assert.equal(natural('嗯，我想一想。').cues.some(cue => cue.action === 'nod'), false);
});

test('unresolved host thinking lasts across arbitrary waits and response.created', () => {
  for (const wait of [2, 8, 42]) {
    const h = harness(), p = h.planner;
    assert.equal(p.userSpeechStarted('c1'), true);
    assert.equal(p.snapshot().owner, null);
    assert.equal(p.userSpeechEnded(p.snapshot()), true);
    h.time(wait); assert.equal(p.snapshot().state.mode, 'thinking');
    assert.equal(p.begin(B), true); assert.equal(p.snapshot().state.mode, 'thinking');
    p.media({ owner: B, status: 'buffering', time: 0 });
    assert.equal(p.snapshot().state.mode, 'thinking');
    assert.equal(p.answerAvailable(B), true);
    assert.equal(p.snapshot().state.mode, 'responding');
    assert.equal(p.snapshot().state.attention, 'partner');
  }
});

test('subtitle consideration cannot start or finish a host thinking phase', () => {
  const h = harness();
  h.plan('我想一想。');
  assert.equal(h.planner.snapshot().mode, 'listening');
  h.planner.media({ owner: A, status: 'playing', time: 0 });
  h.plan('我想一想。');
  assert.equal(h.planner.snapshot().mode, 'responding');
});

test('unresolved waiting stays attentive and neutral; only current answer resolves lifecycle', () => {
  const h = harness(), p = h.planner;
  p.userSpeechStarted('c1'); p.userSpeechEnded(p.snapshot()); p.begin(B);
  const waiting = p.snapshot().state;
  assert.equal(waiting.mode, 'thinking');
  assert.equal(waiting.attention, 'partner');
  assert.equal(waiting.tension, .04); assert.equal(waiting.uncertainty, 0);
  assert.equal(p.answerAvailable(A), false);
  assert.deepEqual(p.snapshot().state, waiting, 'old answer cannot resolve the current wait');
  assert.equal(p.answerAvailable(B), true);
  assert.equal(p.snapshot().state.mode, 'responding');
  assert.equal(p.snapshot().state.attention, 'partner');
  assert.equal(p.snapshot().state.tension, waiting.tension);
  assert.equal(p.snapshot().state.uncertainty, waiting.uncertainty);
  assert.equal(p.snapshot().state.warmth, waiting.warmth);
  for (const text of ['慢慢来，我在这里陪着你。', '你好！', '我想一想。']) {
    const other = harness(); other.plan(text);
    const before = other.planner.snapshot().state;
    assert.notEqual(before.mode, 'thinking');
    assert.equal(other.planner.answerAvailable(A), true);
    assert.deepEqual(other.planner.snapshot().state, { ...before, mode: 'responding', attention: 'partner' }, text);
  }
});

test('media pause and buffering are distinct from communication state; real ended preserves attitude', () => {
  const h = harness(), p = h.planner;
  p.media({ owner: A, status: 'playing', time: 0 }); h.plan('慢慢来，我在这里陪着你。');
  const state = p.snapshot().state;
  p.media({ owner: A, status: 'paused', time: 0 }); assert.deepEqual(p.snapshot().state, state);
  p.media({ owner: A, status: 'buffering', time: 0 }); assert.deepEqual(p.snapshot().state, state);
  p.media({ owner: A, status: 'ended', time: 2 });
  assert.equal(p.snapshot().mode, 'settling'); assert.equal(p.snapshot().state.warmth, state.warmth);
  assert.equal(p.media({ owner: A, status: 'playing', time: 2.1 }), false);
  assert.equal(h.plan('我很开心。').accepted, false);
});

test('persistent attitude consumes duplicate preset and survives ordinary punctuation', () => {
  const h = harness();
  const greeting = h.plan('你好，我很开心！');
  assert.equal(greeting.cues.some(cue => cue.kind === 'expression'), false);
  assert.equal(greeting.cues[0].gesture, 'wave');
  const state = h.planner.snapshot().state;
  h.plan('这里还有一杯茶。');
  assert.deepEqual(h.planner.snapshot().state, state);
  h.plan('我很平静。'); assert.ok(h.planner.snapshot().state.warmth < state.warmth);
});

test('host-confirmed completed body tail returns to listening without erasing welcoming attitude', () => {
  const h = harness(), p = h.planner;
  p.media({ owner: A, status: 'playing', time: 0 }); h.plan('你好！');
  assert.equal(p.settled(A), false);
  p.media({ owner: A, status: 'ended', time: 2 });
  const state = p.snapshot().state;
  assert.equal(p.settled(B), false); assert.equal(p.settled(A), true);
  assert.equal(p.snapshot().mode, 'listening'); assert.equal(p.snapshot().state.warmth, state.warmth);
});

test('occupied body degrades reaction, keeps prior attitude and never queues a postponed gesture', () => {
  const h = harness(); h.plan('慢慢来，我在这里陪着你。');
  const state = h.planner.snapshot().state;
  const greeting = h.plan('你好！', { bodyBusy: true });
  assert.equal(greeting.accepted, true); assert.deepEqual(greeting.cues, []);
  assert.equal(greeting.plan.reaction.level, 'none'); assert.equal(greeting.plan.degraded, 'body_busy');
  assert.deepEqual(h.planner.snapshot().state, state);
  const still = h.planner.snapshot(); h.time(9); assert.deepEqual(h.planner.snapshot().lastPlan, still.lastPlan);
});

test('cancel and replacement revoke old owners and generation before any new attitude can enter', () => {
  const h = harness(), p = h.planner, generation = p.interactionGeneration;
  h.plan('我很开心。'); assert.equal(p.cancel(A), true);
  assert.equal(p.snapshot().mode, 'listening'); assert.equal(p.snapshot().owner, null);
  assert.equal(h.plan('我很开心。', { interactionGeneration: generation }).accepted, false);
  p.begin(B);
  assert.equal(p.answerAvailable(A), false); assert.equal(p.cancel(A), false);
  assert.equal(h.plan('我很开心。', { owner: B, interactionGeneration: generation }).accepted, false);
  assert.equal(h.plan('我很开心。', { owner: B }).accepted, true);
});

test('local listening has no borrowed response and old input-end cannot resolve new interaction', () => {
  const h = harness(), p = h.planner;
  p.userSpeechStarted('c1'); const old = p.snapshot();
  p.userSpeechStarted('c1');
  assert.equal(p.userSpeechEnded(old), false);
  assert.equal(p.snapshot().owner, null);
  assert.equal(p.userSpeechEnded(p.snapshot()), true);
  assert.equal(p.disconnect('c1'), true);
  assert.equal(p.userSpeechEnded(p.snapshot()), false);
  assert.equal(p.setConnection('c2'), true); assert.equal(p.setConnection('c1'), false);
});

test('expired, future, duplicate and invalid candidates cannot alter a sustained attitude', () => {
  const h = harness(); h.plan('慢慢来，我在这里陪着你。');
  const before = h.planner.snapshot().state;
  h.time(2);
  for (const override of [{ anchor: 1 }, { receivedAt: 0 }, { anchor: 3 }, { nowWall: 3 }, { interactionGeneration: 0 }]) {
    assert.equal(h.plan('我很开心。', override).accepted, false);
    assert.deepEqual(h.planner.snapshot().state, before);
  }
  assert.equal(h.plan('你好。', { candidateId: 'once' }).accepted, true);
  assert.equal(h.plan('你好。', { candidateId: 'once' }).accepted, false);
  assert.equal(h.plan('你好。', {}, { behavior: { intent: 'hacked', reaction: { level: 'authored' } } }).accepted, false);
});

test('worker state, owner and arbitrary bone goals are ignored; only bounded intent is translated', () => {
  const h = harness();
  const result = h.plan('慢慢来，我在这里陪着你。', {}, { owner: B, interactionGeneration: 99,
    body: { headYaw: 123 }, behavior: { intent: 'comfort', reaction: { level: 'none' },
      state: { mode: 'thinking', warmth: 100 }, body: { headYaw: 123 } } });
  assert.equal(result.accepted, true);
  assert.equal(h.planner.snapshot().state.mode, 'listening');
  assert.ok(h.planner.snapshot().state.warmth <= 1);
  assert.ok(Math.abs(h.planner.snapshot().body.headYaw) < .1);
  assert.deepEqual(result.plan.owner, A);
});

test('none and defer cannot smuggle an authored gesture into the scheduler', () => {
  for (const level of ['none', 'defer']) {
    const h = harness();
    const result = h.plan('你好。', {}, { behavior: { intent: 'neutral', reaction: { level } } });
    assert.equal(result.accepted, true); assert.deepEqual(result.cues, []);
    assert.equal(result.plan.reaction.level, level);
  }
});
