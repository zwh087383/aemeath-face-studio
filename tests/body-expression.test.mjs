import test from 'node:test';
import assert from 'node:assert/strict';
import { GESTURES, GESTURE_IDS } from '../preview/core/motion-profile.js';
import { makeMotion, poseSample, rotationDistance, distance, summarize } from '../scripts/check-coordinated-motion.mjs';

// Semantic acceptance thresholds in actual PMX forward kinematics, not the
// authored Euler values. A 0.005-radian 'nonzero torso' check cannot distinguish
// a readable body performance from the nearly static 63199b1 legacy gestures.
// [minimum chest rotation degrees, maximum, minimum head displacement in model units]
const INTENT = {
  explain: [9, 15, .55], wave: [8, 14, .35], shrug: [6, 11, .45], chest: [11, 17, .7],
  bow_smile: [17, 23, 1.2], laugh: [9, 15, .55], curious: [14, 20, .95], shy: [9, 15, .45],
  explain_firm: [10, 16, .65], surprise: [9, 15, .7], think: [8, 14, .4], greet: [9, 15, .65],
  listen: [10, 15, .7], comfort: [12, 17, .8], look_up: [9, 14, .75], agree: [7.5, 12, .5],
};
const traces = new Map();
function trace(id) {
  if (traces.has(id)) return traces.get(id);
  const c = makeMotion(), baseline = poseSample(c), frames = [];
  c.trigger(id, `body-intent-${id}`, 2);
  for (let i = 1; i <= 600; i++) {
    c.update(2 + i / 60, 1 / 60);
    const cue = c.snapshot().gestures[0];
    frames.push({ time: i / 60, phase: cue?.phase, age: cue?.age, ...poseSample(c) });
  }
  const result = { c, baseline, frames };
  traces.set(id, result);
  return result;
}
const chestRange = (id, key) => {
  const frames = trace(id).frames;
  return [Math.min(...frames.map(f => f.parts.upperChest[key])), Math.max(...frames.map(f => f.parts.upperChest[key]))];
};

test('all sixteen performances meet purpose-specific visible chest and head travel ranges', () => {
  assert.deepEqual(Object.keys(INTENT).sort(), [...GESTURE_IDS].sort());
  for (const [id, [minimum, maximum, travel]] of Object.entries(INTENT)) {
    const s = summarize(trace(id)), degrees = s.ranges.upperChest.rotation * 180 / Math.PI;
    assert.ok(degrees >= minimum && degrees <= maximum, `${id}: chest ${degrees.toFixed(2)} degrees, expected ${minimum}..${maximum}`);
    assert.ok(s.ranges.head.translation >= travel, `${id}: head spatial travel ${s.ranges.head.translation} < ${travel}`);
    assert.ok(s.rotationSpeed.upperChest < 1.3, `${id}: chest jerk masquerading as amplitude`);
    assert.equal(s.remaining, 0);
    assert.ok(rotationDistance(trace(id).frames.at(-1).parts.upperChest.rotation, trace(id).baseline.parts.upperChest.rotation) < .001, `${id}: residual body pose`);
  }
});

test('legacy gestures replace the measured near-static baseline with distinct weight and torso intentions', () => {
  // Measured at 63199b1: peak upper-chest rotation 1.950/1.575/.641/1.640 deg.
  const before = { explain: 1.9500046, wave: 1.5754630, shrug: .6412028, chest: 1.6404131 };
  for (const [id, baseline] of Object.entries(before)) {
    const s = summarize(trace(id));
    assert.ok(s.ranges.upperChest.rotation * 180 / Math.PI > baseline * 4, `${id}: still close to the old static body`);
    // 'Hold' sustains meaning while the chest unwinds; it must not be a fixed pose.
    const hold = trace(id).frames.filter(f => f.phase === 'hold');
    const change = Math.max(...hold.map(f => rotationDistance(f.parts.upperChest.rotation, hold[0].parts.upperChest.rotation)));
    assert.ok(change > (id === 'wave' ? 1 : 2) * Math.PI / 180, `${id}: frozen hold phase`);
  }
  assert.ok(chestRange('explain', 'pitch')[0] < -.008, 'explanation first gathers back');
  assert.ok(chestRange('explain', 'pitch')[1] > .15, 'explanation then offers forward');
  assert.ok(chestRange('wave', 'yaw')[0] < -.1, 'wave turns its shoulder toward the raised hand');
  assert.ok(chestRange('shrug', 'pitch')[0] < -.11, 'shrug recoils with chest, not only hands');
  assert.ok(chestRange('shrug', 'pitch')[1] > .03, 'shrug releases forward after recoil');
  assert.ok(chestRange('chest', 'pitch')[1] > .18, 'hand-to-heart inclines the upper body');
});

test('quiet and energetic expressions retain different directional stories instead of uniform swaying', () => {
  assert.ok(chestRange('think', 'yaw')[0] < -.1, 'thinking turns the chest after the glance');
  assert.ok(chestRange('think', 'pitch')[0] < -.08 && chestRange('think', 'pitch')[1] > .08, 'thinking withdraws then returns to the listener');
  assert.ok(chestRange('shy', 'yaw')[1] > .15, 'shy withdrawal rotates away');
  assert.ok(chestRange('surprise', 'pitch')[0] < -.15 && chestRange('surprise', 'pitch')[1] > .09, 'surprise recoils then reconnects');
  assert.ok(chestRange('look_up', 'pitch')[0] < -.15, 'looking up opens the chest');
  assert.ok(chestRange('bow_smile', 'pitch')[1] > .30, 'bow remains the deepest forward inclination');
  // Listening stays focused toward the user rather than adopting wave/think yaw.
  assert.ok(Math.max(...chestRange('listen', 'yaw').map(Math.abs)) < .025);
  const bodyTravel = id => Math.max(...trace(id).frames.map(f => distance(f.parts.upperChest.position, trace(id).baseline.parts.upperChest.position)));
  assert.ok(bodyTravel('greet') > .3 && bodyTravel('shy') > .25, 'greet/shy change support visibly');
});

test('body timing retains published gestures and the explicitly faster wave/greet revision', () => {
  const timing = {
    explain: [2.45, .66, .5, .78, 1.7], wave: [2.25, .72, .56, 1.32, 1.55],
    shrug: [1.6, .44, .36, .56, .86], chest: [2.8, .72, .64, .86, 2.02],
    bow_smile: [3.8, 1.05, .735, 1.25, 2.65], laugh: [3.4, .98, .686, 1.18, 2.35],
    curious: [3.65, 1.12, .784, 1.32, 2.6], shy: [4.3, 1.12, .784, 1.32, 3.25],
    explain_firm: [3.65, 1.12, .784, 1.32, 2.55], surprise: [3.55, .72, .504, .92, 2.5],
    think: [4.2, 1.3, .91, 1.5, 3.1], greet: [2.65, .88, .7, 1.24, 1.65],
    listen: [4, 1.1, .77, 1.3, 2.95], comfort: [4.1, 1.35, .945, 1.55, 3.05],
    look_up: [3.95, 1.2, .84, 1.4, 2.85], agree: [3.05, .95, .665, 1.15, 2.05],
  };
  for (const [id, expected] of Object.entries(timing)) {
    const g = GESTURES[id], actual = [g.duration, g.apex, g.phases.prepare[1], g.phases.stroke[1], g.phases.hold[1]];
    assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) < 1e-12), `${id}: speech timing changed`);
  }
});
