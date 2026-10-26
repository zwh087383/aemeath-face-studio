import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionFaceAdapter, ACTION_FACE_KINDS, READING_FACE_KINDS, gestureFacePhase } from '../realtime/character-center/action-face.mjs';
import { ContinuousFaceController } from '../preview/core/continuous-face-controller.js';
import { FACE_PROFILES } from '../realtime/character-center/face-profiles.mjs';

function setup() {
  const recipes = [
    { id: FACE_PROFILES.warm.recipeId, values: { M_Smile_R: .8 }, mapping: [{ source: 'M_Smile_R', leaves: [{ index: 0, ratio: 1 }] }] },
    { id: FACE_PROFILES.concern.recipeId, values: { B_Sad: -.6 }, mapping: [{ source: 'B_Sad', leaves: [{ index: 1, ratio: 1 }] }] },
    { id: FACE_PROFILES.serious.recipeId, values: { B_Sad: -.4 }, mapping: [{ source: 'B_Sad', leaves: [{ index: 1, ratio: 1 }] }] },
    { id: FACE_PROFILES.curious.recipeId, values: { E_Stare: .4 }, mapping: [{ source: 'E_Stare', leaves: [{ index: 2, ratio: 1 }] }] },
    { id: FACE_PROFILES.excited.recipeId, values: { M_Smile_R: .9 }, mapping: [{ source: 'M_Smile_R', leaves: [{ index: 0, ratio: 1 }] }] },
  ];
  const face = new ContinuousFaceController({ recipes, morphCount: 3 });
  let revision = 0, live = true;
  const adapter = new ActionFaceAdapter({ face, current: () => live, nextRevision: () => ++revision });
  const active = { id: 'character-action-8', action: 'gesture:wave', status: 'playing', displayedAt: 3,
    owner: { sourceKey: 'interaction:one', sourceVersion: 1, semanticRevision: 5 } };
  const gesture = { id: active.id, gesture: 'wave', age: .72, expressionWeight: .65, phase: 'stroke', recovering: false };
  return { face, adapter, active, gesture, setLive: value => { live = value; }, revision: () => revision };
}
const input = value => ({ active: value.active, gestures: [value.gesture], executor: 'conversation' });

test('only the explicit seven gesture and four reading mappings are available', () => {
  assert.deepEqual(Object.keys(ACTION_FACE_KINDS).sort(), ['celebration_compact', 'comfort', 'compare_options', 'curious', 'think', 'warm_welcome', 'wave']);
  assert.deepEqual(READING_FACE_KINDS, { attentive: 'attention', considering: 'serious', serene: 'attention', relieved: 'warm' });
});

test('executed gesture age drives an existing native recipe with a scalar envelope, never old leaves', () => {
  const value = setup(); value.face.update(0); const out = value.adapter.update(input(value));
  assert.equal(out.overlay.id, 'body:character-action-8'); assert.equal(out.overlay.source, value.active.owner.sourceKey);
  assert.equal(out.overlay.kind, 'warm'); assert.ok(out.overlay.phase > .9); assert.equal(out.overlay.strength, .65);
  assert.deepEqual(Object.keys(out.overlay).sort(), ['id', 'kind', 'phase', 'revision', 'source', 'strength']);
  value.face.update(.1); assert.ok(value.face.output[0] > 0);
  assert.equal(gestureFacePhase('wave', 0), 0); assert.equal(gestureFacePhase('wave', 200), null);
});

test('queued, merely admitted, unmatched and unmapped bodies do not fabricate a facial onset', () => {
  for (const [change, expected] of [
    [{ active: { status: 'queued' } }, 'no_active_body'],
    [{ active: { status: 'admitted', displayedAt: undefined } }, 'body_not_displayed'],
    [{ gestures: [] }, 'gesture_not_active'],
    [{ active: { action: 'gesture:shrug' } }, 'unmapped_gesture'],
    [{ executor: 'native' }, 'unmapped_body'],
  ]) {
    const value = setup(), args = input(value); Object.assign(args, change);
    args.active = { ...value.active, ...(change.active ?? {}) };
    assert.equal(value.adapter.update(args).reason, expected); assert.equal(value.face.overlays.size, 0);
  }
});

test('stable body id receives increasing revisions without restarting its onset or semantic attitude', () => {
  const value = setup(); value.face.update(0); value.adapter.update(input(value));
  const started = [...value.face.overlays.values()][0].started;
  value.face.update(.1); value.gesture.age = .9; value.adapter.update(input(value));
  assert.equal(value.face.overlays.size, 1); assert.equal([...value.face.overlays.values()][0].started, started);
  assert.ok(value.revision() >= 2); assert.equal(value.face.rejected.length, 0);
  const before = value.revision(); value.adapter.update(input(value)); assert.equal(value.revision(), before, 'identical targets do not spend revisions');
});

test('pause retains displayed contribution but cancellation and stale ownership clear it immediately', () => {
  const value = setup(); value.adapter.update(input(value)); const before = value.adapter.snapshot().overlay;
  value.gesture.age = 2; value.adapter.update({ ...input(value), paused: true });
  assert.deepEqual(value.adapter.snapshot().overlay, before);
  value.setLive(false); value.adapter.update({ ...input(value), paused: true }); assert.equal(value.face.overlays.size, 0);
});

test('mechanical retraction cannot renew an old smile and completion clears only its own layer', () => {
  const value = setup(); value.adapter.update(input(value));
  value.gesture.recovering = true; assert.equal(value.adapter.update(input(value)).reason, 'gesture_not_active');
  assert.equal(value.face.overlays.size, 0);
  value.gesture.recovering = false; value.adapter.update(input(value));
  value.active.status = 'cancelled'; value.adapter.update(input(value)); assert.equal(value.face.overlays.size, 0);
  value.active.status = 'completed'; value.adapter.update(input(value)); assert.equal(value.face.overlays.size, 0);
});

test('current concern suppresses a real wave smile without mutating the body row', () => {
  const value = setup(), before = structuredClone(value.active); value.face.update(0);
  value.face.setAttitude({ id: 'bad-news', source: 'topic', revision: 1, kind: 'concern', strength: .8 });
  value.adapter.update(input(value)); for (let i = 1; i <= 30; i++) value.face.update(i / 60);
  assert.equal(value.face.output[0], 0); assert.ok(value.face.output[1] < -.2); assert.deepEqual(value.active, before);
});

test('comfort tail uses concern even though its old authored tail contains smile channels', () => {
  const value = setup(); value.active.action = 'gesture:comfort'; value.gesture.gesture = 'comfort'; value.gesture.age = 2.3;
  value.face.update(0); const result = value.adapter.update(input(value));
  assert.equal(result.overlay.kind, 'concern'); for (let i = 1; i <= 30; i++) value.face.update(i / 60);
  assert.equal(value.face.output[0], 0); assert.ok(value.face.output[1] < 0);
});

test('reading uses the actual active pose face, and does not keep a completion preset alive', () => {
  const value = setup(); value.active.action = 'activity:read_seated';
  const out = value.adapter.update({ active: value.active, executor: 'activity', activityFace: { preset: 'considering', intensity: .6 } });
  assert.equal(out.overlay.kind, 'serious'); assert.equal(out.overlay.strength, .6);
  assert.equal(value.adapter.update({ active: value.active, executor: 'activity', activityFace: { preset: 'made_up', intensity: 1 } }).mapped, false);
  assert.equal(value.face.overlays.size, 0);
  value.adapter.update({ active: value.active, executor: 'activity', activityFace: { preset: 'relieved', intensity: .4 } });
  value.adapter.update({ active: null, executor: 'activity', activityFace: { preset: 'relieved', intensity: .4 } });
  assert.equal(value.face.overlays.size, 0);
});
