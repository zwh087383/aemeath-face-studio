import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GESTURES, GESTURE_IDS, GESTURE_METADATA, EXPANDED_GESTURE_IDS } from '../preview/core/motion-profile.js';
import { sampleGestureExpression, ExpressionChoreographer } from '../preview/core/expression-choreography.js';
import { CHANNELS } from '../preview/core/profile.js';
import { forwardKinematics } from '../preview/core/motion-skeleton.js';
import { makeMotion, poseSample, distance, rotationDistance } from '../scripts/check-coordinated-motion.mjs';

const originals = ['explain', 'wave', 'shrug', 'chest', 'bow_smile', 'laugh', 'curious', 'shy', 'explain_firm', 'surprise', 'think', 'greet', 'listen', 'comfort', 'look_up', 'agree'];
const handDelta = (a, b) => Math.max(...['R', 'L'].flatMap(side => a.hands[side].map((p, i) => distance(p, b.hands[side][i]))));

test('all original authored parameters and their order remain byte-identical', () => {
  assert.deepEqual(GESTURE_IDS.slice(0, 16), originals);
  const hash = createHash('sha256').update(JSON.stringify(Object.fromEntries(originals.map(id => [id, GESTURES[id]])))).digest('hex');
  assert.equal(hash, 'bfe6eae6f4de78ecac159926593059dc08277fa9d0ce1adf1ce14f440921f615');
});

test('forty additional gestures have immutable metadata, distinct trajectories and valid phase clocks', () => {
  assert.equal(EXPANDED_GESTURE_IDS.length, 40);
  assert.equal(new Set(GESTURE_IDS).size, 56);
  assert.deepEqual(Object.fromEntries(['micro', 'conversation', 'emotion', 'large'].map(category => [category,
    EXPANDED_GESTURE_IDS.filter(id => GESTURES[id].category === category).length])), { micro: 12, conversation: 12, emotion: 10, large: 6 });
  const signatures = new Set();
  const finiteTree = value => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
    if (value && typeof value === 'object') for (const child of Object.values(value)) finiteTree(child);
  };
  for (const id of EXPANDED_GESTURE_IDS) {
    const g = GESTURES[id]; finiteTree(g);
    assert.ok(Object.isFrozen(g) && Object.isFrozen(g.keys.body) && Object.isFrozen(g.keys.R[1][1].hand));
    assert.ok(Object.isFrozen(GESTURE_METADATA[id]));
    assert.ok(g.name && g.description.length >= 10);
    let last = 0;
    for (const phase of ['prepare', 'stroke', 'hold', 'recover']) {
      assert.equal(g.phases[phase][0], last);
      assert.ok(g.phases[phase][1] > last); last = g.phases[phase][1];
    }
    assert.equal(last, g.duration);
    for (const [side, keys] of Object.entries(g.keys)) {
      assert.equal(keys[0][0], 0);
      for (let i = 1; i < keys.length; i++) {
        assert.ok(keys[i][0] > keys[i - 1][0] && keys[i][0] < g.duration, `${id}/${side}`);
        if (side === 'body') continue;
        const [out, height, front] = keys[i][1].hand;
        if (g.additive) assert.ok(Math.abs(out) <= .3 && Math.abs(height) <= .6 && Math.abs(front) <= .9, `${id}: excessive micro offset`);
        else assert.ok(out >= 1.2 && out <= 3.5 && height >= 11.2 && height <= 16.2 && front >= -.2 && front <= 2.81, `${id}: authored corridor`);
      }
    }
    // Differences must exist in time-varying body and hand data, not only labels.
    signatures.add(JSON.stringify(g.keys));
    const early = g.keys.body.find(([t, p]) => t > 0 && (p.gazeYaw || p.gazePitch));
    assert.ok(early && early[0] < g.apex, `${id}: intention must precede its apex`);
    for (const [, weights] of g.expression.keys) for (const channel of Object.keys(weights)) assert.ok(CHANNELS.includes(channel), `${id}: unknown ${channel}`);
  }
  assert.equal(signatures.size, 40);
});

test('every new clip moves its actual PMX torso and hands, keeps feet planted and settles continuously', () => {
  for (const id of EXPANDED_GESTURE_IDS) {
    const c = makeMotion(), initial = poseSample(c), g = GESTURES[id];
    const fk = forwardKinematics(c.rig, c.locals);
    const feet = Object.values(c.rig.legs).map(leg => [leg.names.ankle, [...fk.get(leg.names.ankle).position]]);
    c.trigger(id, `expanded-${id}`, 2);
    let previous = initial, chest = 0, travel = 0, wristSpeed = 0, tipSpeed = 0, chestSpeed = 0;
    const frames = Math.ceil((g.duration * 2 + 3) * 60);
    for (let i = 1; i <= frames; i++) {
      c.update(2 + i / 60, 1 / 60);
      const p = poseSample(c);
      chest = Math.max(chest, rotationDistance(p.parts.upperChest.rotation, initial.parts.upperChest.rotation));
      travel = Math.max(travel, distance(p.parts.head.position, initial.parts.head.position));
      chestSpeed = Math.max(chestSpeed, rotationDistance(p.parts.upperChest.rotation, previous.parts.upperChest.rotation) * 60);
      for (const side of ['R', 'L']) p.hands[side].forEach((v, j) => {
        const speed = distance(v, previous.hands[side][j]) * 60;
        if (j === 0) wristSpeed = Math.max(wristSpeed, speed); else tipSpeed = Math.max(tipSpeed, speed);
      });
      for (const q of c.locals.values()) assert.ok(q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) < 1e-6, id);
      for (const side of ['R', 'L']) {
        assert.ok(c.diag[side].wrist < 1, `${id}/${side}: authored wrist reached safety clamp`);
        assert.ok(c.diag[side].bend < 2.6, `${id}/${side}: elbow folded beyond comfort bound`);
      }
      if (i % 10 === 0) {
        const support = forwardKinematics(c.rig, c.locals);
        for (const [name, rest] of feet) assert.ok(distance(support.get(name).position, rest) < .04, `${id}: foot slide`);
      }
      previous = p;
    }
    assert.ok(chest > (g.category === 'micro' ? .022 : .08), `${id}: torso ${chest}`);
    assert.ok(travel > (g.category === 'micro' ? .1 : .3), `${id}: head spatial travel ${travel}`);
    assert.ok(wristSpeed < 18 && tipSpeed < 30 && chestSpeed < 1.8, `${id}: excessive speed ${wristSpeed}/${tipSpeed}/${chestSpeed}`);
    assert.equal(c.snapshot().gestures.length, 0, id);
    assert.ok(handDelta(previous, initial) < .02 && rotationDistance(previous.parts.upperChest.rotation, initial.parts.upperChest.rotation) < .001, `${id}: residual pose`);
  }
});

test('each added gesture can retract during every phase without a jump or a stuck expression', () => {
  for (const id of EXPANDED_GESTURE_IDS) for (const phase of ['prepare', 'stroke', 'hold', 'recover'])
    for (const posture of GESTURES[id].category === 'micro' || id === 'reset_and_resolve' ? ['relaxed', 'listening', 'speaking'] : ['relaxed']) {
    const g = GESTURES[id], c = makeMotion(posture), e = new ExpressionChoreographer();
    c.trigger(id, `cancel-${id}-${phase}`, 2);
    let now = 2, previous = poseSample(c), maxStep = 0, faceStep = 0;
    const untilAge = (g.phases[phase][0] + g.phases[phase][1]) / 2;
    while (!(c.snapshot().gestures[0]?.age >= untilAge)) {
      now += 1 / 60; c.update(now, 1 / 60); e.update(now, c.snapshot().gestures);
      assert.ok(now < 2 + g.duration * 2 + 2, `${id}: phase never reached`);
    }
    previous = poseSample(c); let face = [...e.weights];
    assert.equal(c.retract(now), 1); assert.equal(c.retract(now), 0);
    c.update(now, 0);
    assert.ok(handDelta(poseSample(c), previous) < 1e-7, `${id}/${phase}: cancellation teleported`);
    for (let i = 1; i <= 240; i++) {
      c.update(now + i / 60, 1 / 60);
      for (const side of ['R', 'L']) assert.ok(c.diag[side].wrist < 1, `${id}/${posture}/${phase}: retraction wrist clamp`);
      const next = poseSample(c), weights = [...e.update(now + i / 60, c.snapshot().gestures)];
      maxStep = Math.max(maxStep, handDelta(next, previous));
      faceStep = Math.max(faceStep, ...weights.map((v, j) => Math.abs(v - face[j])));
      previous = next; face = weights;
    }
    assert.ok(maxStep < .5, `${id}/${phase}: discontinuity ${maxStep}`);
    assert.ok(faceStep < .08, `${id}/${phase}: expression snap ${faceStep}`);
    assert.ok(Math.max(...face) < .001, `${id}/${phase}: expression stuck`);
    assert.equal(c.snapshot().gestures.length, 0, `${id}/${phase}`);
  }
});

test('micro performances remain subtle while compound clips have multiple independently authored beats', () => {
  for (const id of EXPANDED_GESTURE_IDS) {
    const g = GESTURES[id];
    if (g.category === 'micro') {
      assert.ok(Math.max(...g.keys.body.map(([, b]) => Math.abs(b.lean ?? 0))) <= .08, id);
      assert.equal(g.additive, true, `${id}: quiet reactions must retain the current hand rest`);
      assert.ok(g.keys.R.every(([, p]) => Math.abs(p.hand[1]) < .6), `${id}: micro hand raised above relative rest corridor`);
    }
    if (g.category === 'large') {
      assert.ok(g.duration >= 5.4 && g.keys.body.length >= 7, id);
      assert.ok(g.keys.body.filter(([, , stop]) => stop === 'stop').length >= 2, `${id}: no second meaningful beat`);
      assert.ok(g.keys.R.length >= 6 && g.keys.L.length >= 5, `${id}: collapsed compound action`);
    }
    assert.ok(sampleGestureExpression(id, 0).every(v => v === 0));
    assert.ok(sampleGestureExpression(id, g.duration).every(v => v === 0));
  }
});

test('micro cues stay small in all three rests instead of pulling raised hands down', () => {
  for (const posture of ['relaxed', 'listening', 'speaking']) for (const id of EXPANDED_GESTURE_IDS.filter(id => GESTURES[id].category === 'micro')) {
    const c = makeMotion(posture), reference = { R: [...c.work.arm.R], L: [...c.work.arm.L] };
    c.trigger(id, `${id}-${posture}`, 2);
    for (let i = 1; i <= Math.ceil((GESTURES[id].duration + 1) * 60); i++) {
      c.update(2 + i / 60, 1 / 60);
      for (const side of ['R', 'L']) {
        assert.ok(Math.abs(c.work.arm[side][1] - reference[side][1]) < .6, `${id}/${posture}: dropped or raised wrist`);
        assert.ok(Math.hypot(...[0, 1, 2].map(j => c.work.arm[side][j] - reference[side][j])) < 1.05, `${id}/${posture}: large hand excursion`);
        assert.ok(c.diag[side].wrist < 1, `${id}/${posture}: wrist clamp`);
      }
    }
  }
});
