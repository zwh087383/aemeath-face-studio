import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeScheduler } from '../scheduler.mjs';

const A = Object.freeze({ connectionId: 'socket-A', responseId: 'reply-A', epoch: 1 });
const B = Object.freeze({ connectionId: 'socket-B', responseId: 'reply-B', epoch: 2 });

function harness(options = {}) {
  let wall = 0;
  const commands = [];
  const scheduler = new RealtimeScheduler({
    clock: () => wall,
    emit: command => { commands.push(structuredClone(command)); return true; },
    ...options,
  });
  return {
    scheduler, commands,
    advance: seconds => { wall += seconds; },
    setWall: seconds => { wall = seconds; },
    playback: (status, time, identity = A) => scheduler.playback({ ...identity, status, time }),
    enqueue: (id, at, extra = {}) => scheduler.enqueue({ ...A, id, gesture: 'wave', at, ...extra }),
    cues: () => commands.filter(command => command.type === 'cue'),
  };
}

function start(h) {
  assert.equal(h.scheduler.begin(A), true);
  assert.equal(h.playback('playing', 0), true);
}

test('arrival and wall time cannot fire a cue before actual playback reaches its start', () => {
  const h = harness();
  start(h);
  assert.equal(h.enqueue('future-wave', 1).accepted, true);
  h.advance(.3);
  h.scheduler.tick();
  assert.equal(h.cues().length, 0);
  h.playback('playing', .99);
  h.scheduler.tick();
  assert.equal(h.cues().length, 0);
  h.advance(.01);
  h.playback('playing', 1);
  h.scheduler.tick();
  assert.equal(h.cues().length, 1);
  assert.equal(h.cues()[0].cue.id, 'future-wave');
  assert.equal(h.cues()[0].cue.clock, 'audio');
  assert.equal(h.cues()[0].cue.epoch, 1);
  assert.deepEqual(h.cues()[0].identity, A);
  h.scheduler.tick();
  assert.equal(h.cues().length, 1, 'repeated tick must not deliver twice');
});

test('reply identity must be complete and cannot be inferred from provider or cue events', () => {
  const h = harness();
  for (const identity of [{ epoch: 1 }, { connectionId: 'socket-A', epoch: 1 }, { responseId: 'reply-A', epoch: 1 }]) {
    assert.equal(h.scheduler.begin(identity), false);
    assert.equal(h.scheduler.playback({ ...identity, status: 'playing', time: 0 }), false);
    assert.equal(h.scheduler.enqueue({ ...identity, id: 'partial', gesture: 'wave', at: 0 }).accepted, false);
    assert.equal(h.scheduler.providerDone(identity), false);
  }
  assert.equal(h.commands.length, 0);
  assert.equal(h.scheduler.begin(A), true, 'invalid identities must not consume the valid epoch');
});

test('old or mismatched connections, responses and epochs cannot influence the active reply', () => {
  const h = harness();
  start(h);
  for (const identity of [
    { ...A, connectionId: 'other-socket' },
    { ...A, responseId: 'other-reply' },
    { ...A, epoch: 2 },
    { ...A, epoch: 0 },
  ]) {
    const count = h.commands.length;
    assert.equal(h.scheduler.enqueue({ ...identity, id: 'wrong-owner', gesture: 'wave', at: 0 }).accepted, false);
    assert.equal(h.playback('ended', 0, identity), false);
    assert.equal(h.scheduler.providerDone(identity), false);
    assert.equal(h.scheduler.interrupt(identity), false);
    assert.equal(h.commands.length, count, 'an unowned event must emit nothing');
    assert.equal(h.scheduler.snapshot().status, 'playing');
  }
});

test('pause freezes semantic progress and resumes the same reply without replaying old cues', () => {
  const h = harness();
  start(h);
  assert.equal(h.enqueue('paused-wave', 1).accepted, true);
  assert.equal(h.playback('paused', .4), true);
  h.advance(10);
  h.scheduler.tick();
  assert.equal(h.scheduler.snapshot().status, 'paused');
  assert.equal(h.scheduler.snapshot().time, .4);
  assert.equal(h.cues().length, 0);
  assert.equal(h.playback('paused', .8), false, 'a paused timeline cannot silently advance');
  assert.equal(h.scheduler.snapshot().time, .4);
  assert.equal(h.playback('playing', .4), true);
  h.advance(.1);
  h.playback('playing', 1);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['paused-wave']);
});

test('explicit audio starvation freezes content time until the next playable snapshot', () => {
  const h = harness();
  start(h);
  h.enqueue('after-gap', 1);
  assert.equal(h.playback('buffering', .5), true);
  h.advance(20);
  h.scheduler.tick();
  assert.equal(h.scheduler.snapshot().status, 'buffering');
  assert.equal(h.scheduler.snapshot().time, .5);
  assert.equal(h.cues().length, 0);
  assert.equal(h.playback('playing', .5), true);
  h.playback('playing', 1);
  h.scheduler.tick();
  assert.equal(h.cues().length, 1);
});

test('missing playback evidence triggers terminal cleanup instead of wall-clock extrapolation', () => {
  const h = harness({ watchdogSeconds: .5 });
  start(h);
  h.enqueue('never-guess-audio', 1);
  h.advance(.51);
  h.scheduler.tick();
  assert.equal(h.scheduler.snapshot().status, 'cancelled');
  assert.equal(h.scheduler.snapshot().queued, 0);
  assert.equal(h.scheduler.snapshot().time, 0);
  assert.equal(h.cues().length, 0);
  assert.ok(h.commands.some(command => command.type === 'stop_audio'));
  assert.ok(h.commands.some(command => command.type === 'retract'));
  assert.equal(h.playback('playing', 1), false, 'a late snapshot cannot revive the watchdog-cancelled epoch');
});

test('provider completion keeps queued audio actions alive until actual playback ends', () => {
  const h = harness();
  start(h);
  h.enqueue('after-provider-done', 1);
  assert.equal(h.scheduler.providerDone(A), true);
  assert.equal(h.scheduler.snapshot().status, 'playing');
  assert.equal(h.scheduler.snapshot().queued, 1);
  assert.equal(h.commands.filter(command => command.type === 'stop_audio').length, 0);
  h.playback('playing', 1);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['after-provider-done']);
  h.enqueue('beyond-audio', 10);
  assert.equal(h.playback('ended', 2), true);
  assert.equal(h.scheduler.snapshot().status, 'ended');
  assert.equal(h.scheduler.snapshot().queued, 0);
  assert.equal(h.enqueue('after-ending', 3).accepted, false);
  assert.equal(h.playback('playing', 3), false);
});

test('duplicate cue IDs deliver once and malformed cues never reach the execution sink', () => {
  const h = harness();
  start(h);
  assert.equal(h.enqueue('only-once', 1).accepted, true);
  assert.equal(h.enqueue('only-once', 1).accepted, false);
  for (const [index, changes] of [
    { at: -1 }, { at: NaN }, { at: Infinity }, { strength: NaN },
    { strength: -1 }, { strength: 1.01 }, { gesture: 'invented' },
    { kind: 'invented' }, { id: '' }, { at: 1, apexAt: 2 },
  ].entries()) {
    assert.equal(h.enqueue(`invalid-${index}`, 2, changes).accepted, false);
  }
  h.playback('playing', 1);
  h.scheduler.tick();
  assert.equal(h.enqueue('only-once', 4).accepted, false, 'a consumed ID stays deduplicated');
  assert.deepEqual(h.cues().map(command => command.cue.id), ['only-once']);
});

test('late queued and newly arriving gestures are dropped rather than played in a burst', () => {
  const h = harness({ lateTolerance: .2 });
  start(h);
  h.enqueue('missed-window', 1);
  h.playback('playing', 2);
  h.scheduler.tick();
  assert.equal(h.cues().length, 0);
  assert.equal(h.scheduler.snapshot().queued, 0);
  assert.equal(h.enqueue('arrived-too-late', 1).accepted, false);
});

test('an accepted slightly late cue starts from current time instead of skipping preparation', () => {
  const h = harness({ lateTolerance: .2 });
  start(h);
  h.playback('playing', 1.1);
  assert.equal(h.enqueue('small-delay', 1).accepted, true);
  h.scheduler.tick();
  assert.equal(h.cues().length, 1);
  assert.equal(h.cues()[0].requestedAt, 1);
  assert.equal(h.cues()[0].cue.at, 1.1);
});

test('independent face, head and body slots can be delivered together', () => {
  const h = harness();
  start(h);
  assert.equal(h.enqueue('body-wave', 1).accepted, true);
  assert.equal(h.enqueue('head-nod', 1, { kind: 'action', action: 'nod' }).accepted, true);
  assert.equal(h.enqueue('face-smile', 1, { kind: 'expression', preset: 'smile', strength: .6 }).accepted, true);
  h.playback('playing', 1);
  h.scheduler.tick();
  const cues = h.cues().map(command => command.cue);
  assert.deepEqual(cues.map(cue => cue.id), ['body-wave', 'head-nod', 'face-smile']);
  assert.equal(cues[1].action, 'nod');
  assert.equal(cues[2].preset, 'smile');
  assert.equal(cues[2].strength, .6);
});

test('backward and invalid playback snapshots cannot corrupt the monotonic media clock', () => {
  const h = harness();
  start(h);
  h.playback('playing', 2);
  for (const time of [1.99, -1, NaN, Infinity]) {
    assert.equal(h.playback('playing', time), false);
    assert.equal(h.scheduler.snapshot().time, 2);
  }
  assert.equal(h.playback('invented', 2), false);
  assert.equal(h.scheduler.snapshot().status, 'playing');
});

test('switching between paused and buffering cannot advance frozen media without playing', () => {
  const h = harness();
  start(h);
  assert.equal(h.playback('paused', .5), true);
  assert.equal(h.playback('buffering', .8), false, 'changing the freeze reason is not evidence of played audio');
  assert.equal(h.scheduler.snapshot().time, .5);
  assert.equal(h.playback('buffering', .5), true);
  assert.equal(h.playback('paused', .8), false);
  assert.equal(h.scheduler.snapshot().time, .5);
  assert.equal(h.playback('playing', .8), true, 'fresh playing evidence can advance content time');
});

test('dedup capacity rejects new IDs instead of evicting old IDs that could then replay', () => {
  const h = harness({ maxSeen: 2, catalog: { 'gesture:wave': { duration: .1, apex: 0, slot: 'body', cooldown: 0 } } });
  start(h);
  assert.equal(h.enqueue('remember-first', 0).accepted, true);
  h.scheduler.tick();
  assert.equal(h.enqueue('remember-second', 1).accepted, true);
  h.playback('playing', 1);
  assert.equal(h.enqueue('overflow-seen', 2).accepted, false);
  assert.equal(h.enqueue('remember-first', 2).accepted, false);
  assert.deepEqual(h.cues().map(command => command.cue.id), ['remember-first', 'remember-second']);
  assert.equal(h.scheduler.begin(B), true);
  assert.equal(h.scheduler.enqueue({ ...B, id: 'remember-first', gesture: 'wave', at: 0 }).accepted, true,
    'a new identity owns a fresh dedup scope');
});

test('queue pressure and excessive future scheduling are rejected without losing accepted cues', () => {
  const h = harness({ maxQueue: 2, maxFutureSeconds: 20 });
  start(h);
  assert.equal(h.enqueue('first', 1).accepted, true);
  assert.equal(h.enqueue('second', 5).accepted, true);
  assert.equal(h.enqueue('overflow', 9).accepted, false);
  assert.equal(h.scheduler.snapshot().queued, 2);
  h.playback('playing', 1);
  h.scheduler.tick();
  assert.equal(h.enqueue('far-future', 50).accepted, false);
  assert.equal(h.scheduler.snapshot().queued, 1);
  h.playback('playing', 5);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['first', 'second']);
});

test('a supplied apex offset schedules preparation before the emphasized instant', () => {
  const h = harness({ catalog: { 'gesture:wave': { duration: 1, apex: .25, slot: 'body', cooldown: 0 } } });
  start(h);
  assert.equal(h.scheduler.enqueue({ ...A, id: 'emphasis', gesture: 'wave', apexAt: 2 }).accepted, true);
  h.playback('playing', 1.74);
  h.scheduler.tick();
  assert.equal(h.cues().length, 0);
  h.playback('playing', 1.75);
  h.scheduler.tick();
  assert.equal(h.cues().length, 1);
  assert.equal(h.cues()[0].cue.at, 1.75);
  assert.equal(h.cues()[0].cue.duration, 1);
});

test('body slot conflicts do not become an accumulating catch-up gesture queue', () => {
  const h = harness({ catalog: {
    'gesture:wave': { duration: 2, apex: .5, slot: 'body', cooldown: 0 },
    'gesture:shrug': { duration: 1, apex: .3, slot: 'body', cooldown: 0 },
  } });
  start(h);
  h.enqueue('wave-first', 1);
  h.enqueue('conflicting-shrug', 1.05, { gesture: 'shrug' });
  h.playback('playing', 1);
  h.scheduler.tick();
  h.playback('playing', 1.1);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['wave-first']);
  h.playback('playing', 1.3);
  h.scheduler.tick();
  h.playback('playing', 4);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['wave-first']);
  assert.equal(h.scheduler.snapshot().queued, 0);
});

test('same-action cooldown survives an otherwise free body slot', () => {
  const h = harness({ catalog: { 'gesture:wave': { duration: .1, apex: .03, slot: 'body', cooldown: 2 } } });
  start(h);
  h.enqueue('first-wave', 1);
  h.playback('playing', 1);
  h.scheduler.tick();
  h.enqueue('too-frequent-wave', 1.5);
  h.playback('playing', 1.5);
  h.scheduler.tick();
  h.playback('playing', 1.8);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['first-wave']);
  h.enqueue('rested-wave', 3.1);
  h.playback('playing', 3.1);
  h.scheduler.tick();
  assert.deepEqual(h.cues().map(command => command.cue.id), ['first-wave', 'rested-wave']);
});

test('replacing a response cleans the old identity before beginning the new identity', () => {
  const h = harness();
  start(h);
  h.enqueue('old-future', 5);
  const offset = h.commands.length;
  assert.equal(h.scheduler.begin(B), true);
  const transition = h.commands.slice(offset);
  const beginIndex = transition.findIndex(command => command.type === 'begin');
  assert.ok(beginIndex > 0);
  for (const type of ['stop_audio', 'retract']) {
    const index = transition.findIndex(command => command.type === type);
    assert.ok(index >= 0 && index < beginIndex);
    assert.deepEqual(transition[index].identity, A);
  }
  assert.deepEqual(transition[beginIndex].identity, B);
  assert.equal(h.scheduler.snapshot().queued, 0);
  assert.equal(h.enqueue('old-late', 0).accepted, false);
  assert.equal(h.playback('playing', 5), false);
  assert.equal(h.scheduler.begin({ ...B, responseId: 'new-name-same-epoch' }), false);
});

for (const [phase, time] of [['preparation', .1], ['stroke', .82], ['recovery', 2.3]]) {
  test(`interrupt during simulated ${phase} delivers synchronous cleanup and permanently drops old events`, () => {
    const h = harness();
    start(h);
    h.enqueue('active-wave', 0);
    h.enqueue('future-wave', 5);
    h.scheduler.tick();
    h.setWall(time);
    h.playback('playing', time);
    h.scheduler.tick();
    const count = h.commands.length;
    assert.equal(h.scheduler.interrupt({ ...A, reason: 'barge_in' }), true);
    const cleanup = h.commands.slice(count);
    assert.deepEqual(cleanup.map(command => command.type), ['stop_audio', 'retract', 'posture']);
    assert.equal(cleanup.at(-1).posture, 'listening');
    assert.ok(cleanup.every(command => command.atWall === time && command.identity.epoch === A.epoch));
    assert.equal(h.scheduler.snapshot().status, 'cancelled');
    assert.equal(h.scheduler.snapshot().queued, 0);
    const afterCleanup = h.commands.length;
    assert.equal(h.scheduler.interrupt({ ...A, reason: 'duplicate_barge_in' }), false);
    assert.equal(h.commands.length, afterCleanup, 'duplicate interrupt must not repeat external cleanup');
    assert.equal(h.playback('playing', 6), false);
    assert.equal(h.scheduler.providerDone(A), false);
    assert.equal(h.enqueue('late-old-wave', 6).accepted, false);
    h.advance(10);
    h.scheduler.tick();
    assert.deepEqual(h.cues().map(command => command.cue.id), ['active-wave']);
    assert.equal(h.scheduler.begin(A), false, 'cancelled epochs are never reusable');
    assert.equal(h.scheduler.begin(B), true);
  });
}

for (const mode of ['false', 'throw', 'promise', 'rejectedPromise']) {
  test(`a ${mode} sink failure faults and requires explicit recovery plus a fresh epoch`, async () => {
    const commands = [];
    let fail = true;
    const h = harness({ emit: command => {
      commands.push(structuredClone(command));
      if (command.type === 'cue' && fail) {
        if (mode === 'throw') throw new Error('execution sink failed');
        if (mode === 'rejectedPromise') return Promise.reject(new Error('async execution sink failed'));
        return mode === 'promise' ? Promise.resolve(true) : false;
      }
      return true;
    } });
    start(h);
    h.enqueue('sink-failed-cue', 0);
    h.scheduler.tick();
    assert.equal(h.scheduler.snapshot().status, 'fault');
    assert.ok(h.scheduler.snapshot().fault);
    assert.equal(h.scheduler.snapshot().queued, 0);
    for (const type of ['stop_audio', 'retract', 'posture']) assert.ok(commands.some(command => command.type === type));
    assert.equal(h.scheduler.begin(B), false, 'new replies must wait for host cleanup confirmation');
    assert.equal(h.playback('playing', 1), false);
    assert.equal(h.enqueue('blocked-cue', 1).accepted, false);
    fail = false;
    assert.equal(h.scheduler.recover(), true);
    assert.equal(h.scheduler.snapshot().fault, null);
    assert.equal(h.scheduler.begin(A), false);
    assert.equal(h.scheduler.begin(B), true);
    // Allow the microtask/event loop to report any unconsumed rejection from an invalid async sink.
    await new Promise(resolve => setImmediate(resolve));
  });
}

test('cleanup sink failure still attempts the remaining cleanup operations and blocks replacement', () => {
  const commands = [];
  const h = harness({ emit: command => {
    commands.push(structuredClone(command));
    return command.type !== 'stop_audio';
  } });
  start(h);
  assert.equal(h.scheduler.begin(B), false);
  assert.equal(h.scheduler.snapshot().status, 'fault');
  const cleanup = commands.filter(command => ['stop_audio', 'retract', 'posture'].includes(command.type));
  assert.ok(cleanup.some(command => command.type === 'retract'));
  assert.ok(cleanup.some(command => command.type === 'posture' && command.posture === 'listening'));
  assert.equal(commands.some(command => command.type === 'begin' && command.identity.epoch === B.epoch), false);
});
