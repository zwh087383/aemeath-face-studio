import test from 'node:test';
import assert from 'node:assert/strict';
import { GESTURES, GESTURE_IDS } from '../preview/core/motion-profile.js';
import { C, CHANNELS, VOWELS } from '../preview/core/profile.js';
import { forwardKinematics } from '../preview/core/motion-skeleton.js';
import { qconj, qrotate, sub } from '../preview/core/motion-math.js';
import { distance, rotationDistance, makeMotion, poseSample, sampleGesture, summarize } from '../scripts/check-coordinated-motion.mjs';

const maxHandDelta = (a, b) => Math.max(...['L', 'R'].flatMap(s => a.hands[s].map((p, i) => distance(p, b.hands[s][i]))));
const step = (c, from, seconds, fps = 60) => {
  for (let i = 1; i <= Math.round(seconds * fps); i++) c.update(from + i / fps, 1 / fps);
};

test('look-up lifts the actual world head and chest; bow carries the head, torso and hands forward', () => {
  const up = sampleGesture('look_up'), bow = sampleGesture('bow_smile');
  const u = summarize(up), b = summarize(bow);
  assert.ok(u.ranges.head.pitchMin < -.08, `look-up head ${u.ranges.head.pitchMin}`);
  assert.ok(u.ranges.upperChest.pitchMin < -.012, 'look-up must open chest, not only neck');
  assert.ok(u.eyesPitchRange > .01, 'look-up gaze has an independent visible contribution');
  assert.ok(b.ranges.spine.pitchMax > .08, `bow waist ${b.ranges.spine.pitchMax}`);
  assert.ok(b.ranges.head.pitchMax > .1, `bow world head ${b.ranges.head.pitchMax}`);
  assert.ok(b.ranges.head.translation > .3, 'bow moves head through space');
  assert.ok(Math.max(...bow.frames.map(f => maxHandDelta(f, bow.baseline))) > .3, 'bow carries the hands');
  for (const trace of [up, bow]) assert.equal(trace.c.snapshot().gestures.length, 0, 'complete finite lifecycle');
});

test('all authored body fields survive composition, including neck-forward and gaze-pitch', () => {
  // A controlled track isolates the old six-component truncation defect without
  // relying on any particular artist-authored key to happen to exercise it.
  const c = makeMotion();
  const def = c.profile.gestures.explain;
  for (const values of def.compiled.body.values) { values[6] = .12; values[7] = -.16; }
  for (const tangent of def.compiled.body.tangents) { tangent[6] = 0; tangent[7] = 0; }
  c.inspect('explain', def.apex); step(c, 2, 1);
  assert.ok(c.work.body[6] > .1, `neck-forward discarded: ${c.work.body[6]}`);
  assert.ok(c.work.body[7] < -.14, `gaze-pitch discarded: ${c.work.body[7]}`);
  assert.ok(Math.abs(c.head.eyesPitch) > .01, 'gaze track reaches actual eye rotation');
});

test('every authored action changes torso as well as limbs, remains finite, and returns fully', () => {
  for (const id of GESTURE_IDS) {
    const trace = sampleGesture(id), summary = summarize(trace);
    assert.ok(summary.ranges.upperChest.rotation > .005, `${id}: inert torso`);
    assert.ok(Math.max(...trace.frames.map(f => maxHandDelta(f, trace.baseline))) > .05, `${id}: inert hands`);
    for (const frame of trace.frames) {
      for (const [part, p] of Object.entries(frame.parts)) {
        assert.ok(p.position.every(Number.isFinite) && p.rotation.every(Number.isFinite), `${id}/${part}: nonfinite pose`);
        assert.ok(Math.abs(Math.hypot(...p.rotation) - 1) < 1e-6, `${id}/${part}: nonunit quaternion`);
      }
      assert.ok(Math.abs(frame.parts.head.pitch) < 1.1, `${id}: unsafe world pitch`);
      assert.ok(Math.abs(frame.eyes.pitch) < .5 && Math.abs(frame.eyes.yaw) < .6, `${id}: eye range`);
    }
    assert.equal(summary.remaining, 0, `${id}: action never ended`);
    assert.ok(maxHandDelta(trace.frames.at(-1), trace.baseline) < .02, `${id}: residual pose after completion`);
  }
});

test('replacement and cancellation preserve continuous hand paths and bounded torso/head speed', () => {
  for (const [id, replacement] of [['wave', 'bow_smile'], ['bow_smile', 'look_up'], ['look_up', 'explain'], ['laugh', 'think']]) {
    for (const replaceWith of [undefined, replacement]) for (const stopAt of [.22, .85, 1.6]) {
      const trace = sampleGesture(id, { stopAt, replaceWith }), s = summarize(trace);
      const label = `${id}/${replaceWith ?? 'cancel'}@${stopAt}`;
      assert.ok(s.wristSpeed < 24, `${label}: wrist ${s.wristSpeed} model units/s`);
      assert.ok(s.tipSpeed < 40, `${label}: fingertips ${s.tipSpeed} model units/s`);
      assert.ok(s.rotationSpeed.head < 4, `${label}: head ${s.rotationSpeed.head} rad/s`);
      assert.ok(s.rotationSpeed.upperChest < 3, `${label}: chest ${s.rotationSpeed.upperChest} rad/s`);
      assert.equal(s.remaining, 0, label);
    }
  }
});

test('30 and 120 FPS follow comparable spatial paths at matched elapsed times', () => {
  for (const id of ['look_up', 'bow_smile', 'wave', 'laugh']) {
    const low = sampleGesture(id, { fps: 30 }), high = sampleGesture(id, { fps: 120 });
    let hands = 0, head = 0;
    for (let i = 0; i < low.frames.length; i++) {
      const a = low.frames[i], b = high.frames[(i + 1) * 4 - 1];
      if (!b) break;
      hands = Math.max(hands, maxHandDelta(a, b));
      head = Math.max(head, rotationDistance(a.parts.head.rotation, b.parts.head.rotation));
    }
    assert.ok(hands < .22, `${id}: 30/120 FPS hand deviation ${hands}`);
    assert.ok(head < .055, `${id}: 30/120 FPS head deviation ${head}`);
  }
});

test('speed changes actual performance duration while fastest supported playback stays bounded', () => {
  for (const id of ['bow_smile', 'look_up', 'wave', 'shrug']) {
    const slow = sampleGesture(id, { speed: .6, fps: 30 }), fast = sampleGesture(id, { speed: 1.4, fps: 30 });
    const lastActive = trace => trace.frames.filter(f => maxHandDelta(f, trace.baseline) > .05).at(-1).time;
    assert.ok(lastActive(fast) < lastActive(slow) * .7, `${id}: speed has no practical timing effect`);
    const summary = summarize(fast, 30);
    assert.ok(summary.wristSpeed < 26 && summary.tipSpeed < 43, `${id}: fastest playback exceeds 1.4x travel bounds`);
    assert.equal(summary.remaining, 0);
  }
});

test('torso motion carries arm targets in the chest frame instead of leaving wrists behind', () => {
  const c = makeMotion('speaking'), before = poseSample(c);
  const relativeHands = sample => ['L', 'R'].map(side => qrotate(qconj(sample.parts.upperChest.rotation), sub(sample.hands[side][0], sample.parts.upperChest.position)));
  const reference = relativeHands(before);
  c.work.body.fill(0); c.work.body[0] = .22;
  for (let i = 1; i <= 180; i++) c.compose(2 + i / 60, 1 / 60, c.work.arm, c.work.body);
  const after = poseSample(c), actual = relativeHands(after);
  assert.ok(maxHandDelta(before, after) > .4, 'wrists move with chest');
  for (let i = 0; i < 2; i++) assert.ok(distance(reference[i], actual[i]) < .08, `arm ${i} chest-relative target slipped`);
});

test('pelvis support shifts preserve planted ankle positions and finite knee rotations', () => {
  for (const id of ['bow_smile', 'look_up', 'laugh', 'curious']) {
    const c = makeMotion();
    assert.equal(Object.keys(c.rig.legs).length, 2, 'real PMX has both leg chains');
    const reference = forwardKinematics(c.rig, c.locals);
    const feet = Object.fromEntries(Object.entries(c.rig.legs).map(([side, leg]) => [side, [...reference.get(leg.names.ankle).position]]));
    c.trigger(id, `support-${id}`, 2);
    let maxShift = 0;
    for (let i = 1; i <= 360; i++) {
      c.update(2 + i / 60, 1 / 60);
      const fk = forwardKinematics(c.rig, c.locals);
      for (const [side, leg] of Object.entries(c.rig.legs)) {
        const ankle = fk.get(leg.names.ankle), knee = fk.get(leg.names.knee);
        assert.ok(distance(feet[side], ankle.position) < .04, `${id}/${side}: foot slides ${distance(feet[side], ankle.position)}`);
        assert.ok(knee.rotation.every(Number.isFinite));
      }
      for (const delta of c.locals.translations?.values() ?? []) maxShift = Math.max(maxShift, Math.hypot(...delta));
    }
    assert.ok(maxShift > .005, `${id}: pelvis never participates`);
  }
});

test('a directed glance moves world gaze before the head and recruits chest later', () => {
  const c = makeMotion(), samples = [];
  for (let i = 1; i <= 180; i++) {
    c.update(2 + i / 60, 1 / 60, { face: { pitch: 0, yaw: .2, roll: 0 }, actions: ['glance'] });
    samples.push({ time: i / 60, ...poseSample(c) });
  }
  const last = samples.at(-1);
  const halfway = part => samples.find(frame => frame.parts[part].yaw >= last.parts[part].yaw * .5).time;
  assert.ok(last.parts.upperChest.yaw > .01, 'chest responds to head direction');
  assert.ok(halfway('eyes') < halfway('head'), `gaze ${halfway('eyes')} head ${halfway('head')}`);
  assert.ok(halfway('head') < halfway('upperChest'), 'chest follows the head rather than moving as one rigid block');
});

test('paused audio motion cannot advance its gesture; old epochs cannot restart it', () => {
  const c = makeMotion(); c.begin(41);
  assert.equal(c.enqueue({ id: 'audio-bow', kind: 'gesture', gesture: 'bow_smile', epoch: 41, clock: 'audio', at: 0 }), true);
  for (let i = 1; i <= 60; i++) { c.playback(41, 'playing', i / 60); c.update(2 + i / 60, 1 / 60); }
  c.playback(41, 'paused', 1); step(c, 3, .5);
  const age = c.snapshot().gestures[0].age, frozen = poseSample(c);
  step(c, 3.5, 1);
  assert.equal(c.snapshot().gestures[0].age, age);
  assert.ok(maxHandDelta(frozen, poseSample(c)) < .02, 'paused pose does not drift after springs settle');
  assert.equal(c.begin(42), true);
  assert.equal(c.playback(41, 'playing', 2), false);
  assert.equal(c.enqueue({ id: 'stale', kind: 'gesture', gesture: 'look_up', epoch: 41, clock: 'audio', at: 1 }), false);
  assert.equal(c.cancel(41), false);
  step(c, 4.5, 4);
  assert.ok(c.snapshot().gestures.every(g => g.epoch === 42), 'old epoch fully retracts');
});

test('authored smile coordinates brows, eyes and mouth instead of changing only a mouth corner', async () => {
  const { sampleGestureExpression } = await import('../preview/core/expression-choreography.js');
  const def = GESTURES.bow_smile;
  let brow = 0, eyes = 0, mouth = 0;
  for (let t = 0; t <= def.duration; t += 1 / 60) {
    const w = sampleGestureExpression('bow_smile', t);
    assert.equal(w.length, CHANNELS.length);
    assert.ok([...w].every(v => Number.isFinite(v) && v >= 0 && v <= 1));
    brow = Math.max(brow, w[C.browSmile]);
    eyes = Math.max(eyes, w[C.eyeSmile], w[C.smileEyes]);
    mouth = Math.max(mouth, w[C.smile]);
  }
  assert.ok(brow > .05 && eyes > .08 && mouth > .1, `smile is not whole-face: ${brow}/${eyes}/${mouth}`);
});

test('expression overlay preserves live vowels, shape controls and caller-owned arrays', async () => {
  const { blendExpressionOverlay, sampleGestureExpression } = await import('../preview/core/expression-choreography.js');
  const base = new Float32Array(CHANNELS.length);
  const protectedChannels = [...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat];
  protectedChannels.forEach((index, i) => { base[index] = (i + 1) / 10; });
  const before = [...base], overlay = sampleGestureExpression('laugh', GESTURES.laugh.apex), overlayBefore = [...overlay];
  const mixed = blendExpressionOverlay(base, overlay, { speechActivity: 1, closure: .7 });
  for (const index of protectedChannels) assert.equal(mixed[index], base[index], CHANNELS[index]);
  assert.deepEqual([...base], before, 'must not overwrite FaceController borrowed array');
  assert.deepEqual([...overlay], overlayBefore, 'must not overwrite choreographer borrowed array');
  assert.ok([...mixed].every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.ok(mixed[C.browSmile] > 0 || mixed[C.smileEyes] > 0, 'expression remains visible during speech');
});

test('expression follows the live gesture clock, freezes on pause, and decays continuously on cancellation', async () => {
  const { ExpressionChoreographer } = await import('../preview/core/expression-choreography.js');
  const c = makeMotion(), e = new ExpressionChoreographer(); c.begin(1);
  c.trigger('bow_smile', 'face-clock', 2);
  let now = 2;
  for (let i = 1; i <= 90; i++) {
    now = 2 + i / 60; c.playback(1, 'playing', i / 60); c.update(now, 1 / 60); e.update(now, c.snapshot().gestures);
  }
  const beforePause = [...e.weights];
  assert.ok(beforePause[C.smile] > .05, 'face must be visibly active before pause');
  c.playback(1, 'paused', 1.5);
  for (let i = 1; i <= 60; i++) { c.update(now + i / 60, 1 / 60); e.update(now + i / 60, c.snapshot().gestures, { paused: true }); }
  assert.deepEqual([...e.weights], beforePause);
  now += 1; c.cancel(1, now);
  let previous = [...e.weights], biggestStep = 0;
  for (let i = 1; i <= 240; i++) {
    c.update(now + i / 60, 1 / 60);
    const next = [...e.update(now + i / 60, c.snapshot().gestures)];
    biggestStep = Math.max(biggestStep, ...next.map((v, j) => Math.abs(v - previous[j])));
    previous = next;
  }
  assert.ok(biggestStep < .08, `expression popped on cancel: ${biggestStep}`);
  assert.ok(Math.max(...e.weights) < .001, 'cancelled smile must not stick');
});
