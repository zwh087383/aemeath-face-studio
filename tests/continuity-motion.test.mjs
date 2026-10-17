import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMotion, poseSample, distance, skinCoordinated } from '../scripts/check-coordinated-motion.mjs';
import { loadModel } from '../scripts/check-motion-clearance.mjs';
import { sleeveHairModel, checkSleeveHair } from '../scripts/check-wave-clearance.mjs';
import { continueScalar, inertialOffset } from '../preview/core/continuity-math.js';

const make = () => makeMotion('relaxed', { continuity: true });
function advance(c, seconds, input = {}, each) {
  const start = c.now, count = Math.round(seconds * 120);
  for (let i = 1; i <= count; i++) { c.update(start + i / 120, 1 / 120, input); each?.(); }
}
const identity = generation => ({ connectionId: 'test-connection', interactionGeneration: generation, body: {} });

test('boundary offset preserves incoming velocity and reaches exact target with no residual', () => {
  const value = inertialOffset(2, -.7, 0, .6);
  assert.equal(value.value, 2); assert.equal(value.velocity, -.7);
  const end = continueScalar(.1, -.2, .16, .6, .6);
  assert.ok(Math.abs(end.value - .16) < 1e-12 && Math.abs(end.velocity) < 1e-12);
});

test('single downstroke inherits a bowed or moving head and does not automatically rebound', () => {
  for (const moving of [false, true]) {
    const c = make(), input = { behavior: { body: { headPitch: .08 } } };
    advance(c, moving ? .08 : 1.5, input);
    const previous = c.head.pitch, velocity = c.springs.headPitch.v;
    assert.ok(c.requestReaction({ id: 'nod', kind: 'nod', strength: .6 }));
    c.update(c.now + .0001, .0001, input);
    assert.ok(Math.abs((c.head.pitch - previous) / .0001 - velocity) < .005);
    const samples = [];
    advance(c, 1.2, input, () => samples.push(c.head.pitch));
    assert.ok(samples.at(-1) > previous + .035, 'hold remains lower than the inherited start');
    assert.ok(samples.slice(55).every(x => Math.abs(x - samples.at(-1)) < 1e-9), 'no fixed bounce or zero reset');
    advance(c, .7, { behavior: { body: { headPitch: -.02 } } });
    assert.ok(c.head.pitch < .01, 'a changed attention target releases the held head');
  }
});

test('rest positions remain stable without a timer and next expression inherits their actual wrists', () => {
  const a = make(), b = make();
  assert.ok(b.requestReaction({ id: 'ready', kind: 'rest', rest: 'ready' }));
  advance(b, 1.2);
  const initialA = poseSample(a), initialB = poseSample(b);
  assert.ok(distance(initialA.hands.R[0], initialB.hands.R[0]) > 1);
  for (const c of [a, b]) assert.ok(c.requestReaction({ id: 'light', kind: 'light-explain', strength: .7 }));
  a.update(a.now + .0001, .0001); b.update(b.now + .0001, .0001);
  assert.ok(distance(initialA.hands.R[0], poseSample(a).hands.R[0]) < .001);
  assert.ok(distance(initialB.hands.R[0], poseSample(b).hands.R[0]) < .001);
  advance(a, .08); advance(b, .08);
  assert.ok(distance(poseSample(a).hands.R[0], poseSample(b).hands.R[0]) > .8, 'different starts do not first reset to a shared pose');
  advance(b, 3);
  const settled = poseSample(b), rest = b.snapshot().execution.rest;
  advance(b, 15);
  assert.equal(b.snapshot().execution.rest, rest);
  assert.ok(distance(settled.hands.R[0], poseSample(b).hands.R[0]) < .01);
});

test('audio nod waits for playback, pauses, and cannot survive cancellation or generation replacement', () => {
  const c = make(); c.update(c.now + .01, .01, { behavior: identity(1) }); c.begin(1);
  assert.ok(c.requestReaction({ id: 'audio-nod', kind: 'nod', clock: 'audio', epoch: 1, audioAt: .3 }));
  advance(c, .3, { behavior: identity(1) });
  assert.equal(c.snapshot().execution.lastAccepted, null);
  c.playback(1, 'playing', .3); c.update(c.now + .01, .01, { behavior: identity(1) });
  assert.equal(c.snapshot().execution.lastAccepted.id, 'audio-nod');
  c.playback(1, 'playing', .4); c.update(c.now + .1, .1, { behavior: identity(1) });
  c.playback(1, 'paused', .4); const pitch = c.head.pitch;
  advance(c, .7, { paused: true, behavior: identity(1) });
  assert.equal(c.head.pitch, pitch);
  c.cancel(1, c.now);
  assert.equal(c.snapshot().execution.nod, null);
  assert.equal(c.continuity.pendingReactions.length, 0);
  c.update(c.now + .01, .01, { behavior: identity(2) });
  assert.equal(c.requestReaction({ id: 'old-listener', kind: 'nod', connectionId: 'test-connection', interactionGeneration: 1 }), false);
});

test('no-response listener reacts once, wall pause freezes it, and occupied-head rejection is never replayed later', () => {
  const c = make(), behavior = identity(1);
  c.update(c.now + .01, .01, { behavior });
  assert.ok(c.requestReaction({ id: 'listener', kind: 'nod', connectionId: behavior.connectionId, interactionGeneration: 1 }));
  advance(c, .08, { behavior }); const pitch = c.head.pitch;
  advance(c, .6, { behavior, paused: true });
  assert.ok(Math.abs(c.head.pitch - pitch) < 1e-12);
  assert.equal(c.requestReaction({ id: 'listener', kind: 'nod' }), false);
  c.retract(); advance(c, 1, { behavior });
  c.trigger('wave', 'head-occupied', c.now); c.update(c.now + .02, .02, { behavior });
  assert.equal(c.requestReaction({ id: 'stale-proposal', kind: 'nod' }), false);
  c.retract(); advance(c, 2, { behavior });
  assert.equal(c.requestReaction({ id: 'stale-proposal', kind: 'nod' }), false);
  assert.equal(c.snapshot().parts.gaze, 'available');
});

test('existing wave and greet retain exact body amplitude, close elbows and crisp stroke sampling before their new exit', () => {
  for (const gesture of ['wave', 'greet']) {
    const old = makeMotion(), current = make();
    old.trigger(gesture, 'same-cue', 2); current.trigger(gesture, 'same-cue', 2);
    let strokeFrames = 0;
    for (let i = 1; i <= 200; i++) {
      const now = 2 + i / 60; old.update(now, 1 / 60); current.update(now, 1 / 60);
      const phase = current.snapshot().gestures[0]?.phase;
      if (phase === 'recover' || !phase) break;
      if (phase === 'stroke') strokeFrames++;
      assert.deepEqual(current.snapshot().body, old.snapshot().body);
      for (const name of ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首']) {
        assert.deepEqual(current.locals.get(name), old.locals.get(name), `${gesture}: preserved ${name}`);
      }
    }
    assert.ok(strokeFrames > 20, 'compared the actual moving stroke, not only its endpoints');
  }
});

test('expired listening opportunities are tombstoned and no-op rests do not claim an execution', () => {
  const c = make(), behavior = identity(1);
  c.update(c.now + .01, .01, { behavior });
  assert.equal(c.requestReaction({ id: 'noop', kind: 'rest', rest: 'low' }), false);
  assert.equal(c.snapshot().execution.lastAccepted, null);
  const proposal = { id: 'expired', kind: 'listen-adjust', connectionId: behavior.connectionId, interactionGeneration: 1,
    now: c.now - .21, expiresAt: c.now - .01 };
  assert.equal(c.requestReaction(proposal), false);
  assert.equal(c.requestReaction({ ...proposal, now: c.now, expiresAt: c.now + .2 }), false);
  assert.equal(c.requestReaction({ id: 'zero-strength', kind: 'nod', strength: 0 }), false);
  assert.equal(c.requestReaction({ id: 'invalid-strength', kind: 'nod', strength: NaN }), false);
  assert.equal(c.snapshot().execution.lastAccepted, null);
});

test('an accepted audio nod finishes on the local clock after the final audible sample', () => {
  const c = make(); c.begin(1);
  assert.ok(c.requestReaction({ id: 'short-audio', kind: 'nod', clock: 'audio', epoch: 1, audioAt: 0 }));
  c.playback(1, 'playing', .1); c.update(c.now + .1, .1);
  const midStroke = c.head.pitch;
  c.playback(1, 'ended', .1); advance(c, .8);
  assert.ok(c.head.pitch > midStroke + .02);
  assert.equal(c.snapshot().execution.nod.phase, 'hold');
  assert.equal(c.continuity.nod.clock, 'wall');
});

test('handoff inherits an omitted pause flag without changing explicit host pause semantics', () => {
  const setup = () => {
    const c = make(); c.begin(1);
    assert.ok(c.requestReaction({ id: 'pause-handoff', kind: 'light-explain', clock: 'audio', epoch: 1, audioAt: 0 }));
    for (let i = 1; i <= 12; i++) {
      c.playback(1, 'playing', i / 120); c.update(2 + i / 120, 1 / 120, { paused: false });
    }
    c.playback(1, 'paused', .1);
    return c;
  };
  const implicit = setup(), explicit = setup(), buffering = setup();
  const frozen = [...implicit.work.arm.R], start = implicit.now;
  for (let i = 1; i <= 60; i++) {
    const now = start + i / 120;
    implicit.update(now, 1 / 120);
    explicit.update(now, 1 / 120, { paused: true });
    buffering.update(now, 1 / 120, { paused: false });
    assert.deepEqual(implicit.work.arm.R, explicit.work.arm.R, 'omission and explicit pause must follow the same handoff');
    assert.ok(implicit.work.arm.R.every((value, index) => Math.abs(value - frozen[index]) < 1e-10), 'paused handoff stays put');
  }
  assert.ok(distance([...buffering.work.arm.R.slice(0, 3)], frozen.slice(0, 3)) > .1,
    'explicit false still overrides paused playback for a buffering host');
  for (const c of [implicit, explicit]) {
    c.playback(1, 'playing', .1 + 1 / 120); c.update(c.now + 1 / 120, 1 / 120, { paused: false });
  }
  assert.deepEqual(implicit.work.arm.R, explicit.work.arm.R, 'resume keeps existing explicit-host trajectory');
  assert.ok(distance([...implicit.work.arm.R.slice(0, 3)], frozen.slice(0, 3)) > .001);
  implicit.playback(1, 'paused', .1 + 1 / 120); implicit.cancel(1, implicit.now);
  advance(implicit, 1.5);
  assert.equal(implicit.snapshot().execution.handoff, null, 'cancelled motion still exits on local time');
  assert.equal(implicit.continuity.primitive, null);
});

test('prepare, stroke and hold interruption preserves the displayed FK boundary and never resumes the retired stroke', () => {
  for (const gesture of ['wave', 'greet', 'explain']) for (const phase of ['prepare', 'stroke', 'hold']) {
    const c = make(); c.trigger(gesture, `${gesture}-${phase}`, c.now);
    const start = c.now;
    for (let i = 1; i < 700; i++) {
      c.update(start + i / 120, 1 / 120);
      if (c.snapshot().gestures[0]?.phase === phase && (phase !== 'prepare' || i > 15)) break;
    }
    assert.equal(c.snapshot().gestures[0].phase, phase);
    const before = poseSample(c), at = c.now;
    c.retract(at); c.update(at + .0001, .0001);
    for (const side of ['L', 'R']) assert.ok(distance(before.hands[side][0], poseSample(c).hands[side][0]) < .002,
      `${gesture}/${phase}/${side} must start from displayed combined pose`);
    let maximumSpeed = 0, maximumAngularSpeed = 0;
    advance(c, 3, {}, () => {
      assert.ok(c.snapshot().gestures.every(g => g.recovering), 'retired sources only exit');
      for (const w of Object.values(c.snapshot().wrists)) {
        maximumSpeed = Math.max(maximumSpeed, Math.hypot(...w.linearVelocity));
        maximumAngularSpeed = Math.max(maximumAngularSpeed, Math.hypot(...w.angularVelocity));
      }
    });
    assert.ok(maximumSpeed < 24, `${gesture}/${phase}: wrist ${maximumSpeed}`);
    assert.ok(maximumAngularSpeed < 16, `${gesture}/${phase}: wrist rotation ${maximumAngularSpeed}`);
    assert.equal(c.snapshot().execution.handoff, null);
    assert.equal(c.snapshot().gestures.length, 0);
  }
});

test('new handoff retains existing sleeve-hair clearance heuristic during interrupted greetings', async () => {
  const model = sleeveHairModel(await loadModel());
  for (const gesture of ['wave', 'greet']) for (const phase of ['prepare', 'stroke', 'hold']) {
    const c = make(); c.trigger(gesture, `mesh-${gesture}`, c.now);
    const start = c.now;
    for (let i = 1; i < 180; i++) {
      c.update(start + i / 60, 1 / 60);
      if (c.snapshot().gestures[0]?.phase === phase && (phase !== 'prepare' || i > 10)) break;
    }
    c.retract();
    const exitStart = c.now;
    for (let i = 1; i <= 72; i++) {
      c.update(exitStart + i / 60, 1 / 60);
      if (i % 4) continue;
      const sample = checkSleeveHair(model, skinCoordinated(model, c.locals));
      assert.equal(sample.count, 0, `${gesture}/${phase}@${i}: ${JSON.stringify(sample)}`);
    }
  }
});
