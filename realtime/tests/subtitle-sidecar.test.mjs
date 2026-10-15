import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RealtimeScheduler } from '../scheduler.mjs';
import { SubtitleSidecar } from '../subtitle-sidecar.mjs';
import { createSubtitleWorkerHandler } from '../subtitle-worker.mjs';
import { selectSubtitleCues } from '../subtitle-rules.mjs';

const A = Object.freeze({ connectionId: 'c1', responseId: 'r1', epoch: 1 });
const B = Object.freeze({ connectionId: 'c1', responseId: 'r2', epoch: 2 });
const semantic = text => /不要|不点头/u.test(text)
  ? { cues: [], suppressedReason: 'negated', fallbackEligible: false }
  : { cues: /点头/u.test(text) ? [{ kind: 'action', action: 'nod', strength: .6, reason: 'nod' }]
    : /微笑/u.test(text) ? [{ kind: 'expression', preset: 'smile', strength: .6, reason: 'smile' }] : [],
  suppressedReason: '', fallbackEligible: /解释/u.test(text) };

function harness(options = {}, selector = semantic) {
  let wall = 0;
  const commands = [], workers = [], decisions = [];
  const scheduler = new RealtimeScheduler({ clock: () => wall, emit: command => { commands.push(command); return true; } });
  const sidecar = new SubtitleSidecar({ scheduler, clock: () => wall, onDecision: event => decisions.push(event),
    workerFactory: () => {
      const process = createSubtitleWorkerHandler(selector);
      const worker = { jobs: [], terminated: false, postMessage(job) { this.jobs.push(structuredClone(job)); },
        terminate() { this.terminated = true; },
        flushOne() { const job = this.jobs.shift(); if (job) this.onmessage?.({ data: process(job) }); },
      };
      workers.push(worker); return worker;
    }, ...options });
  return { scheduler, sidecar, commands, workers, decisions,
    start(owner = A) { assert.equal(scheduler.begin(owner), true); assert.equal(sidecar.begin(owner), true); },
    push(sequence, text, owner = A, itemId = 'i1') { return sidecar.push({ ...owner, itemId, sequence, text }); },
    play(time, status = 'playing', owner = A) { return scheduler.playback({ ...owner, status, time }); },
    time(value) { wall = value; },
    flush() { const worker = workers.at(-1); let count = 0; while (worker.jobs.length && worker.onmessage && ++count < 100) worker.flushOne(); },
    cues() { return commands.filter(command => command.type === 'cue'); },
    close() { sidecar.dispose(); },
  };
}

test('host must explicitly begin after scheduler, with complete owner and bounded context', () => {
  const h = harness();
  assert.equal(h.sidecar.begin(A), false);
  h.start();
  assert.equal(h.sidecar.begin(A), false);
  assert.equal(h.push(0, '点头。', { ...A, responseId: 'wrong' }).reason, 'wrong_owner');
  assert.equal(h.sidecar.finish(B), false);
  assert.equal(h.sidecar.cancel(B), false);
  h.close();
});

test('push is synchronous and slow analysis never holds the main playback chain', () => {
  const h = harness(); h.start();
  const result = h.push(0, '点头。');
  assert.equal(result.accepted, true); assert.equal(result.then, undefined);
  assert.equal(h.sidecar.snapshot().inFlight, true);
  assert.equal(h.play(.03), true); assert.equal(h.cues().length, 0);
  h.flush(); assert.equal(h.scheduler.queue.length, 1);
  h.play(.06); assert.equal(h.cues().length, 1);
  assert.equal(h.cues()[0].requestedAt, .06);
  h.close();
});

test('comma and fragmented negation remain one complete segment', () => {
  const seen = [];
  const h = harness({}, text => { seen.push(text); return semantic(text); }); h.start();
  h.push(0, '我想说的是，'); h.flush();
  h.push(1, '不要'); h.flush();
  assert.equal(seen.length, 0);
  h.push(2, '点头。'); h.flush();
  assert.deepEqual(seen, ['我想说的是，不要点头。']);
  assert.equal(h.scheduler.queue.length, 0); h.close();
});

test('real selector receives full negated/revoked units and an affirmative cue still works', () => {
  const h = harness({}, selectSubtitleCues); h.start();
  h.push(0, '我点头，'); h.flush(); assert.equal(h.scheduler.queue.length, 0);
  h.push(1, '算了。'); h.flush(); assert.equal(h.scheduler.queue.length, 0);
  h.push(2, '我不'); h.flush(); h.push(3, '点头。'); h.flush(); assert.equal(h.scheduler.queue.length, 0);
  h.push(4, '我明白了。'); h.flush();
  assert.equal(h.scheduler.queue.length, 1); assert.equal(h.scheduler.queue[0].cue.action, 'nod'); h.close();
});

test('closed parentheses are retained and internal punctuation does not split a stage', () => {
  const seen = [];
  const h = harness({}, text => { seen.push(text); return semantic(text); }); h.start();
  h.push(0, '（不要。'); h.flush(); assert.equal(seen.length, 0);
  h.push(1, '点头）好。'); h.flush();
  assert.deepEqual(seen, ['（不要。点头）好。']); assert.equal(h.scheduler.queue.length, 0); h.close();
});

test('quoted punctuation cannot expose a quoted action as an unquoted next segment', () => {
  const seen = [];
  const h = harness({}, text => { seen.push(text); return { cues: [], fallbackEligible: false }; }); h.start();
  h.push(0, '他说"真的。'); h.flush(); assert.equal(seen.length, 0);
  h.push(1, '我点头。"这是引用。'); h.flush();
  assert.deepEqual(seen, ['他说"真的。我点头。"这是引用。']); h.close();
});

test('ASCII periods remain buffered until finish, preserving decimal/abbreviation context', () => {
  const seen = [];
  const h = harness({}, text => { seen.push(text); return { cues: [], fallbackEligible: false }; }); h.start();
  h.push(0, 'e.g. 1.2'); h.flush(); assert.equal(seen.length, 0);
  h.sidecar.finish(A); h.flush(); assert.deepEqual(seen, ['e.g. 1.2']); h.close();
});

test('finish flushes one short tail once and refuses an unfinished delimiter', () => {
  const h = harness(); h.start(); h.push(0, '微笑'); h.flush();
  assert.equal(h.scheduler.queue.length, 0);
  assert.equal(h.sidecar.finish(A), true); h.flush();
  assert.equal(h.sidecar.snapshot().status, 'finished'); assert.equal(h.scheduler.queue.length, 1);
  assert.equal(h.push(1, '点头。').accepted, false); h.close();
  const j = harness(); j.start(); j.push(0, '（微笑'); j.flush(); j.sidecar.finish(A); j.flush();
  assert.equal(j.sidecar.snapshot().lastDecision.reason, 'unclosed_delimiter');
  assert.equal(j.scheduler.status, 'buffering'); assert.equal(j.scheduler.queue.length, 0); j.close();
});

test('finish while a job is pending drains queued deltas then flushes the exact tail', () => {
  const seen = [];
  const h = harness({}, text => { seen.push(text); return semantic(text); }); h.start();
  h.push(0, '不'); h.push(1, '点头'); h.sidecar.finish(A); h.flush();
  assert.deepEqual(seen, ['不点头']); assert.equal(h.sidecar.status, 'finished');
  assert.equal(h.scheduler.queue.length, 0); h.close();
});

test('duplicate input is ignored and conflicting duplicates disable only the sidecar', () => {
  const h = harness(); h.start(); h.push(0, '不要');
  assert.equal(h.push(0, '不要').reason, 'duplicate');
  assert.equal(h.push(0, '请').reason, 'conflicting_duplicate');
  assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.scheduler.status, 'buffering');
  assert.equal(h.scheduler.counts.interrupted, 0); h.close();
});

test('missing and out-of-order deltas fail closed instead of losing a negation', () => {
  const h = harness(); h.start(); h.push(0, '我'); h.flush();
  assert.equal(h.push(2, '点头。').reason, 'sequence_gap');
  assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.scheduler.queue.length, 0); h.close();
});

test('each item has its own sequence and unfinished segment', () => {
  const seen = [];
  const h = harness({}, text => { seen.push(text); return semantic(text); }); h.start();
  h.push(0, '不要', A, 'i1'); h.flush(); h.push(0, '微笑。', A, 'i2'); h.flush();
  h.push(1, '点头。', A, 'i1'); h.flush();
  assert.deepEqual(seen, ['微笑。', '不要点头。']);
  assert.equal(h.scheduler.queue.length, 1); h.close();
});

test('pending overload disables the entire turn and never analyzes a truncated suffix', () => {
  const h = harness({ maxPendingChunks: 2 }); h.start();
  h.push(0, '我'); h.push(1, '不要'); h.push(2, '点');
  assert.equal(h.push(3, '头。').reason, 'input_capacity');
  assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.sidecar.snapshot().pendingChunks, 0);
  assert.equal(h.scheduler.queue.length, 0); assert.equal(h.play(.1), true); h.close();
});

test('segment overflow rejects all decisions from that worker batch rather than partial meaning', () => {
  const h = harness({ maxSegmentChars: 5 }); h.start(); h.push(0, '微笑。不要随意点头'); h.flush();
  assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.scheduler.queue.length, 0);
  assert.equal(h.sidecar.snapshot().lastDecision.reason, 'segment_capacity'); h.close();
});

test('paused and buffering playback can queue cues but cannot dispatch them', () => {
  const h = harness(); h.start(); h.push(0, '点头。'); h.flush();
  h.scheduler.tick(); assert.equal(h.cues().length, 0);
  h.play(0, 'paused'); h.scheduler.tick(); assert.equal(h.cues().length, 0);
  h.play(.06); assert.equal(h.cues().length, 1); h.close();
});

test('worker result keeps its original anchor and late output is discarded', () => {
  const h = harness(); h.start(); h.push(0, '点头。');
  h.time(.5); h.play(.5); h.flush();
  assert.equal(h.scheduler.queue.length, 0); assert.equal(h.sidecar.snapshot().lastDecision.reason, 'late_result');
  assert.equal(h.sidecar.snapshot().lastDecision.anchor, .06); h.close();
});

test('wall-age expiry also discards results while playback is paused', () => {
  const h = harness({ maxResultAgeSeconds: .1 }); h.start(); h.push(0, '点头。');
  h.play(0, 'paused'); h.time(.2); h.flush();
  assert.equal(h.sidecar.snapshot().lastDecision.reason, 'late_result'); assert.equal(h.scheduler.queue.length, 0); h.close();
});

test('ended and faulted scheduler cannot receive worker output', () => {
  for (const status of ['ended', 'fault']) {
    const h = harness(); h.start(); h.push(0, '点头。');
    if (status === 'ended') h.play(0, 'ended'); else { h.scheduler.status = 'fault'; h.scheduler.fault = 'test'; }
    const before = h.scheduler.counts.accepted; h.flush();
    assert.equal(h.scheduler.counts.accepted, before); assert.equal(h.sidecar.status, 'disabled'); h.close();
  }
});

test('cancel fences late worker callbacks and a new turn recreates a healthy worker', () => {
  const h = harness(); h.start(); h.push(0, '点头。');
  const worker = h.workers[0], callback = worker.onmessage, oldJob = worker.jobs[0];
  h.sidecar.cancel(A); assert.equal(h.scheduler.counts.interrupted, 0);
  h.start(B); h.push(0, '微笑。', B); h.flush();
  assert.equal(h.sidecar.cancel(A), false, 'stale cancellation must not stop the replacement');
  callback({ data: { ...oldJob, type: 'result', decisions: [{ ...semantic('点头。'), anchor: .06, receivedAt: 0 }] } });
  assert.equal(h.scheduler.queue.length, 1); assert.equal(h.scheduler.queue[0].cue.preset, 'smile');
  assert.equal(h.workers.length, 2); assert.equal(worker.terminated, true); h.close();
});

test('worker timeout never cancels audio and a later turn can recover', async () => {
  const h = harness({ workerTimeoutMs: 10 }); h.start(); h.push(0, '点头。');
  await delay(30);
  assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.sidecar.lastDecision.reason, 'worker_timeout');
  assert.equal(h.scheduler.counts.interrupted, 0); assert.equal(h.play(.1), true);
  h.start(B); h.push(0, '微笑。', B); h.flush();
  assert.equal(h.scheduler.queue.length, 1); h.close();
});

test('ordinary explain fallback respects a twelve second cooldown across turns', () => {
  const h = harness(); h.start(); h.push(0, '这是解释。'); h.flush();
  assert.equal(h.scheduler.queue.length, 1);
  h.time(10); h.start(B); h.push(0, '继续解释。', B); h.flush(); assert.equal(h.scheduler.queue.length, 0);
  h.time(12); h.push(1, '再次解释。', B); h.flush(); assert.equal(h.scheduler.queue.length, 1); h.close();
});

test('same emotion and motion are debounced and cue density stays bounded', () => {
  const h = harness({ maxCues: 2 }); h.start();
  h.push(0, '微笑。微笑。'); h.flush(); assert.equal(h.scheduler.queue.length, 1);
  h.push(1, '点头。点头。'); h.flush(); assert.equal(h.scheduler.queue.length, 2);
  h.time(10); h.push(2, '微笑。'); h.flush(); assert.equal(h.scheduler.queue.length, 2);
  assert.equal(h.sidecar.counts.queuedCues, 2); assert.ok(h.sidecar.counts.suppressedCues >= 3); h.close();
});

test('observer errors cannot propagate into input or audio scheduling', async () => {
  for (const onDecision of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    const h = harness({ onDecision }); h.start(); h.push(0, '点头。'); h.flush();
    assert.equal(h.play(.06), true); assert.equal(h.cues().length, 1); h.close();
  }
  await delay(0);
});

test('invalid worker cue or invented anchor never reaches scheduler', () => {
  for (const mutate of [d => { d.anchor = 5; }, d => { d.cues[0].action = 'invented'; }]) {
    const h = harness(); h.start(); h.push(0, '点头。');
    const worker = h.workers[0], job = worker.jobs[0];
    const decision = { ...semantic('点头。'), anchor: .06, receivedAt: 0 }; mutate(decision);
    worker.onmessage({ data: { type: 'result', generation: job.generation, jobId: job.jobId, owner: A, decisions: [decision] } });
    assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.scheduler.queue.length, 0); h.close();
  }
});

test('failed worker creation and invalid configuration remain isolated', () => {
  const h = harness({ workerFactory: () => { throw new Error('unsupported'); } });
  h.scheduler.begin(A); assert.equal(h.sidecar.begin(A), false); assert.equal(h.sidecar.status, 'disabled');
  assert.equal(h.play(.1), true); h.close();
  for (const options of [{ maxPendingChunks: Infinity }, { maxSegmentChars: 513 }, { workerTimeoutMs: 0 }, { motionGapSeconds: -1 }]) {
    assert.throws(() => new SubtitleSidecar({ scheduler: h.scheduler, ...options }), RangeError);
  }
});

test('worker runtime, message and post failures disable only optional analysis', () => {
  for (const fault of ['onerror', 'onmessageerror', 'postMessage']) {
    const h = harness(); h.start();
    if (fault === 'postMessage') h.workers[0].postMessage = () => { throw new Error('post failed'); };
    h.push(0, '点头。');
    if (fault !== 'postMessage') h.workers[0][fault]({});
    assert.equal(h.sidecar.status, 'disabled'); assert.equal(h.scheduler.counts.interrupted, 0);
    assert.equal(h.play(.1), true); h.close();
  }
});
