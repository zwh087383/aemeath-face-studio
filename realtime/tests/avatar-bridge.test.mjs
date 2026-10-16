import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AVATAR_CATALOG, createAvatarSink } from '../avatar/controller-bridge.mjs';
import { DEFAULT_CATALOG, RealtimeScheduler } from '../scheduler.mjs';
import { FaceController } from '../../preview/core/controller.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { GESTURES, GESTURE_IDS, MOTION_DEFAULTS, OVERLAP } from '../../preview/core/motion-profile.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';

const inspection = JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json', import.meta.url), 'utf8'));
const skeleton = skeletonFromInspection(inspection);
const A = { connectionId: 'reply-a', responseId: 'response-a', epoch: 1 };
const B = { connectionId: 'reply-b', responseId: 'response-b', epoch: 2 };
const STEP = 1 / 60;

function fixture({ start = true, seed = 20261014 } = {}) {
  let now = 0, owner = null, media = 0;
  const face = new FaceController(), motion = new MotionController({ skeleton, seed }), events = [];
  face.headSway = false;
  const audio = {
    epoch: 0, status: 'idle', sourceActive: false, cancelCount: 0,
    snapshot() { return { epoch: this.epoch, status: this.status, sourceActive: this.sourceActive, sourceCount: this.sourceActive ? 1 : 0 }; },
    cancel() { this.cancelCount++; this.status = 'cancelled'; this.sourceActive = false; },
  };
  const sink = createAvatarSink({ audio, face, motion, observe: command => events.push(command) });
  const scheduler = new RealtimeScheduler({ clock: () => now, emit: sink, catalog: AVATAR_CATALOG });
  const render = dt => {
    face.update(now, dt, null, true);
    motion.update(now, dt, { face: face.head, actions: face.activeActions, speech: 0 });
    for (const quaternion of motion.locals.values()) assert.ok(quaternion.every(Number.isFinite));
  };
  const begin = identity => {
    assert.equal(scheduler.begin(identity), true);
    owner = identity; media = 0;
    Object.assign(audio, { epoch: owner.epoch, status: 'playing', sourceActive: true });
    assert.equal(scheduler.playback({ ...owner, status: 'playing', time: media }), true);
    render(0);
  };
  const advance = (seconds, { playing = true } = {}) => {
    const end = now + seconds;
    while (now + 1e-9 < end) {
      const dt = Math.min(STEP, end - now); now += dt;
      if (playing) {
        media += dt;
        assert.equal(scheduler.playback({ ...owner, status: 'playing', time: media }), true);
      }
      render(dt);
    }
  };
  const cue = (gesture, id = gesture, at = media) => scheduler.enqueue({ ...owner, id, kind: 'gesture', gesture, at });
  const dispatch = () => { assert.equal(scheduler.tick(), true); render(0); };
  const ended = () => {
    Object.assign(audio, { status: 'ended', sourceActive: false });
    assert.equal(scheduler.playback({ ...owner, status: 'ended', time: media }), true);
    render(0);
  };
  if (start) begin(A);
  return { audio, face, motion, events, scheduler, sink, begin, advance, cue, dispatch, ended,
    now: () => now, media: () => media, render };
}

test('avatar catalog preserves legacy timing/order and exposes all public body gestures', () => {
  const expectedKeys = [...new Set([...Object.keys(DEFAULT_CATALOG), ...GESTURE_IDS.map(id => `gesture:${id}`)])];
  assert.deepEqual(Object.keys(AVATAR_CATALOG), expectedKeys);
  assert.equal(AVATAR_CATALOG['gesture:beat'], undefined);
  const tail = Math.max(...Object.values(OVERLAP.enter)) + .02;
  for (const [key, actual] of Object.entries(AVATAR_CATALOG)) {
    const original = DEFAULT_CATALOG[key];
    assert.ok(Object.isFrozen(actual));
    if (original && original.slot !== 'body') { assert.deepEqual(actual, original); continue; }
    const def = GESTURES[key.slice('gesture:'.length)], p = def.phases.prepare[1], r = def.phases.recover[0];
    const bound = (p * MOTION_DEFAULTS.maxStretch + r - p
      + (def.duration + tail - r) * MOTION_DEFAULTS.maxStretch) / .97;
    assert.ok(actual.duration >= bound && actual.duration < bound + .052, key);
    if (original) assert.deepEqual({ ...actual, duration: original.duration }, original);
    else assert.deepEqual(actual, { duration: actual.duration, apex: def.apex, cooldown: def.cooldown, slot: 'body' });
  }
});

test('idle construction sets natural speed one without claiming or cancelling any epoch', () => {
  const f = fixture({ start: false });
  assert.deepEqual(f.motion.options, { intensity: 1, speed: 1, natural: true });
  assert.equal(f.motion.epoch, 0); assert.equal(f.face.epoch, 0);
  assert.equal(f.audio.cancelCount, 0); assert.deepEqual(f.events, []);
  assert.equal(f.sink({ type: 'retract', identity: B, atWall: 0 }), false);
  f.motion.begin(4);
  const before = f.motion.snapshot();
  assert.equal(f.sink({ type: 'begin', identity: B, atWall: 0 }), false);
  assert.deepEqual(f.motion.snapshot(), before);
});

test('face expressions, head actions and real bone gestures share one playback clock', () => {
  const f = fixture();
  assert.equal(f.cue('wave').accepted, true);
  assert.equal(f.scheduler.enqueue({ ...A, id: 'smile', kind: 'expression', preset: 'smile', at: 0 }).accepted, true);
  assert.equal(f.scheduler.enqueue({ ...A, id: 'nod', kind: 'action', action: 'nod', at: 0 }).accepted, true);
  f.dispatch(); f.advance(.25);
  assert.equal(f.face.activePreset, 'smile'); assert.ok(f.face.activeActions.includes('nod'));
  assert.equal(f.motion.snapshot().gestures[0].gesture, 'wave');
  assert.equal(f.motion.time, f.face.time); assert.ok(f.motion.locals.size > 20);
});

test('natural ended tail is retracted before the next begin, including queued wall gestures', () => {
  const f = fixture(); f.cue('wave', 'old-wave'); f.dispatch(); f.advance(.8); f.ended();
  assert.equal(f.motion.active, false);
  assert.equal(f.motion.snapshot().gestures[0].clock, 'wall');
  assert.equal(f.motion.snapshot().gestures[0].recovering, false);
  assert.equal(f.motion.enqueue({ id: 'old-manual', kind: 'gesture', gesture: 'chest', clock: 'wall', at: f.now() + 5 }), true);
  f.begin(B);
  const old = f.motion.snapshot().gestures.find(g => g.id === 'old-wave');
  assert.equal(old.recovering, true); assert.equal(f.motion.pending.length, 0);
  assert.equal(f.motion.epoch, 2); assert.equal(f.motion.active, true);
  f.advance(1.6);
  assert.equal(f.motion.snapshot().gestures.length, 0);
  assert.equal(f.scheduler.snapshot().fault, null);
});

test('explicit same-owner retract still works after ended and is idempotent', () => {
  const f = fixture(); f.cue('explain'); f.dispatch(); f.advance(.75); f.ended();
  const command = { type: 'retract', identity: A, atWall: f.now() };
  assert.equal(f.sink(command), true);
  assert.ok(f.motion.snapshot().recovering);
  const recoveryStart = f.motion.gestures[0].recoverStart;
  f.advance(.1, { playing: false });
  assert.equal(f.sink({ ...command, atWall: f.now() }), true);
  assert.equal(f.motion.gestures[0].recoverStart, recoveryStart);
  f.advance(1.6, { playing: false });
  assert.equal(f.motion.snapshot().gestures.length, 0);
});

test('ended immediately followed by begin also retracts before the deferred clock rebase', () => {
  const f = fixture(); f.cue('chest', 'old'); f.dispatch(); f.advance(.7);
  Object.assign(f.audio, { status: 'ended', sourceActive: false });
  assert.equal(f.scheduler.playback({ ...A, status: 'ended', time: f.media() }), true);
  assert.equal(f.motion.rebase, true); assert.equal(f.motion.gestures[0].clock, 'audio');
  f.begin(B);
  assert.equal(f.motion.rebase, false); assert.ok(f.motion.gestures[0].recovering);
  f.advance(1.6); assert.equal(f.motion.gestures.length, 0);
});

for (const phase of ['prepare', 'stroke', 'hold', 'recover']) {
  test(`interrupt during ${phase} stops audio synchronously and retracts on wall time`, () => {
    const f = fixture(); f.cue('wave', 'wave'); f.cue('chest', 'future', 10); f.dispatch();
    for (let frames = 0; frames < 360 && f.motion.snapshot().gestures[0]?.phase !== phase; frames++) f.advance(STEP);
    assert.equal(f.motion.snapshot().gestures[0]?.phase, phase);
    const mediaAtStop = f.media();
    assert.equal(f.scheduler.interrupt(A), true);
    assert.equal(f.audio.sourceActive, false); assert.equal(f.audio.cancelCount, 1);
    assert.equal(f.face.active, false); assert.equal(f.motion.active, false);
    assert.equal(f.motion.snapshot().queued, 0); assert.ok(f.motion.snapshot().recovering);
    const commands = f.events.slice(-3).map(c => c.type);
    assert.deepEqual(commands, ['stop_audio', 'retract', 'posture']);
    assert.equal(f.cue('chest', 'late').accepted, false);
    f.advance(1.6, { playing: false });
    assert.equal(f.motion.time, mediaAtStop);
    assert.equal(f.motion.snapshot().gestures.length, 0);
    assert.equal(f.scheduler.snapshot().fault, null);
  });
}

test('paused interruption retracts even though the audio clock never advances', () => {
  const f = fixture(); f.cue('chest'); f.dispatch(); f.advance(.8);
  assert.equal(f.scheduler.playback({ ...A, status: 'paused', time: f.media() }), true);
  f.advance(.5, { playing: false });
  assert.equal(f.scheduler.interrupt(A), true);
  f.advance(1.7, { playing: false });
  assert.equal(f.motion.snapshot().gestures.length, 0);
  assert.equal(f.audio.sourceActive, false);
});

for (const gesture of GESTURE_IDS) {
  test(`${gesture} holds body slot through stretched completion without a sink fault`, () => {
    const f = fixture(); const occupied = AVATAR_CATALOG[`gesture:${gesture}`].duration;
    f.cue(gesture, 'first', 0);
    f.cue('wave', 'premature', GESTURES[gesture].duration + .01);
    f.cue('explain', 'next', occupied + .1);
    f.dispatch();
    // Exercise the actual controller's inverse time warp at its permitted
    // slowest corner, independently of seed and starting hand distance.
    Object.assign(f.motion.gestures[0], {
      stretch: MOTION_DEFAULTS.maxStretch, recoverStretch: MOTION_DEFAULTS.maxStretch, rate: .97,
    });
    f.advance(GESTURES[gesture].duration + .02);
    assert.equal(f.motion.snapshot().gestures[0].id, 'first', 'nominal duration is too short for this track');
    f.advance(occupied - f.media());
    assert.equal(f.motion.snapshot().gestures.length, 0, 'real body track finished by catalog ceiling');
    assert.equal(f.scheduler.snapshot().counts.dispatched, 1);
    assert.ok(f.scheduler.snapshot().events.some(e => e.id === 'premature' && e.reason === 'busy_or_cooldown'));
    f.advance(.15);
    assert.equal(f.scheduler.snapshot().counts.dispatched, 2);
    assert.equal(f.motion.snapshot().gestures[0].id, 'next');
    assert.equal(f.motion.rejected, 0); assert.equal(f.scheduler.snapshot().fault, null);
  });
}

test('stale identity cannot retract a newer response, even with a reused epoch', () => {
  const f = fixture(); f.cue('wave'); f.dispatch(); f.advance(.4); f.begin(B);
  f.cue('chest', 'new-chest'); f.dispatch(); f.advance(.2);
  const before = f.motion.snapshot(), audioBefore = f.audio.snapshot();
  for (const identity of [A, { ...B, responseId: A.responseId }, { ...B, connectionId: A.connectionId }]) {
    for (const type of ['stop_audio', 'retract', 'begin', 'posture']) {
      assert.equal(f.sink({ type, identity, atWall: f.now(), posture: 'listening' }), false);
    }
  }
  assert.deepEqual(f.motion.snapshot(), before); assert.deepEqual(f.audio.snapshot(), audioBefore);
  f.audio.epoch = 3;
  assert.equal(f.sink({ type: 'retract', identity: B, atWall: f.now() }), false);
  assert.deepEqual(f.motion.snapshot(), before);
});

test('current owner cannot modify a future face or body epoch and invalid wall time never retracts', () => {
  for (const component of ['face', 'motion']) {
    const f = fixture(); f.cue('wave'); f.dispatch(); f.advance(.4);
    f[component].begin(3);
    const before = f.motion.snapshot(), audioBefore = f.audio.snapshot();
    for (const type of ['begin', 'retract', 'stop_audio', 'posture']) {
      assert.equal(f.sink({ type, identity: type === 'begin' ? B : A, atWall: f.now() }), false);
    }
    assert.deepEqual(f.motion.snapshot(), before); assert.deepEqual(f.audio.snapshot(), audioBefore);
  }
  const f = fixture(); f.cue('wave'); f.dispatch(); f.advance(.4);
  const before = f.motion.snapshot();
  for (const atWall of [NaN, Infinity, -1, undefined]) {
    assert.equal(f.sink({ type: 'retract', identity: A, atWall }), false);
  }
  assert.deepEqual(f.motion.snapshot(), before);
});

test('cleanup still retracts real body tracks when face cancellation fails', () => {
  const f = fixture(); f.cue('wave'); f.dispatch(); f.advance(.8);
  f.face.cancel = () => { throw new Error('injected face failure'); };
  assert.equal(f.scheduler.interrupt(A), false);
  assert.equal(f.scheduler.snapshot().status, 'fault'); assert.equal(f.audio.sourceActive, false);
  assert.ok(f.motion.snapshot().recovering);
  f.advance(1.6, { playing: false }); assert.equal(f.motion.snapshot().gestures.length, 0);
});

test('body retract is still attempted when the body cancel callback itself fails', () => {
  const f = fixture(); f.cue('wave'); f.dispatch(); f.advance(.8);
  f.motion.cancel = () => { throw new Error('injected motion cancellation failure'); };
  assert.equal(f.scheduler.interrupt(A), false);
  assert.equal(f.scheduler.snapshot().status, 'fault'); assert.equal(f.audio.sourceActive, false);
  assert.ok(f.motion.snapshot().recovering);
  f.advance(1.6, { playing: false }); assert.equal(f.motion.snapshot().gestures.length, 0);
});
