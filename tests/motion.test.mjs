import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MotionController } from '../preview/core/motion-controller.js';
import { GESTURES, GESTURE_IDS, EXPANDED_GESTURE_IDS, MOTION_DEFAULTS, OVERLAP, POSTURES } from '../preview/core/motion-profile.js';
import { forwardKinematics, skeletonFromInspection } from '../preview/core/motion-skeleton.js';

const inspection = JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8'));
const skeleton = skeletonFromInspection(inspection);
const make = (options = {}) => { const c = new MotionController({ skeleton }); c.setOptions({ natural: false, ...options }); return c; };
/** Steps on an integer frame grid; returns the last time reached. */
const run = (c, from, to, fps = 60, each, input) => {
  const n = Math.round((to - from) * fps);
  for (let i = 1; i <= n; i++) { const t = from + i / fps; c.update(t, 1 / fps, input?.(t)); each?.(t); }
  return from + n / fps;
};
const settle = (posture = 'relaxed', options) => { const c = make(options); c.setPosture(posture, 0); run(c, 0, 1.6); return c; };
const FINGER_TIPS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const handPoints = c => {
  const fk = forwardKinematics(c.rig, c.locals);
  return ['L', 'R'].flatMap(side => {
    const n = c.rig.sides[side].names;
    return [n.wrist, ...FINGER_TIPS.map(f => n.tips[f])].map(b => fk.get(b).position.slice());
  });
};
const distances = (a, b) => a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2]));
const maxStep = (a, b) => Math.max(...distances(a, b));
/** Per-frame displacement split into wrists (points 0 and 6) and fingertips. */
const steps = (a, b) => {
  const d = distances(a, b);
  return { wrist: Math.max(d[0], d[6]), tip: Math.max(...d.filter((_, i) => i % 6)) };
};
// Speed limits per 60 fps frame (1 model unit is about 8 cm): wrists 18 u/s (~1.4 m/s),
// fingertips 30 u/s (~2.3 m/s). A pose discontinuity (e.g. a forearm flip) is far larger.
const WRIST_STEP = 18 / 60, TIP_STEP = 30 / 60;
const watcher = c => {
  const w = { prev: handPoints(c), wrist: 0, tip: 0 };
  w.step = () => {
    const p = handPoints(c), s = steps(w.prev, p);
    w.wrist = Math.max(w.wrist, s.wrist); w.tip = Math.max(w.tip, s.tip); w.prev = p;
  };
  w.ok = () => w.wrist < WRIST_STEP && w.tip < TIP_STEP;
  w.toJSON = () => ({ wrist: w.wrist * 60, tip: w.tip * 60 });
  w.toString = () => `wrist ${(w.wrist * 60).toFixed(1)} u/s, tip ${(w.tip * 60).toFixed(1)} u/s`;
  return w;
};
const withinSpeed = (a, b) => { const s = steps(a, b); return s.wrist < WRIST_STEP && s.tip < TIP_STEP; };
const onPausedPose = (c, arms) => ['L', 'R'].every(side => c.work.arm[side].every((x, i) => x === arms[side][i]));
/** Gesture contribution is exactly zero: the solved arm parameters equal the posture's. */
const onPosture = (c, posture) => ['L', 'R'].every(side => c.work.arm[side].every((x, i) => Math.abs(x - c.profile.postures[posture][side][i]) < 1e-9));
// Torso springs (head-follow) may still be settling by a hair after the arms are done.
const SETTLED = .01;
const audioCue = o => ({ id: 'cue', kind: 'gesture', gesture: 'explain', epoch: 1, clock: 'audio', at: .2, ...o });
const playTo = (c, epoch, fromAudio, toAudio, now) => {
  const n = Math.round((toAudio - fromAudio) * 60);
  for (let i = 1; i <= n; i++) { c.playback(epoch, 'playing', fromAudio + i / 60); c.update(now + i / 60, 1 / 60); }
  return now + n / 60;
};

test('every posture and gesture yields finite unit quaternions within joint and comfort limits', () => {
  for (const posture of Object.keys(POSTURES)) for (const gesture of [null, ...GESTURE_IDS]) {
    const c = settle(posture, { natural: true }), label = `${posture}/${gesture}`;
    if (gesture) assert.equal(c.trigger(gesture, `limits-${label}`, 1.6), true, label);
    run(c, 1.6, 5.2, 60, () => {
      for (const [name, q] of c.locals) {
        const l = Math.hypot(...q);
        assert.ok(Number.isFinite(l) && Math.abs(l - 1) < 1e-6, `${label} ${name}`);
      }
      for (const side of ['L', 'R']) {
        const d = c.diag[side];
        // The wrist clamp (1.05 rad) is a safety net; authored motion stays under it.
        assert.ok(d.wrist < 1, `${label} ${side} wrist ${d.wrist}`);
        assert.ok(Math.abs(d.forearmTwist) <= 1.75 + 1e-9, `${label} ${side} forearm ${d.forearmTwist}`);
        assert.ok(d.bend >= 0 && d.bend < 2.6, `${label} ${side} elbow ${d.bend}`);
      }
      const H = MOTION_DEFAULTS.head;
      assert.ok(c.head.pitch >= H.pitch[0] - .01 && c.head.pitch <= H.pitch[1] + .01, label);
      assert.ok(Math.abs(c.head.yaw) <= H.yaw[1] + .01 && Math.abs(c.head.roll) <= H.roll[1] + .01, label);
    });
  }
});

test('hands and fingertips never pass through the torso core', () => {
  // A box well inside the body (model units); real surface clearance is checked offline
  // against the skinned mesh by scripts/check-motion-clearance.mjs.
  const inside = p => Math.abs(p[0]) < .7 && p[2] > -.8 && p[2] < .5 && p[1] > 10.5 && p[1] < 16.5;
  for (const posture of Object.keys(POSTURES)) for (const gesture of GESTURE_IDS) {
    const c = settle(posture);
    c.trigger(gesture, `core-${posture}-${gesture}`, 1.6);
    run(c, 1.6, 1.6 + GESTURES[gesture].duration + .2, 60, () => {
      for (const p of handPoints(c)) assert.ok(!inside(p), `${posture}/${gesture} ${p.map(x => x.toFixed(2))}`);
    });
  }
});

test('posture changes, including a reversal mid-transition, move the hands continuously and settle exactly', () => {
  const c = settle('relaxed'), w = watcher(c);
  c.setPosture('speaking', 1.6); let t = run(c, 1.6, 2.0, 60, w.step);
  c.setPosture('listening', t); t = run(c, t, 2.3, 60, w.step);
  c.setPosture('relaxed', t); t = run(c, t, 4, 60, w.step);
  assert.ok(w.ok(), String(w));
  const ref = settle('relaxed'); run(ref, 1.6, 4);
  assert.ok(maxStep(handPoints(c), handPoints(ref)) < 1e-6);
  assert.equal(c.setPosture('constructor'), false); assert.equal(c.setPosture('__proto__'), false);
});

test('every gesture from every posture, played out or interrupted in any phase, moves continuously and returns to the posture', () => {
  for (const posture of Object.keys(POSTURES)) for (const gesture of GESTURE_IDS) for (const phase of [null, 'prepare', 'stroke', 'hold', 'recover']) {
    const def = GESTURES[gesture], c = settle(posture), w = watcher(c), label = `${posture}/${gesture}/${phase ?? 'full'}`;
    assert.equal(c.trigger(gesture, label, 1.6), true, label);
    let t = 1.6;
    if (phase) {
      // Step on the gesture's own (authored) clock to the middle of the phase.
      const mid = (def.phases[phase][0] + def.phases[phase][1]) / 2;
      const phaseDeadline = EXPANDED_GESTURE_IDS.includes(gesture) ? 1.6 + def.duration * MOTION_DEFAULTS.maxStretch + 2 : 8;
      while (!(c.snapshot().gestures[0]?.age >= mid)) { t = run(c, t, t + 1 / 60, 60, w.step); assert.ok(t < phaseDeadline, label); }
      assert.equal(c.snapshot().gestures[0].phase, phase, label);
      assert.equal(c.retract(t), 1, label);
      assert.equal(c.retract(t + .01), 0, `${label} repeated retract`);
      const seconds = c.snapshot().gestures[0].retractSeconds;
      assert.ok(seconds >= def.recover - 1e-9 && seconds <= def.recover * MOTION_DEFAULTS.maxStretch + 1e-9, `${label} ${seconds}`);
      t = run(c, t, t + 1 / 60, 60, w.step);
      assert.equal(c.snapshot().gestures[0].phase, 'retract');
      // Fully back on the posture once the slowest group (shoulder) has faded.
      t = run(c, t, t + seconds + OVERLAP.recover.shoulder + 1 / 60, 60, w.step);
    } else {
      t = run(c, t, t + 1 / 60, 60, w.step);
      assert.equal(c.snapshot().gestures.length, 1, label);
      const completionDeadline = EXPANDED_GESTURE_IDS.includes(gesture) ? 1.6 + def.duration * MOTION_DEFAULTS.maxStretch + 2 : 10;
      while (c.snapshot().gestures.length) { t = run(c, t, t + 1 / 60, 60, w.step); assert.ok(t < completionDeadline, label); }
    }
    assert.ok(onPosture(c, posture), label);
    assert.ok(w.ok(), `${label} ${w}`);
    const ref = settle(posture); run(ref, 1.6, t);
    assert.ok(maxStep(handPoints(c), handPoints(ref)) < SETTLED, `${label} ${maxStep(handPoints(c), handPoints(ref))}`);
    run(c, t, t + .25);
    assert.equal(c.snapshot().gestures.length, 0, label);
  }
});

test('pause freezes an audio-scoped gesture, breathing continues, resume continues without replay', () => {
  for (const natural of [false, true]) {
    const c = settle('relaxed', { natural }); c.begin(1);
    assert.equal(c.enqueue(audioCue({ id: 'pause-cue' })), true);
    let now = playTo(c, 1, 0, 1, 1.6);
    c.playback(1, 'paused', 1);
    const age = c.snapshot().gestures[0].age, hands = handPoints(c), arms = { L: c.work.arm.L.slice(), R: c.work.arm.R.slice() };
    const chest = c.locals.get(c.rig.torso.upperChest.name).slice();
    for (let i = 1; i <= 180; i++) { c.playback(1, 'paused', 1); c.update(now + i / 60, 1 / 60); }
    now += 3;
    assert.equal(c.snapshot().gestures[0].age, age);
    if (natural) {
      assert.ok(Math.hypot(...chest.map((x, i) => x - c.locals.get(c.rig.torso.upperChest.name)[i])) > 1e-4, 'breathing continues');
      assert.ok(maxStep(hands, handPoints(c)) < .06, 'only breathing moves the paused arms');
    } else {
      assert.ok(maxStep(hands, handPoints(c)) < SETTLED, 'paused arms only settle their torso springs');
      assert.ok(onPausedPose(c, arms), 'gesture parameters are frozen');
    }
    // Resume: the same gesture continues from where it stopped; its cue cannot replay.
    c.playback(1, 'playing', 1 + 1 / 60); c.update(now + 1 / 60, 1 / 60);
    const resumed = c.snapshot().gestures[0];
    assert.equal(resumed.id, 'pause-cue'); assert.ok(resumed.age > age && resumed.age < age + .03);
    assert.equal(c.enqueue(audioCue({ id: 'pause-cue', at: 1 })), false);
    let last = resumed.age;
    for (let i = 1; i <= 180; i++) {
      c.playback(1, 'playing', 1 + (i + 1) / 60); c.update(now + (i + 1) / 60, 1 / 60);
      const live = c.snapshot().gestures.filter(g => g.id === 'pause-cue');
      assert.ok(live.length <= 1);
      if (live.length) { assert.ok(live[0].age >= last, 'never restarts'); last = live[0].age; }
    }
    assert.equal(c.snapshot().gestures.length, 0);
  }
});

test('a new epoch (seek) retracts audio gestures, clears their queue and rejects stale input', () => {
  const c = settle('speaking'); c.begin(1);
  c.enqueue(audioCue({ id: 'now' })); c.enqueue(audioCue({ id: 'later', gesture: 'shrug', at: 3 }));
  const now = playTo(c, 1, 0, 1, 1.6);
  assert.equal(c.snapshot().queued, 1);
  const before = handPoints(c);
  assert.equal(c.begin(2), true);
  c.playback(2, 'playing', 6); c.update(now + 1 / 60, 1 / 60);
  assert.ok(withinSpeed(before, handPoints(c)));
  const s = c.snapshot();
  assert.equal(s.queued, 0); assert.ok(s.gestures.every(g => g.recovering));
  assert.equal(c.playback(1, 'playing', 1.1), false); assert.equal(c.playback(1, 'ended', 9), false);
  assert.equal(c.cancel(1), false); assert.equal(c.begin(1), false); assert.equal(c.begin(2), false);
  assert.equal(c.enqueue(audioCue({ id: 'stale', epoch: 1, at: 6 })), false);
  assert.equal(c.enqueue(audioCue({ id: 'fresh', epoch: 2, at: 6 })), true);
  // Seek jumped the audio clock forward, but the retraction runs on the local clock.
  for (let i = 2; i <= 20; i++) { c.playback(2, 'playing', 6); c.update(now + i / 60, 1 / 60); }
  assert.ok(c.snapshot().gestures.some(g => g.recovering && g.retractProgress > .3 && g.retractProgress < 1));
});

test('cancel retracts on the local clock even while paused, switches to listening, and repeats are ignored', () => {
  const c = settle('relaxed'); c.setPosture('auto', 1.6); c.begin(1);
  c.enqueue(audioCue({ id: 'cancel-cue' }));
  let now = playTo(c, 1, 0, 1.2, 1.6);
  c.playback(1, 'paused', 1.2); c.update(now + 1 / 60, 1 / 60); now += 1 / 60;
  assert.equal(c.snapshot().posture, 'speaking');
  const g = c.gestures[0], before = handPoints(c);
  assert.equal(c.cancel(1, now), true);
  const started = g.recoverStart;
  assert.equal(c.cancel(1, now + .05), false); assert.equal(c.retract(now + .05), 0);
  assert.equal(g.recoverStart, started);
  assert.equal(c.enqueue(audioCue({ id: 'late', at: 1.3 })), false);
  assert.equal(c.playback(1, 'playing', 1.3), false);
  c.update(now + 1 / 60, 1 / 60);
  assert.ok(withinSpeed(before, handPoints(c)));
  const s = c.snapshot();
  assert.equal(s.status, 'cancelled'); assert.equal(s.posture, 'listening');
  now = run(c, now + 1 / 60, now + s.gestures[0].retractSeconds + .25);
  assert.equal(c.snapshot().gestures.length, 0);
  now = run(c, now, now + 1.2);
  const ref = settle('listening'); run(ref, 1.6, 3);
  assert.ok(onPosture(c, 'listening'));
  assert.ok(maxStep(handPoints(c), handPoints(ref)) < SETTLED, 'settled on listening');
  run(c, now, now + 8);
  assert.equal(c.snapshot().posture, 'relaxed');
});

test('cue IDs deduplicate; invalid, expired, stale and late gesture cues are rejected', () => {
  const c = settle('speaking'); c.begin(1); c.playback(1, 'playing', 1); c.update(1.62, 1 / 60);
  const cue = o => audioCue({ at: 1, ...o });
  assert.equal(c.enqueue(cue({ id: 'x' })), true); assert.equal(c.enqueue(cue({ id: 'x' })), false);
  for (const bad of [{ gesture: '__proto__' }, { gesture: 'constructor' }, { kind: 'expression' }, { at: NaN }, { at: -1 },
    { at: 99 }, { strength: Infinity }, { clock: 'unknown' }, { epoch: 2 }, { at: .5 }, { apexAt: -1 }, { id: '' }, { id: 7 }]) {
    assert.equal(c.enqueue(cue({ id: JSON.stringify(bad), ...bad })), false, JSON.stringify(bad));
  }
  // Late-start rule: explain may start at most min(0.25 s, half its prepare) late.
  assert.equal(c.enqueue(cue({ id: 'late-ok', at: .8 })), true);
  assert.equal(c.enqueue(cue({ id: 'late-bad', at: .7 })), false);
  assert.equal(c.enqueue(cue({ id: 'apex', gesture: 'shrug', at: undefined, apexAt: 3 })), true);
  const shrug = c.profile.gestures.shrug;
  assert.ok(Math.abs(c.pending.find(p => p.id === 'apex').at - (3 - shrug.apex - shrug.prepareEnd * (shrug.speakingStretch - 1))) < 1e-9);
  assert.equal(c.trigger('beat', 'internal', 2), false);
  assert.equal(c.trigger('toString', 'proto', 2), false);
});

test('same-track gestures replace each other; additive beats never interrupt; active and cooldown repeats are rejected', () => {
  const c = settle('speaking');
  assert.equal(c.trigger('explain', 'e1', 1.6), true);
  let t = run(c, 1.6, 3);
  assert.equal(c.trigger('explain', 'e2', t), false, 'already active');
  assert.equal(c.trigger('chest', 'c1', t), true);
  t = run(c, t, t + 1 / 60);
  let s = c.snapshot();
  assert.deepEqual(s.gestures.map(g => [g.gesture, g.recovering]), [['explain', true], ['chest', false]]);
  const rejected = s.rejected;
  assert.equal(c.enqueue({ id: 'beat', kind: 'gesture', gesture: 'beat', clock: 'wall', at: t }), true);
  t = run(c, t, t + 1 / 60);
  assert.equal(c.snapshot().rejected, rejected + 1);
  assert.ok(!c.gestures.some(g => g.gesture === 'beat'));
  assert.equal(c.trigger('wave', 'w1', t), true);
  t = run(c, t, t + 1 / 60);
  s = c.snapshot();
  assert.ok(s.gestures.find(g => g.gesture === 'chest').recovering);
  assert.ok(!s.gestures.find(g => g.gesture === 'wave').recovering);
  assert.equal(c.trigger('chest', 'c2', t), false, 'cooldown');
  // A queued speech cue blocks a manual repeat only when it is about to start.
  const q = settle('speaking'); q.begin(1); q.playback(1, 'playing', 1); q.update(1.62, 1 / 60);
  assert.equal(q.enqueue(audioCue({ id: 'soon', gesture: 'shrug', at: 1.5 })), true);
  assert.equal(q.enqueue(audioCue({ id: 'later', gesture: 'wave', at: 6 })), true);
  assert.equal(q.trigger('shrug', 'manual-shrug', 1.62), false, 'queued shrug starts within its cooldown');
  assert.equal(q.trigger('wave', 'manual-wave', 1.62), true, 'queued wave is seconds away');
});

test('chained gestures hand over continuously and settle back on the posture', () => {
  const c = settle('speaking'), w = watcher(c);
  let t = 1.6;
  for (const [gesture, until] of [['explain', 3], ['chest', 4.5], ['shrug', 5.6], ['wave', 10]]) {
    assert.equal(c.trigger(gesture, `chain-${gesture}`, t), true, gesture);
    t = run(c, t, until, 60, w.step);
  }
  assert.ok(w.ok(), String(w));
  assert.equal(c.snapshot().gestures.length, 0);
  assert.ok(onPosture(c, 'speaking'));
  const ref = settle('speaking'); run(ref, 1.6, 10);
  assert.ok(maxStep(handPoints(c), handPoints(ref)) < 1e-4);
});

test('motion is frame-rate independent at 30, 60 and 144 fps', () => {
  const sample = fps => {
    const c = make({ natural: true }); c.setPosture('relaxed', 0);
    const out = [];
    for (let i = 1; i <= 8 * fps; i++) {
      const t = i / fps;
      c.update(t, 1 / fps, { face: { pitch: .08 * Math.sin(t * 1.3), yaw: .25 * Math.sin(t * .7), roll: .05 * Math.sin(t) }, actions: [] });
      if (i === fps) c.setPosture('speaking', t);
      if (i === 2 * fps) c.trigger('explain', 'fps-explain', t);
      if (i === 3.5 * fps) c.retract(t);
      if (i === 4 * fps) c.trigger('wave', 'fps-wave', t);
      if (i % (fps / 6) === 0) out.push({ hands: handPoints(c), head: [c.head.pitch, c.head.yaw, c.head.roll] });
    }
    return out;
  };
  const ref = sample(144);
  for (const fps of [30, 60]) {
    const other = sample(fps);
    assert.equal(other.length, ref.length);
    const hands = Math.max(...other.map((s, i) => maxStep(s.hands, ref[i].hands)));
    const head = Math.max(...other.map((s, i) => Math.max(...s.head.map((x, k) => Math.abs(x - ref[i].head[k])))));
    assert.ok(hands < .03, `${fps} fps hands differ by ${hands}`);
    assert.ok(head < .01, `${fps} fps head differs by ${head}`);
  }
});

test('with natural motion off an idle posture is perfectly still; on, it breathes', () => {
  const still = settle('listening'); run(still, 1.6, 5);
  const snap = new Map([...still.locals].map(([k, q]) => [k, q.slice()]));
  run(still, 5, 10);
  for (const [k, q] of still.locals) assert.ok(Math.hypot(...q.map((x, i) => x - snap.get(k)[i])) < 1e-6, k);
  const alive = settle('listening', { natural: true }), before = alive.locals.get(alive.rig.torso.chest.name).slice();
  run(alive, 1.6, 3.6);
  assert.ok(Math.hypot(...before.map((x, i) => x - alive.locals.get(alive.rig.torso.chest.name)[i])) > 1e-4);
});

test('a gesture under way when speech ends finishes on the local clock; later audio cues are refused', () => {
  const c = settle('speaking'); c.begin(1); c.enqueue(audioCue({ id: 'end-cue' }));
  let now = playTo(c, 1, 0, 1, 1.6);
  const age = c.snapshot().gestures[0].age;
  assert.equal(c.playback(1, 'ended', 1), true);
  now = run(c, now, now + .5);
  const g = c.snapshot().gestures[0];
  assert.equal(g.recovering, false); assert.equal(g.clock, 'wall');
  assert.ok(Math.abs(g.age - age - .5 * c.gestures[0].rate) < .02, `age ${g.age}`);
  assert.equal(c.enqueue(audioCue({ id: 'after-end', at: 1 })), false);
  run(c, now, now + 2);
  assert.equal(c.snapshot().gestures.length, 0);
});

test('auto posture: relaxed idle, speaking while playing, kept while paused, listening after interruption, relaxed later', () => {
  const c = make(); c.update(0, 0);
  assert.equal(c.snapshot().posture, 'relaxed');
  c.begin(1); c.playback(1, 'playing', 0); c.update(.1, .1);
  assert.equal(c.snapshot().posture, 'speaking');
  c.playback(1, 'paused', .1); c.update(.2, .1);
  assert.equal(c.snapshot().posture, 'speaking');
  c.cancel(1, .3); c.update(5, .1);
  assert.equal(c.snapshot().posture, 'listening');
  c.update(8.4, .1);
  assert.equal(c.snapshot().posture, 'relaxed');
  c.setPosture('listening', 9); c.begin(2); c.playback(2, 'playing', 0); c.update(9.1, .1);
  assert.equal(c.snapshot().posture, 'listening', 'a fixed posture ignores playback');
});

test('speech beats fire on phrase onsets only, with a cooldown, and never while paused', () => {
  const c = settle('speaking', { natural: true }); c.setPosture('auto', 1.6); c.begin(1);
  let audio = 0, now = 1.6;
  const step = (level, seconds, status = 'playing') => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      now += 1 / 60; if (status === 'playing') audio += 1 / 60;
      c.playback(1, status, audio); c.update(now, 1 / 60, { speech: level });
    }
  };
  step(0, .5); step(.4, .3);
  assert.equal(c.snapshot().beats, 1);
  step(0, .4); step(.4, .3);
  assert.equal(c.snapshot().beats, 1, 'cooldown');
  step(0, 1.5); step(.4, .3);
  assert.equal(c.snapshot().beats, 2);
  step(0, .5, 'paused'); step(.4, .3, 'paused');
  step(.4, 3);
  assert.equal(c.snapshot().beats, 2, 'no beat while paused or without a pause before the phrase');
});

test('head angles are limited in one place, the neck shares the turn, and gaze leads during a glance', () => {
  const H = MOTION_DEFAULTS.head, E = MOTION_DEFAULTS.eyes;
  const c = settle('relaxed');
  run(c, 1.6, 3.6, 60, null, () => ({ face: { pitch: -1, yaw: 2, roll: 1 }, actions: [] }));
  assert.ok(Math.abs(c.head.yaw - H.yaw[1]) < 1e-3 && Math.abs(c.head.pitch - H.pitch[0]) < 1e-3 && Math.abs(c.head.roll - H.roll[1]) < 1e-3);
  assert.ok(Math.abs(c.springs.neckYaw.x / c.head.yaw - H.neckShare) < 1e-3);
  // VOR: without a glance the eyes counter-rotate to stay on the viewer.
  assert.ok(c.head.eyesYaw < 0 && c.head.eyesYaw >= -E.yaw - 1e-9);

  const g = settle('relaxed'), glance = () => ({ face: { pitch: 0, yaw: .3, roll: 0 }, actions: ['glance'] });
  run(g, 1.6, 1.7, 60, null, glance);
  assert.ok(g.head.eyesYaw > .05, `eyes lead ${g.head.eyesYaw}`);
  assert.ok(g.head.yaw < .3 * .6, `head follows ${g.head.yaw}`);
  run(g, 1.7, 3.5, 60, null, glance);
  assert.ok(Math.abs(g.head.yaw - .3) < 1e-3 && g.head.eyesYaw > 0 && g.head.eyesYaw <= E.yaw + 1e-9);
});

test('intensity scales a gesture without residual offset and speed shortens it', () => {
  const measure = options => {
    const c = settle('speaking', options), base = handPoints(c);
    c.trigger('explain', 'amp', 1.6);
    let max = 0, end = null;
    run(c, 1.6, 5, 60, t => { max = Math.max(max, maxStep(base, handPoints(c))); if (end === null && !c.gestures.length) end = t; });
    return { max, end };
  };
  const full = measure({}), soft = measure({ intensity: .3 }), fast = measure({ speed: 1.4 });
  assert.ok(soft.max < full.max * .4, `soft ${soft.max} vs ${full.max}`);
  assert.ok(soft.max > full.max * .2);
  assert.ok(fast.end < full.end - .5, `fast end ${fast.end} vs ${full.end}`);
});

test('diagnostic inspection freezes a key pose and clears without residue', () => {
  const c = settle('speaking'), base = handPoints(c);
  assert.equal(c.inspect('wave', GESTURES.wave.apex), true);
  run(c, 1.6, 1.8);
  assert.ok(maxStep(base, handPoints(c)) > 1);
  assert.equal(c.inspect('nope', 0), false); assert.equal(c.inspect('wave', NaN), false);
  c.inspect(null); run(c, 1.8, 1.9);
  assert.ok(onPosture(c, 'speaking'));
  run(c, 1.9, 4.5);
  assert.ok(maxStep(base, handPoints(c)) < 1e-4);
});
