import test from 'node:test';
import assert from 'node:assert/strict';
import { GESTURES } from '../preview/core/motion-profile.js';
import { makeMotion, poseSample } from '../scripts/check-coordinated-motion.mjs';

// Exercise the live clock, travel stretches, orientation lag and real PMX FK.
// Faster authoring alone is insufficient if playback smooths away the wave.
function trace(id) {
  const c = makeMotion(), frames = [], fps = 240;
  c.trigger(id, `crisp-${id}`, 2);
  for (let i = 1; i <= 6 * fps; i++) {
    c.update(2 + i / fps, 1 / fps);
    const cue = c.snapshot().gestures[0], pose = poseSample(c);
    frames.push({ time: i / fps, age: cue?.age, wrist: pose.hands.R[0][0], finger: pose.hands.R[3][0] });
  }
  return { frames, speed: c.options.speed };
}

function reversals(frames, part, start, end) {
  return frames.filter((f, i, a) => i > 0 && i < a.length - 1 && f.age >= start && f.age <= end
    && (f[part] - a[i - 1][part]) * (a[i + 1][part] - f[part]) < 0);
}

test('wave retains four visible wrist and fingertip reversals at a brisk live tempo', () => {
  const { frames, speed } = trace('wave');
  assert.equal(speed, 1, 'the faster wave must not depend on global playback speed');
  for (const [part, minimumTravel] of [['wrist', .45], ['finger', 1.1]]) {
    const turns = reversals(frames, part, .65, 1.3);
    assert.equal(turns.length, 4, `${part}: four alternating extremes must survive playback`);
    for (let i = 1; i < turns.length; i++) {
      const halfPeriod = turns[i].time - turns[i - 1].time;
      assert.ok(halfPeriod >= .13 && halfPeriod <= .21, `${part}: reversal interval ${halfPeriod}s`);
      assert.ok(Math.abs(turns[i][part] - turns[i - 1][part]) >= minimumTravel, `${part}: fast motion lost visible sweep`);
    }
  }
  assert.ok(frames.filter(f => f.age !== undefined).at(-1).time < 3.7, 'default-speed relaxed playback remains needlessly long');
});

test('greet performs a short visible sweep instead of holding between directions', () => {
  const { frames, speed } = trace('greet');
  assert.equal(speed, 1);
  for (const [part, minimumTravel] of [['wrist', .2], ['finger', .9]]) {
    const turns = reversals(frames, part, .8, 1.18);
    assert.equal(turns.length, 2, `${part}: one out-and-back greeting must remain visible`);
    const halfPeriod = turns[1].time - turns[0].time;
    assert.ok(halfPeriod >= .13 && halfPeriod <= .23, `${part}: reversal interval ${halfPeriod}s`);
    assert.ok(Math.abs(turns[1][part] - turns[0][part]) >= minimumTravel, `${part}: greeting sweep filtered away`);
  }
  assert.ok(frames.filter(f => f.age !== undefined).at(-1).time < 3.5, 'default-speed greeting remains needlessly long');
});

test('brisk waves keep natural lift/recovery and align their strongest smile with the hand accent', () => {
  for (const id of ['wave', 'greet']) {
    const g = GESTURES[id];
    assert.ok(g.phases.prepare[1] >= .5, `${id}: lift was globally sped up`);
    assert.ok(g.duration - g.phases.recover[0] >= .69, `${id}: recovery was cut short`);
    const peakSmile = g.expression.keys.reduce((a, b) => (b[1].smile ?? 0) > (a[1].smile ?? 0) ? b : a);
    assert.equal(peakSmile[0], g.apex, `${id}: face and hand accents are out of sync`);
  }
});
