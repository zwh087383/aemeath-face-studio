import test from 'node:test';
import assert from 'node:assert/strict';
import { createControllerSink, enqueueToolCue } from '../controller-sink.mjs';
import { RealtimeScheduler } from '../scheduler.mjs';

const owner = { connectionId: 'reply-socket', responseId: 'r1', epoch: 1 };
function fixture() {
  let now = 0;
  const events = [];
  const controller = label => ({ epoch: 0, active: false,
    begin(epoch) { this.epoch = epoch; this.active = true; events.push([label, 'begin', epoch]); return true; },
    playback(epoch, status, time) { events.push([label, status, time]); if (status === 'ended') this.active = false; return this.epoch === epoch; },
    enqueue(cue) { events.push([label, 'cue', cue]); return true; },
    cancel(epoch, at) { events.push([label, 'cancel', at]); this.active = false; return epoch === this.epoch; },
  });
  const face = controller('face'), motion = controller('motion');
  const audio = { epoch: 0, status: 'idle', sourceActive: false,
    cancel() { this.status = 'cancelled'; this.sourceActive = false; events.push(['audio', 'stop']); },
    snapshot() { return { epoch: this.epoch, status: this.status, sourceActive: this.sourceActive }; },
  };
  const sink = createControllerSink({ audio, face, motion });
  const scheduler = new RealtimeScheduler({ clock: () => now, emit: sink });
  scheduler.begin(owner); audio.epoch = 1; audio.status = 'playing'; audio.sourceActive = true;
  return { face, motion, audio, events, sink, scheduler, setNow: x => { now = x; } };
}

test('adapter freezes controller on initial buffering and routes face/body independently', () => {
  const f = fixture();
  assert.ok(f.events.some(e => e[0] === 'motion' && e[1] === 'paused'));
  f.scheduler.enqueue({ ...owner, id: 'body', gesture: 'wave', at: 0 });
  f.scheduler.enqueue({ ...owner, id: 'face', kind: 'expression', preset: 'happy', at: 0 });
  assert.equal(f.scheduler.playback({ ...owner, status: 'playing', time: 0 }), true);
  assert.equal(f.events.filter(e => e[0] === 'motion' && e[1] === 'cue').length, 1);
  assert.equal(f.events.filter(e => e[0] === 'face' && e[1] === 'cue').length, 1);
});

test('adapter cut is synchronous before wall-clock body retraction; delayed cue cannot revive', () => {
  const f = fixture(); f.setNow(10);
  assert.equal(f.scheduler.interrupt(owner), true);
  const stop = f.events.findIndex(e => e[0] === 'audio' && e[1] === 'stop');
  const retract = f.events.findIndex(e => e[0] === 'motion' && e[1] === 'cancel');
  assert.ok(stop >= 0 && retract > stop);
  assert.equal(f.events[retract][2], 10);
  assert.equal(f.audio.sourceActive, false);
  assert.equal(f.scheduler.enqueue({ ...owner, id: 'late', gesture: 'wave' }).accepted, false);
});

test('stop adapter never cuts newer transport epoch', () => {
  const f = fixture(); f.audio.epoch = 2;
  assert.equal(f.sink({ type: 'stop_audio', identity: owner, atWall: 1 }), false);
  assert.equal(f.audio.sourceActive, true);
});

test('old cleanup posture cannot overwrite newer controller or audio owner', () => {
  const f = fixture(); let calls = 0;
  const sink = createControllerSink({ ...f, onPosture: () => { calls++; return true; } });
  f.motion.epoch = 2;
  assert.equal(sink({ type: 'posture', identity: owner, posture: 'listening', atWall: 0 }), false);
  assert.equal(calls, 0);
  f.motion.epoch = 1; f.audio.epoch = 2;
  assert.equal(sink({ type: 'posture', identity: owner, posture: 'listening', atWall: 0 }), false);
  assert.equal(calls, 0);
});

test('body cleanup still attempted after face throws; broken audio cleanup faults scheduler', () => {
  const f = fixture();
  f.face.cancel = () => { throw new Error('face'); };
  assert.equal(f.scheduler.interrupt(owner), false);
  assert.equal(f.motion.active, false);
  assert.equal(f.scheduler.snapshot().status, 'fault');
  const g = fixture(); g.audio.cancel = () => { throw new Error('audio'); };
  assert.equal(g.scheduler.interrupt(owner), false);
  assert.equal(g.motion.active, false);
});

test('complete tool call is owner bound, idempotent, and bounded; partial JSON never executes', () => {
  const f = fixture();
  const tool = { callId: 'call1', name: 'avatar_cue', arguments: '{"gesture":"wave"}' };
  for (const bad of [null, undefined, [], 'wave', 0]) assert.equal(enqueueToolCue(f.scheduler, owner, bad).accepted, false);
  assert.equal(enqueueToolCue(f.scheduler, owner, { ...tool, arguments: '{"gesture":' }).accepted, false);
  assert.equal(enqueueToolCue(f.scheduler, owner, { ...tool, arguments: '{"gesture":"wave","epoch":9}' }).accepted, false);
  assert.equal(enqueueToolCue(f.scheduler, owner, tool).accepted, true);
  assert.equal(enqueueToolCue(f.scheduler, owner, tool).accepted, false);
  assert.equal(enqueueToolCue(f.scheduler, { ...owner, connectionId: 'listener' }, { ...tool, callId: 'call2' }).accepted, false);
  for (const argumentsText of ['null', '[]', '"wave"', '{"__proto__":{}}', 'x'.repeat(4097)]) {
    assert.equal(enqueueToolCue(f.scheduler, owner, { ...tool, arguments: argumentsText }).accepted, false);
  }
  assert.equal(f.scheduler.snapshot().queued, 1);
});

test('short audio consumed entirely between RAF samples advances evidence without dispatch during buffering', () => {
  const f = fixture();
  f.scheduler.enqueue({ ...owner, id: 'short', gesture: 'wave', at: .01 });
  assert.equal(f.scheduler.playback({ ...owner, status: 'buffering', time: .02 }), true);
  assert.equal(f.scheduler.snapshot().time, .02);
  assert.equal(f.events.filter(e => e[1] === 'cue').length, 0);
  assert.equal(f.scheduler.playback({ ...owner, status: 'buffering', time: .02 }), true);
  assert.equal(f.scheduler.playback({ ...owner, status: 'playing', time: .03 }), true);
  const cue = f.events.find(e => e[1] === 'cue')[2];
  assert.equal(cue.at, .03);
});
