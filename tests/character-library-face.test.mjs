import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContinuousFaceController } from '../preview/core/continuous-face-controller.js';
import { ACTIVITY_IDS, ACTIVITY_LIBRARY, sampleActivity } from '../preview/core/activity-library.js';
import { GESTURES } from '../preview/core/motion-profile.js';
import { CharacterCenter } from '../realtime/character-center/center.mjs';
import { CHARACTER_ACTIONS } from '../realtime/character-center/catalog.mjs';
import { ActionFaceAdapter, describeExecutedFace, LIBRARY_GESTURE_FACE_KINDS,
  ACTIVITY_FACE_KINDS } from '../realtime/character-center/action-face.mjs';
import { ATTITUDE_KINDS, FACE_PROFILES, LOCAL_MATH_SAMPLES } from '../realtime/character-center/face-profiles.mjs';

const leaf = (source, index, value, ratio = 1) => ({ values: { [source]: value },
  mapping: [{ source, leaves: [{ index, ratio }] }] });
function fixture() {
  const shapes = {
    neutral: { values: {}, mapping: [] },
    care: leaf('B_Sad', 1, -.7), smile: leaf('M_Smile_R', 2, .8),
    tired: leaf('E_Close', 3, .9), curious: leaf('E_Stare', 4, .5),
    phoneme: leaf('Aa', 5, .6), blink: leaf('E_Smile_R', 6, .8),
  };
  const ids = { attention: 'neutral', serious: 'care', concern: 'care', warm: 'smile',
    curious: 'curious', playful: 'smile', sad: 'care', excited: 'smile', surprise: 'phoneme',
    confused: 'care', smile: 'smile', anger: 'care', tired: 'tired' };
  const profiles = Object.fromEntries(Object.entries(ids).map(([kind, recipeId]) => [kind,
    { recipeId, gain: 1, positive: ['warm', 'playful', 'excited', 'smile'].includes(kind) }]));
  return new ContinuousFaceController({ recipes: Object.entries(shapes).map(([id, value]) => ({ id, ...value })),
    profiles, morphCount: 7, mouthIndices: [2, 5] });
}
const intent = (extra = {}) => ({ id: 'care', source: 'topic', revision: 1, kind: 'concern',
  strength: .8, evidenceId: 'user:1', ...extra });
function advance(face, seconds, options = {}) {
  if (face.wall === null) face.update(0, options);
  const start = face.wall, frames = Math.ceil(seconds * 60);
  for (let i = 1; i <= frames; i++) face.update(start + seconds * i / frames, options);
}
const active = action => ({ id: 'body-1', action, status: 'playing', displayedAt: 0,
  owner: { sourceKey: 'user:1', sourceVersion: 1, semanticRevision: 1 } });

test('secondary is optional, zero strength is identical, and invalid nuances cannot consume an update', () => {
  const a = fixture(), b = fixture(); a.setAttitude(intent());
  assert.equal(b.setAttitude(intent({ secondary: { kind: 'warm', strength: 0 } })), true);
  advance(a, .5); advance(b, .5); assert.deepEqual(a.snapshot().weights, b.snapshot().weights);
  const before = b.snapshot();
  for (const secondary of [null, [], {}, { kind: 'concern', strength: 1 }, { kind: 'anger', strength: .5 },
    { kind: 'warm', strength: NaN }, { kind: 'warm', strength: .5, recipeId: 'care' },
    { kind: 'warm', strength: .5, emotion: { V: 1 } }]) {
    assert.equal(b.setAttitude(intent({ revision: 2, secondary })), false);
    assert.deepEqual(b.snapshot().attitude, before.attitude);
    assert.deepEqual(b.snapshot().weights, before.weights);
  }
  assert.equal(b.setAttitude(intent({ revision: 2, secondary: { kind: 'warm', strength: .6 } })), true);
});

test('concern with a warm nuance keeps its brows and mathematical fatigue through body, lips and blink', () => {
  const face = fixture(), math = structuredClone(LOCAL_MATH_SAMPLES[6]), original = structuredClone(math);
  face.setMathematical(math, 1); face.setAttitude(intent({ secondary: { kind: 'warm', strength: .6 } }));
  const primary = fixture(); primary.setAttitude(intent());
  assert.equal(face.target()[1], primary.target()[1], 'secondary corners cannot rewrite primary brows');
  assert.ok(face.target()[2] > 0 && face.target()[2] < .2, 'only a limited warm nuance');
  const fatigue = face.fatigue[3]; assert.ok(fatigue > .2);
  face.setActionOverlay({ id: 'consider', source: 'body', revision: 1, kind: 'serious', strength: .5, phase: 1 });
  advance(face, .5, { speaking: true, lipWeights: { 5: .7 } });
  assert.ok(face.output[1] < -.4); assert.ok(face.output[3] >= fatigue - 1e-5);
  assert.ok(face.output[5] > .69, 'actual articulation owns only its needed mouth parts');
  advance(face, .12, { speaking: true, lipWeights: { 5: .3 }, blink: 1 });
  assert.ok(face.output[3] > .8); assert.ok(face.output[1] < -.4);
  assert.deepEqual(math, original); assert.deepEqual(face.math, original);
});

test('same evidence cannot renew a stance by changing ids, secondary kinds or body revisions', () => {
  const face = fixture(); face.setAttitude(intent({ secondary: { kind: 'warm', strength: .4 } }));
  advance(face, 22);
  face.setAttitude(intent({ id: 'serious', kind: 'serious', revision: 2, renew: true,
    secondary: { kind: 'curious', strength: .4 } }));
  assert.equal(face.attitude.confirmedAt, 0);
  face.setAttitude(intent({ id: 'attention', kind: 'attention', revision: 3, evidenceId: 'execution:1', renew: false }));
  assert.equal(face.attitude.confirmedAt, 0, 'an execution receipt cannot renew semantic intent');
  advance(face, 4); assert.equal(face.attitudeState().effectiveKind, 'attention');
  assert.ok(face.output.every(value => Math.abs(value) < 1e-4));
  face.setAttitude(intent({ id: 'care-new', revision: 4, evidenceId: 'user:2', renew: true }));
  assert.ok(face.attitude.confirmedAt >= 25.9, 'a new user observation renews the semantic lease');
});

test('a suppressed old smile cannot return after a primary change or a late phase/reaction revision', () => {
  const face = fixture(); face.setAttitude(intent());
  const body = { id: 'old-welcome', source: 'body', revision: 1, kind: 'warm', strength: 1, phase: 1 };
  const reaction = { id: 'old-smile', source: 'reply', revision: 1, kind: 'smile', strength: 1, hold: 1 };
  face.setActionOverlay(body); face.react(reaction); advance(face, .1);
  assert.equal(face.clearAttitude({ id: 'care', source: 'topic', revision: 2 }), true);
  face.setActionOverlay({ ...body, revision: 2 }); face.react({ ...reaction, revision: 2 }); advance(face, .3);
  assert.ok(Math.abs(face.output[2]) < 1e-8);
  assert.equal(face.overlays.size, 1, 'face arbitration never cancels the body plan');
  face.react({ ...reaction, id: 'fresh-smile', revision: 3 }); advance(face, .3);
  assert.ok(face.output[2] > .6, 'a genuinely new compatible reaction may express a smile');
});

test('neutral association and zero-strength action do not bleach a mathematical expression', () => {
  const face = fixture(); face.setMathematical(LOCAL_MATH_SAMPLES[2], 1);
  const before = Array.from(face.target());
  face.setActionOverlay({ id: 'walking', source: 'body', revision: 1, kind: 'attention', strength: .15, phase: 1 });
  assert.deepEqual(Array.from(face.target()), before);
  face.setActionOverlay({ id: 'no-strength', source: 'body', revision: 2, kind: 'serious', strength: 0, phase: 1 });
  assert.deepEqual(Array.from(face.target()), before);
});

test('the centre transports both stances on the same actual media frontier and keeps the old tool shape valid', () => {
  const face = fixture(), center = new CharacterCenter({ face, body: { snapshot: () => ({}), pause() {}, cancel() {} }, clock: () => 0 });
  center.beginTurn({ turnId: 'one' });
  const event = { type: 'character_expression', sourceKey: 'assistant:one', sourceVersion: 'one',
    semanticRevision: 1, requestId: 'request-1', turnId: 'one',
    mediaAnchor: { kind: 'audio_frame', turnId: 'one', segmentIndex: 0, providerConnectionId: 'p', responseId: 'r', frame: 2400 },
    command: { mode: 'attitude', kind: 'concern', strength: .8, secondary: { kind: 'warm', strength: .4 }, evidenceRef: 'assistant:one:40' } };
  assert.equal(center.message(event), true); assert.equal(face.attitude, null);
  const trial = { id: 'one', owner: { epoch: 1 }, segments: [{ index: 0, connectionId: 'p', responseId: 'r', startFrame: 0, frames: 4800 }] };
  center.advance({ epoch: 1, status: 'paused', time: .15 }, trial); assert.equal(face.attitude, null);
  center.advance({ epoch: 1, status: 'playing', time: .1 }, trial);
  assert.deepEqual(face.attitude.secondary, event.command.secondary);
  const single = structuredClone(event); delete single.command.secondary; single.semanticRevision = 2;
  single.requestId = 'request-2'; single.mediaAnchor = { kind: 'immediate' };
  assert.equal(center.message(single), true); assert.equal(face.attitude.secondary, undefined);
});

test('every authored gesture has an explicit mapping and uses the actual warped clock', () => {
  assert.deepEqual(Object.keys(LIBRARY_GESTURE_FACE_KINDS).sort(), Object.keys(GESTURES).sort());
  const rows = Object.values(CHARACTER_ACTIONS).filter(row => row.executor === 'conversation' && row.kind === 'gesture');
  assert.ok(rows.length >= 56);
  for (const definition of rows) {
    const row = active(definition.id), gesture = { id: row.id, gesture: definition.name,
      age: GESTURES[definition.name].duration * .45, expressionWeight: .6, phase: 'stroke' };
    const scene = { executor: 'conversation', body: { active: row } };
    const result = describeExecutedFace(row, scene, { gestures: [gesture] });
    assert.equal(result.reason, undefined, definition.id); assert.ok(FACE_PROFILES[result.kind]);
    assert.ok(result.phase >= 0 && result.phase <= 1); assert.equal(result.sampleTime, gesture.age);
    row.displayedAt = -9999;
    assert.deepEqual(describeExecutedFace(row, scene, { gestures: [gesture] }), result, 'display time is not the source clock');
    gesture.recovering = true;
    assert.equal(describeExecutedFace(row, scene, { gestures: [gesture] }).reason, 'gesture_not_active');
  }
});

test('all 76 life activities use real sampled face targets through their phases, without assuming an 8-second duration', () => {
  assert.equal(ACTIVITY_IDS.length, 76);
  assert.ok(ACTIVITY_IDS.includes('approach_desk_seated'));
  let checked = 0;
  for (const name of ACTIVITY_IDS) {
    const row = active(`activity:${name}`), definition = { id: row.action, name, executor: 'activity' };
    for (const fraction of [.01, .2, .5, .8, .99]) {
      const elapsed = ACTIVITY_LIBRARY[name].duration * fraction;
      const pose = sampleActivity(name, elapsed), state = { activeId: name, status: 'playing', done: false, elapsed, phase: pose.phase, pose };
      const result = describeExecutedFace(row, { executor: 'activity', body: { active: row }, activity: state },
        { definitions: { [row.action]: definition }, activityFace: { preset: 'invented', intensity: 1 } });
      assert.equal(result.reason, undefined, `${name}:${pose.phase}`);
      assert.equal(result.kind, ACTIVITY_FACE_KINDS[pose.face.preset]);
      assert.equal(result.strength, pose.face.intensity); assert.equal(result.executedPhase, pose.phase);
      assert.equal(result.sampleTime, elapsed); checked++;
    }
  }
  assert.equal(checked, 380);
});

const nativeDefinition = { id: 'native:thinking01', name: 'thinking01', executor: 'native',
  faceAssociation: { kind: 'serious', strength: .35 },
  phases: ['thinking-start', 'thinking-loop', 'thinking-end'],
  phaseData: [{ id: 'thinking-start', phase: 'start', duration: 1.6667 },
    { id: 'thinking-loop', phase: 'loop', duration: 2.6667 }, { id: 'thinking-end', phase: 'end', duration: 1.7333 }] };
function nativeInput(part, phaseTime) {
  const row = active(nativeDefinition.id), native = { id: part.id, phase: part.phase, phaseTime, state: 'playing', cancelled: false };
  return { row, scene: { executor: 'native', body: { active: row }, native }, options: { definitions: { [row.action]: nativeDefinition } } };
}
test('native source phases use their measured clocks; repeated middle stays stable and return/cancellation clears', () => {
  for (const part of nativeDefinition.phaseData) {
    const { row, scene, options } = nativeInput(part, part.duration / 2);
    const middle = describeExecutedFace(row, scene, options);
    assert.equal(middle.kind, 'serious'); assert.equal(middle.sourceId, part.id); assert.equal(middle.phase, 1);
    scene.native.phaseTime = 0;
    assert.equal(describeExecutedFace(row, scene, options).phase, part.phase === 'start' ? 0 : 1);
    scene.native.phaseTime = part.duration;
    assert.equal(describeExecutedFace(row, scene, options).phase, part.phase === 'end' ? 0 : 1);
    for (const changed of [{ phase: 'entry' }, { phase: 'return' }, { cancelled: true }, { state: 'settling' }, { state: 'complete-held' }]) {
      assert.equal(describeExecutedFace(row, { ...scene, native: { ...scene.native, ...changed } }, options).reason, 'native_not_active');
    }
    for (const changed of [{ id: 'another-source' }, { phase: 'invented' }, { phaseTime: -1 }, { phaseTime: NaN }, { phaseTime: 100 }]) {
      assert.equal(describeExecutedFace(row, { ...scene, native: { ...scene.native, ...changed } }, options).reason, 'native_phase_unverified');
    }
  }
});

test('all registered native source phases resolve from their real catalogue contracts, including numbered loops', () => {
  const definitions = Object.values(CHARACTER_ACTIONS).filter(row => row.executor === 'native');
  assert.ok(definitions.length > 2, 'expanded native catalogue must be loaded');
  let phases = 0;
  for (const definition of definitions) {
    const row = active(definition.id);
    for (const part of definition.phaseData) {
      const scene = { executor: 'native', body: { active: row },
        native: { id: part.id, phase: part.phase, phaseTime: part.duration * .5, state: 'playing', cancelled: false } };
      const result = describeExecutedFace(row, scene);
      assert.equal(result.reason, undefined, `${definition.id}:${part.id}`);
      assert.equal(result.kind, definition.faceAssociation.kind); assert.equal(result.sourceId, part.id);
      assert.ok(Number.isFinite(result.phase) && result.phase >= 0 && result.phase <= 1); phases++;
      scene.native.phase = 'return'; assert.equal(describeExecutedFace(row, scene).reason, 'native_not_active');
    }
  }
  assert.ok(phases > 200, 'all registered source clips were checked');
});

test('supported conversation needs explicit variant permission and actual overlay identity/weight', () => {
  const row = active('action:nod'); row.performance = { variant_set: ['support-preserving'] }; row.selectedVariant = 'support-preserving';
  const scene = { executor: 'supported', body: { active: row },
    supported: { id: row.id, kind: 'nod', duration: 1.4, elapsed: .5, cancelElapsed: null, weight: .7, strength: .6 } };
  const result = describeExecutedFace(row, scene);
  assert.equal(result.kind, 'attention'); assert.equal(result.phase, .7); assert.equal(result.sampleTime, .5);
  assert.equal(describeExecutedFace({ ...row, performance: undefined }, scene).reason, 'snapshot_executor_mismatch');
  scene.supported.cancelElapsed = 0;
  assert.equal(describeExecutedFace(row, scene).reason, 'supported_not_active');
  scene.supported.cancelElapsed = null; scene.supported.id = 'old-overlay';
  assert.equal(describeExecutedFace(row, scene).reason, 'supported_not_active');
});

test('actual activity completion, stale body snapshots, missing props pauses and unknown face presets never fabricate another onset', () => {
  const row = active('activity:read_seated'), definitions = { [row.action]: { name: 'read_seated', executor: 'activity' } };
  const state = { activeId: 'read_seated', status: 'playing', done: false, elapsed: 4,
    phase: 'read', pose: sampleActivity('read_seated', 4) };
  const scene = { executor: 'activity', body: { active: row }, activity: state };
  assert.ok(describeExecutedFace(row, scene, { definitions }).kind);
  assert.equal(describeExecutedFace(row, { ...scene, body: { active: { id: 'retired-body' } } }, { definitions }).reason, 'snapshot_body_mismatch');
  for (const changed of [{ done: true }, { stopMode: 'landing' }, { activeId: 'another' }, { status: 'preparing' }])
    assert.equal(describeExecutedFace(row, { ...scene, activity: { ...state, ...changed } }, { definitions }).reason, 'activity_not_active');
  assert.equal(describeExecutedFace(row, { ...scene, activity: { ...state, pose: { face: { preset: 'unknown', intensity: 1 } } } }, { definitions }).reason, 'unmapped_activity_face');
});

test('head cues use executed evidence while pure blink remains mechanically owned', () => {
  const definition = Object.values(CHARACTER_ACTIONS).find(row => row.channel === 'head');
  const row = active(definition.id), scene = { executor: 'conversation', body: { active: row }, actionLayer: { executedCues: [] } };
  assert.equal(describeExecutedFace(row, scene).reason, 'head_not_executed');
  scene.actionLayer.executedCues.push({ id: row.id, action: definition.name, age: definition.duration / 2 });
  assert.equal(describeExecutedFace(row, scene).kind, 'attention');
  const blink = active('action:blink');
  assert.equal(describeExecutedFace(blink, { executor: 'conversation', body: { active: blink } }).reason, 'mechanical_face_owned');
});

test('the full-library adapter records actual phase and removes its contribution on owner retirement even during pause', () => {
  const face = fixture(); let revision = 0, current = true;
  const adapter = new ActionFaceAdapter({ face, current: () => current, nextRevision: () => ++revision });
  const row = active('gesture:shrug'), gesture = { id: row.id, gesture: 'shrug', age: .8, strength: .6, phase: 'stroke' };
  const snapshot = { executor: 'conversation', body: { active: row } };
  const out = adapter.update({ active: row, snapshot, gestures: [gesture] });
  assert.equal(out.mapped, true); assert.equal(out.executedFace.sampleTime, .8); assert.equal(out.overlay.kind, 'confused');
  const before = structuredClone(row); current = false;
  adapter.update({ active: row, snapshot, gestures: [gesture], paused: true });
  assert.equal(face.overlays.size, 0); assert.deepEqual(row, before);
});

const sourceCandidates = [
  process.env.FACE_SOURCE_ROOT && path.join(process.env.FACE_SOURCE_ROOT, 'outputs/action-execution-preparation-20261023/face-playback.json'),
  fileURLToPath(new URL('../outputs/action-execution-preparation-20261023/face-playback.json', import.meta.url)),
  fileURLToPath(new URL('../../face/outputs/action-execution-preparation-20261023/face-playback.json', import.meta.url)),
].filter(Boolean);
const realSource = sourceCandidates.find(candidate => fs.existsSync(candidate));
test('real 17 native recipes and all primary/secondary pairs retain finite signed leaves, lip and fatigue ownership', { skip: !realSource }, () => {
  const data = JSON.parse(fs.readFileSync(realSource, 'utf8'));
  const create = () => new ContinuousFaceController({ recipes: data.recipes, morphCount: data.model.morphCount, mouthIndices: data.mouthIndices });
  const sampled = create(), native = data.recipes.filter(recipe => recipe.sourceScope === 'aimisi-character');
  assert.equal(native.length, 17);
  let negative = false;
  for (const recipe of native) {
    for (const at of [0, .2, .7]) {
      const values = sampled.sampleRecipe(recipe.id, at);
      assert.ok(values.every(Number.isFinite)); negative ||= values.some(value => value < 0);
    }
  }
  assert.equal(negative, true, 'signed native leaves are retained');
  for (const primary of ATTITUDE_KINDS) for (const secondary of ATTITUDE_KINDS.filter(kind => kind !== primary)) {
    const face = create(), math = structuredClone(LOCAL_MATH_SAMPLES[6]), original = structuredClone(math);
    face.setMathematical(math, 1);
    assert.equal(face.setAttitude(intent({ id: primary, kind: primary, secondary: { kind: secondary, strength: .65 } })), true);
    advance(face, .3);
    for (const i of face.articulators) assert.ok(Math.abs(face.output[i]) < 1e-8, `${primary}/${secondary}: sustained phoneme ${i}`);
    for (const i of face.unilateralClosures) assert.ok(Math.abs(face.output[i]) < 1e-8, `${primary}/${secondary}: sustained wink ${i}`);
    advance(face, .2, { speaking: true, lipWeights: { 52: .3, 53: .1 } });
    assert.ok(face.output[52] > .29); assert.ok(face.output[53] > .09);
    assert.equal(face.articulators.has(0), false, 'brows are not articulation even when geometry overlaps');
    for (const i of face.blinkIndices) assert.ok(face.output[i] >= face.fatigue[i] - 1e-4);
    assert.ok(face.output.every(Number.isFinite)); assert.deepEqual(math, original);
  }
});
