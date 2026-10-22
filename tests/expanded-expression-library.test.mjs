import test from 'node:test';
import assert from 'node:assert/strict';
import { FaceController } from '../preview/core/controller.js';
import { blendExpressionOverlay } from '../preview/core/expression-choreography.js';
import { ACTIONS, C, CHANNELS, DEMO, EXPANDED_PRESETS, EXPANDED_MICRO_ACTIONS,
  EXPANDED_PRESET_IDS, EXPANDED_MICRO_ACTION_IDS, EXPRESSION_CATEGORIES,
  MICRO_ACTION_CATEGORIES, LEGACY_PRESETS, PRESETS, VOWELS } from '../preview/core/profile.js';

const mouth = [...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat];
const asWeights = morphs => {
  const weights = new Float32Array(CHANNELS.length);
  for (const [name, value] of Object.entries(morphs)) weights[C[name]] = value;
  return weights;
};
const finitePose = face => {
  assert.ok([...face.weights].every(x => Number.isFinite(x) && x >= 0 && x <= 1));
  assert.ok(VOWELS.reduce((sum, i) => sum + face.weights[i], 0) <= .720001);
  assert.ok(Object.values(face.head).every(x => Number.isFinite(x) && Math.abs(x) <= .200001));
  assert.ok(face.weights[C.eyeWide] + Math.max(face.weights[C.blink], face.weights[C.smileEyes], face.weights[C.wink]) <= 1.000001);
};

test('original expressions, action settings and audio fixture timing remain unchanged', () => {
  assert.deepEqual(LEGACY_PRESETS, [
    { id: 'neutral', name: '自然', note: '放松眉眼，留一点呼吸。', morphs: {}, tilt: 0 },
    { id: 'smile', name: '浅笑', note: '嘴角轻轻扬起，眼尾柔和。', morphs: { browSmile: .24, eyeSmile: .28, smile: .48 }, tilt: -.018 },
    { id: 'happy', name: '开心', note: '弯起眼睛，笑意慢慢展开。', morphs: { browSmile: .65, smileEyes: 1, a: .42, smile: .55 }, tilt: -.035 },
    { id: 'curious', name: '疑惑', note: '眉毛微拢，侧头听你解释。', morphs: { browSad: .7, browAsym: .25, eyeWide: .22, o: .20, mouthFlat: .3 }, tilt: .11 },
    { id: 'focus', name: '认真', note: '目光集中，神情克制。', morphs: { browFocus: .6, browAnger: .22, eyeSharp: .4, frown: .45, mouthFlat: .5 }, tilt: .012 },
    { id: 'surprise', name: '惊讶', note: '先抬眉，再轻轻睁大眼睛。', morphs: { browUp: .7, eyeWide: .7, pupilSmall: .15, o: .6 }, tilt: 0 },
    { id: 'shy', name: '害羞', note: '微垂眼神，让脸红缓缓浮现。', morphs: { browSad: .35, eyeDroop: .3, eyeHalf: .17, smile: .38, blush: .85 }, tilt: -.06 },
    { id: 'playful', name: '俏皮', note: '单侧眨眼，带一点轻快笑意。', morphs: { browSmile: .5, wink: 1, smile: .65, a: .16 }, tilt: -.07 },
  ]);
  const legacyActions = {
    nod: { name: '点头', duration: .86, axis: 'pitch', keys: [[0, 0], [.23, .095], [.48, -.035], [.7, .025], [.86, 0]] },
    shake: { name: '摇头', duration: 1.15, axis: 'yaw', keys: [[0, 0], [.23, .09], [.53, -.09], [.82, .055], [1.15, 0]] },
    tilt: { name: '侧头', duration: 1.65, axis: 'roll', keys: [[0, 0], [.4, .09], [1.05, .09], [1.65, 0]] },
    glance: { name: '回眸', duration: 1.4, axis: 'yaw', keys: [[0, 0], [.4, -.11], [.8, -.11], [1.4, 0]] },
    blink: { name: '眨眼', duration: .24 },
  };
  assert.deepEqual(PRESETS.slice(0, 8), LEGACY_PRESETS);
  assert.deepEqual(Object.keys(ACTIONS).slice(0, 5), Object.keys(legacyActions));
  for (const [id, expected] of Object.entries(legacyActions)) assert.deepEqual(ACTIONS[id], expected);
  assert.deepEqual(DEMO, LEGACY_PRESETS.map((preset, i) => ({
    id: `scene-${i}`, preset: preset.id, at: i * 1.8, duration: 1.8,
    action: ['blink', 'nod', 'nod', 'tilt', 'glance', 'shake', 'tilt', 'blink'][i],
  })));
  assert.equal(DEMO.length, 8);
  assert.ok(Math.abs(DEMO.at(-1).at + DEMO.at(-1).duration - 14.4) < 1e-10);
});

test('catalog labels reference supported channels and distinct visible target poses', () => {
  assert.equal(EXPANDED_PRESETS.length, 32);
  assert.equal(EXPANDED_MICRO_ACTION_IDS.length, 12);
  assert.equal(PRESETS.length, 40);
  assert.equal(new Set(PRESETS.map(p => p.id)).size, PRESETS.length);
  assert.deepEqual(EXPANDED_PRESET_IDS, EXPANDED_PRESETS.map(p => p.id));
  const categoryIds = new Set(EXPRESSION_CATEGORIES.map(c => c.id));
  const rendered = [];
  for (const preset of EXPANDED_PRESETS) {
    assert.ok(preset.name && preset.note && categoryIds.has(preset.category), preset.id);
    assert.ok(Object.hasOwn(ACTIONS, preset.microAction), preset.id);
    assert.ok(Object.keys(preset.morphs).every(k => CHANNELS.includes(k)), preset.id);
    assert.ok(Object.values(preset.morphs).every(x => Number.isFinite(x) && x >= 0 && x <= .65), preset.id);
    assert.ok(Math.abs(preset.tilt) < .06);
    const face = new FaceController(); face.setPreset(preset.id, .85);
    for (let n = 0; n < 60; n++) face.update(n / 60, 1 / 60, null, false, { mouthMode: 'expression' });
    finitePose(face);
    assert.ok(face.weights.some(value => value > .05), `${preset.id} must visibly affect a real semantic channel`);
    const fingerprint = [...face.weights, face.head.roll].map(x => x.toFixed(4)).join(',');
    assert.ok(!rendered.includes(fingerprint), `${preset.id} must not be a renamed identical pose`);
    rendered.push(fingerprint);
  }
});

test('every micro action actually moves its declared head axis and recovers smoothly', () => {
  const categories = new Set(MICRO_ACTION_CATEGORIES.map(c => c.id));
  for (const [id, action] of Object.entries(EXPANDED_MICRO_ACTIONS)) {
    assert.ok(categories.has(action.category) && action.name && action.note, id);
    assert.ok(['pitch', 'yaw', 'roll'].includes(action.axis), id);
    assert.deepEqual(action.keys[0], [0, 0]);
    assert.deepEqual(action.keys.at(-1), [action.duration, 0]);
    assert.ok(action.keys.every(([time, value], i) => Number.isFinite(time) && Number.isFinite(value)
      && Math.abs(value) <= .1 && (i === 0 || time > action.keys[i - 1][0])));
    const face = new FaceController(); face.headSway = false;
    assert.equal(face.trigger(id, `play-${id}`, 0), true);
    let peak = 0, previous = 0;
    for (let frame = 0; frame / 120 < action.duration + 1; frame++) {
      face.update(frame / 120, 1 / 120, null, false, { mouthMode: 'closed' });
      const angle = face.head[action.axis];
      peak = Math.max(peak, Math.abs(angle));
      assert.ok(Math.abs(angle - previous) < .013, `${id} frame discontinuity`);
      previous = angle;
      for (const axis of ['pitch', 'yaw', 'roll']) if (axis !== action.axis) assert.equal(face.head[axis], 0);
      finitePose(face);
    }
    assert.ok(peak > .018, `${id} has no visible motion`);
    assert.ok(Math.abs(face.head[action.axis]) < 1e-5, `${id} did not release`);
    assert.equal(face.cues.length, 0);
  }
});

test('all added presets retain speech ownership with overlay, silent chunks and closed consonants', () => {
  const lip = { weights: asWeights({ a: .24, i: .14, mouthWide: .17, mouthNarrow: .09 }), closure: 1 };
  for (const preset of EXPANDED_PRESETS) {
    const face = new FaceController(), neutral = new FaceController();
    face.setPreset(preset.id, 1); face.begin(1); neutral.begin(1);
    const overlay = asWeights(preset.morphs);
    for (let frame = 0; frame < 60; frame++) {
      face.playback(1, 'playing', frame / 60); neutral.playback(1, 'playing', frame / 60);
      face.update(frame / 60, 1 / 60, lip, false, { mouthMode: 'speech' });
      neutral.update(frame / 60, 1 / 60, lip, false, { mouthMode: 'speech' });
      const mixed = blendExpressionOverlay(face.weights, overlay, { mouthMode: 'speech', closure: 1 });
      for (const index of mouth) assert.equal(mixed[index], neutral.weights[index], `${preset.id} stole articulation`);
      assert.equal(mixed[C.smile], face.weights[C.smile], `${preset.id} opened a closed-consonant corner`);
      finitePose(face);
    }
    for (let frame = 60; frame < 90; frame++) face.update(frame / 60, 1 / 60, null, false, { mouthMode: 'speech' });
    assert.ok(mouth.every(i => face.weights[i] < 1e-7), `${preset.id} opens on an empty audio chunk`);
    face.update(1.5, 1 / 60, lip, false, { mouthMode: 'closed' });
    const closed = blendExpressionOverlay(face.weights, overlay, { mouthMode: 'closed' });
    assert.ok(mouth.every(i => closed[i] === 0), preset.id);
    assert.ok(closed.every(x => Number.isFinite(x) && x >= 0 && x <= 1));
  }
});

test('added audio-scoped faces and micro actions cancel without replay into the next epoch', () => {
  for (const [i, preset] of EXPANDED_PRESETS.entries()) {
    const face = new FaceController(); face.headSway = false; face.begin(10);
    const action = EXPANDED_MICRO_ACTION_IDS[i % EXPANDED_MICRO_ACTION_IDS.length];
    const cue = { id: `expression-${i}`, kind: 'expression', preset: preset.id, at: 0, duration: 2, epoch: 10, clock: 'audio' };
    assert.equal(face.enqueue(cue), true);
    assert.equal(face.trigger(action, `micro-${i}`, 0), true);
    for (let frame = 0; frame < 18; frame++) {
      face.playback(10, 'playing', frame / 60);
      face.update(frame / 60, 1 / 60, null, false, { mouthMode: 'closed' });
    }
    assert.ok(face.executedCues.some(c => c.preset === preset.id));
    assert.ok(face.executedCues.some(c => c.action === action));
    assert.equal(face.cancel(10), true);
    let previous = [...face.weights];
    for (let frame = 18; frame < 90; frame++) {
      face.update(frame / 60, 1 / 60, null, false, { mouthMode: 'closed' });
      assert.ok([...face.weights].every((x, j) => x <= previous[j] + 1e-7), `${preset.id} rebounds after cancel`);
      previous = [...face.weights];
      finitePose(face);
    }
    assert.equal(face.cues.length, 0);
    assert.equal(face.activeActions.length, 0);
    assert.ok(face.weights.every(x => x < .001));
    assert.ok(Object.values(face.head).every(x => Math.abs(x) < .001));
    assert.equal(face.begin(11), true);
    assert.equal(face.enqueue({ ...cue, id: `late-${i}` }), false);
    assert.equal(face.playback(10, 'playing', 1), false);
    assert.equal(face.epoch, 11);
  }
});

test('new face and head reactions hold during pause and resume from the media clock', () => {
  const face = new FaceController(); face.headSway = false; face.begin(1);
  face.enqueue({ id: 'held-face', kind: 'expression', preset: 'empathy', epoch: 1, clock: 'audio', at: 0, duration: 3 });
  face.trigger('thought_tilt', 'held-head', 0);
  for (let frame = 0; frame <= 20; frame++) {
    face.playback(1, 'playing', frame / 60);
    face.update(frame / 60, 1 / 60, null, false, { mouthMode: 'closed' });
  }
  const weights = [...face.weights], head = { ...face.head };
  face.playback(1, 'paused', 20 / 60);
  for (let frame = 21; frame < 100; frame++) face.update(frame / 60, 1 / 60, null, false, { mouthMode: 'closed', paused: true });
  assert.deepEqual([...face.weights], weights); assert.deepEqual(face.head, head);
  assert.equal(face.cues.length, 2);
  face.playback(1, 'playing', .55); face.update(100 / 60, 1 / 60, null, false, { mouthMode: 'closed' });
  assert.ok(face.head.roll > head.roll);
  assert.ok(face.activeActions.includes('thought_tilt'));
});
