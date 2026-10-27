import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ContinuousFaceController } from '../preview/core/continuous-face-controller.js';
import { LOCAL_MATH_SAMPLES, FACE_TIMING } from '../realtime/character-center/face-profiles.mjs';

const row = (source, index, ratio = 1) => ({ source, leaves: [{ index, ratio }] });
const recipes = [
  { id: 'neutral', values: {}, mapping: [] },
  { id: 'smile', values: { M_Smile_R: .8, M_Smile_L: .4, E_Blephar: .8 }, mapping: [row('M_Smile_R', 1), row('M_Smile_L', 2), row('E_Blephar', 4)] },
  { id: 'sad', values: { B_Sad: .7, M_Ennui_R: .35 }, mapping: [row('B_Sad', 5), row('M_Ennui_R', 7)] },
  { id: 'signed', nativeData: { duration: 1, curves: [{ name: 'B_Sad', keys: [{ time: 0, value: -.7 }, { time: 1, value: -.7 }] }] }, mapping: [row('B_Sad', 5, .5), row('B_Sad', 8, 1)] },
  { id: 'tired', values: { E_Close: .9 }, mapping: [row('E_Close', 3)] },
  { id: 'open', values: { S_01: .65 }, mapping: [row('S_01', 6)] },
];
const p = (recipeId, positive = false) => ({ recipeId, gain: 1, positive });
const profiles = { attention: p('neutral'), serious: p('sad'), concern: p('sad'), warm: p('smile', true), curious: p('sad'), playful: p('smile', true), sad: p('sad'), excited: p('smile', true), surprise: p('signed'), confused: p('sad'), smile: p('smile', true), anger: p('sad'), tired: p('tired') };
const fixture = () => new ContinuousFaceController({ recipes, profiles, morphCount: 10, mouthIndices: [1, 2, 6, 7] });
const attitude = (extra = {}) => ({ id: 'topic-care', kind: 'concern', source: 'conversation', revision: 1, strength: .8, evidenceId: 'user-1', ...extra });
function advance(c, seconds, options = {}) {
  if (c.wall === null) c.update(0, options);
  const start = c.wall, frames = Math.ceil(seconds * 120);
  for (let i = 1; i <= frames; i++) c.update(start + seconds * i / frames, options);
}

test('native signed leaves and left/right ratios survive sampling without 0..1 clipping', () => {
  const c = fixture();
  assert.equal(c.react({ id: 'notice', kind: 'surprise', source: 'user', revision: 1, strength: 1 }), true);
  advance(c, .35); assert.ok(c.output[5] < -.32); assert.ok(c.output[8] < -.64);
  assert.ok(Math.abs(c.output[8] / c.output[5] - 2) < 1e-10);
  const smile = c.sampleRecipe('smile'); assert.equal(smile[1] / smile[2], 2);
});

test('mathematical snapshots are read-only and revision guards preserve the newer baseline', () => {
  const c = fixture(), sample = structuredClone(LOCAL_MATH_SAMPLES[2]), before = structuredClone(sample);
  assert.equal(c.setMathematical(sample, 4), true); advance(c, .7);
  const base = Array.from(c.base); assert.ok(c.output[1] > .3); assert.deepEqual(sample, before);
  assert.equal(c.setMathematical(LOCAL_MATH_SAMPLES[3], 3), false); assert.deepEqual(Array.from(c.base), base);
  assert.equal(c.setMathematical({ V: 0, A: NaN }, 5), false);
});

test('a current concerned attitude suppresses old happy math and a welcome tail without cancelling the body', () => {
  const c = fixture(); c.setMathematical(LOCAL_MATH_SAMPLES[2], 1); advance(c, .8);
  assert.ok(c.output[1] > .3); c.setAttitude(attitude());
  assert.equal(c.setActionOverlay({ id: 'welcome-tail', kind: 'warm', source: 'body', revision: 1, strength: 1 }), true);
  advance(c, .8); assert.ok(c.output[1] < 1e-6); assert.ok(c.output[5] > .5);
  assert.equal(c.snapshot().overlays.length, 1, 'semantic incompatibility does not pretend to cancel the body');
});

test('same-intent 10Hz revisions preserve their start, velocity and semantic lease', () => {
  const c = fixture(); c.update(0); c.setAttitude(attitude()); advance(c, .12);
  const before = c.snapshot();
  assert.equal(c.setAttitude(attitude({ revision: 2, strength: .5 })), true);
  c.update(c.wall); assert.deepEqual(c.snapshot().weights, before.weights); assert.deepEqual(c.snapshot().velocity, before.velocity);
  for (let revision = 3; revision < 30; revision++) { advance(c, .1); c.setAttitude(attitude({ revision, strength: .55 })); }
  assert.equal(c.attitude.started, 0); assert.equal(c.attitude.confirmedAt, 0); assert.ok(c.output[5] > .35);
  c.setAttitude(attitude({ revision: 30, evidenceId: 'user-2', renew: true }));
  assert.ok(c.attitude.confirmedAt > 2.5); assert.equal(c.attitude.started, 0);
});

test('expired semantics fade over 20+5 seconds to attention without revealing a cheerful baseline', () => {
  const c = fixture(); c.setMathematical(LOCAL_MATH_SAMPLES[2], 1); c.setAttitude(attitude());
  advance(c, 19); assert.equal(c.snapshot().attitude.fade, 0);
  advance(c, 3.5); assert.ok(c.snapshot().attitude.fade > .4 && c.snapshot().attitude.fade < .6);
  advance(c, 3.5); assert.equal(c.snapshot().attitude.effectiveKind, 'attention');
  assert.ok(c.output[1] < 1e-10); assert.ok(Math.abs(c.output[5]) < 1e-5);
  assert.equal(c.mathRevision, 1);
});

test('old versions and stale source results cannot replace a newer attitude', () => {
  const c = fixture(); c.setAttitude(attitude({ source: 'old', revision: 4 }));
  assert.equal(c.setAttitude(attitude({ id: 'new-topic', kind: 'serious', source: 'new', revision: 6 })), true);
  assert.equal(c.setAttitude(attitude({ source: 'old', revision: 5 })), false);
  assert.equal(c.clearAttitude({ id: 'new-topic', source: 'old', revision: 7 }), false);
  assert.equal(c.setAttitude(attitude({ id: 'new-topic', kind: 'warm', source: 'new', revision: 7 })), false);
});

test('cancelling an old utterance retires only its cues and cannot erase math or current attitude', () => {
  const c = fixture(); c.setMathematical(LOCAL_MATH_SAMPLES[0], 1); c.setAttitude(attitude());
  c.react({ id: 'reaction', kind: 'surprise', source: 'response-1', revision: 1, strength: .5 }); advance(c, .12);
  const current = c.snapshot(); assert.equal(c.cancel({ source: 'response-1', revision: 1 }), true);
  c.update(c.wall); assert.deepEqual(c.snapshot().weights, current.weights); assert.equal(c.attitude.id, 'topic-care'); assert.equal(c.mathRevision, 1);
  assert.equal(c.react({ id: 'late', kind: 'smile', source: 'response-1', revision: 1 }), false);
  advance(c, 1); assert.ok(c.output[5] > .5);
});

test('a short reaction returns to the latest attitude, not its triggering face', () => {
  const c = fixture(); c.setAttitude(attitude()); c.react({ id: 'one', kind: 'surprise', source: 'reply', revision: 1, strength: 1 }); advance(c, .3);
  c.setAttitude(attitude({ id: 'new-topic', kind: 'serious', revision: 2, strength: .3 })); advance(c, 1);
  assert.equal(c.reactions.size, 0); assert.ok(Math.abs(c.output[5] - .21) < 1e-5);
});

test('speech and speech-end handover use the actually visible value and retain compatible corners', () => {
  const c = fixture(); c.setAttitude(attitude({ id: 'warm', kind: 'warm', strength: 1 })); advance(c, .6);
  advance(c, .2, { speaking: true, lipWeights: { 6: .7 }, closure: 0 }); assert.ok(c.output[6] > .69); assert.ok(c.output[1] > .79);
  advance(c, .1, { speaking: true, lipWeights: {}, closure: 1 }); assert.ok(c.output[6] < .001); assert.ok(c.output[1] > .1 && c.output[1] < .5);
  advance(c, .1, { speaking: true, lipWeights: { 6: .6 } }); const before = c.snapshot();
  c.update(c.wall, { speaking: false }); assert.deepEqual(c.snapshot().weights, before.weights); assert.deepEqual(c.snapshot().velocity, before.velocity);
  advance(c, .05, { speaking: false }); assert.ok(c.output[6] < .03, 'old phoneme releases from visible state without exposing a hidden state');
});

test('paused previews freeze the final face and do not count wall-time gaps against its semantic lease', () => {
  const c = fixture(); c.setAttitude(attitude()); advance(c, .2); const before = c.snapshot();
  c.update(c.wall + 5, { paused: true, speaking: true, lipWeights: { 6: 1 }, blink: 1 });
  assert.deepEqual(c.snapshot().weights, before.weights); assert.deepEqual(c.snapshot().velocity, before.velocity); assert.equal(c.now, before.time);
  c.update(c.wall + .01); assert.ok(c.now < .22);
});

test('excited smile-eyes and blink share a closure budget; a stuck blink cannot keep the face shut', () => {
  const c = fixture(); c.setAttitude(attitude({ id: 'happy', kind: 'excited', strength: 1 })); advance(c, .8);
  assert.ok(c.output[3] + c.output[4] <= FACE_TIMING.sustainedClosureLimit + 1e-5);
  advance(c, .14, { blink: 1, actionBlink: 1 }); assert.ok(c.output[3] + c.output[4] < 1.05);
  advance(c, .7, { blink: 1 }); assert.ok(c.output[3] + c.output[4] < .57);
  advance(c, .1, { blink: 0 }); advance(c, .12, { actionBlink: 1 }); assert.ok(c.output[3] > .25, 'falling input re-arms the next intentional blink');
});

test('tired eyelids can coexist with concern without reviving smile corners', () => {
  const c = fixture(); c.setMathematical(LOCAL_MATH_SAMPLES[6], 1); c.setAttitude(attitude()); advance(c, .7);
  assert.ok(c.output[3] > .2); assert.ok(c.output[5] > .5); assert.ok(c.output[1] < 1e-8);
});

test('all eight local math samples are finite component inputs, not cloud decisions', () => {
  assert.equal(LOCAL_MATH_SAMPLES.length, 8);
  for (const sample of LOCAL_MATH_SAMPLES) { const c = fixture(); assert.equal(sample.componentOnly, true); assert.equal(c.setMathematical(sample, 1), true); advance(c, .5); assert.ok(c.output.every(Number.isFinite)); }
});

test('finished reaction ids do not restart after an otherwise newer revision', () => {
  const c = fixture(), cue = { id: 'once', kind: 'surprise', source: 'one-response', revision: 1 };
  c.react(cue); advance(c, 1); assert.equal(c.reactions.size, 0);
  assert.equal(c.react({ ...cue, revision: 2 }), false);
  assert.equal(c.react({ ...cue, id: 'new-event', revision: 3 }), true);
});

test('unconfirmed evidence does not consume the ability to explicitly renew it later', () => {
  const c = fixture(); c.setAttitude(attitude()); advance(c, 2);
  c.setAttitude(attitude({ revision: 2, evidenceId: 'user-2', renew: false })); assert.equal(c.attitude.confirmedAt, 0);
  c.setAttitude(attitude({ revision: 3, evidenceId: 'user-2', renew: true })); assert.ok(c.attitude.confirmedAt > 1.9);
  const confirmed = c.attitude.confirmedAt; advance(c, 1);
  c.setAttitude(attitude({ revision: 4, evidenceId: 'user-2', renew: true })); assert.equal(c.attitude.confirmedAt, confirmed);
});

test('a semantic label cannot smuggle an incompatible arbitrary recipe through the guard', () => {
  const c = fixture(); assert.equal(c.setAttitude(attitude({ recipeId: 'smile' })), false);
  assert.equal(c.setActionOverlay({ id: 'wrong', kind: 'concern', recipeId: 'smile', source: 'body', revision: 1 }), false);
  assert.equal(c.setActionOverlay({ id: 'bad-phase', kind: 'warm', source: 'body', revision: 2, phase: NaN }), false);
});

test('a still-moving old action cannot indefinitely renew an expired specific attitude', () => {
  const c = fixture(); c.setAttitude(attitude()); c.setActionOverlay({ id: 'care-body', kind: 'concern', source: 'body', revision: 1, strength: 1 });
  advance(c, 26); assert.equal(c.snapshot().attitude.effectiveKind, 'attention'); assert.ok(Math.abs(c.output[5]) < 1e-5);
});

const realPath = 'outputs/action-execution-preparation-20261023/face-playback.json';
test('real sustained math and attitudes never hold a vowel, exposed teeth or one-sided wink', { skip: !fs.existsSync(realPath) },()=>{
 const data=JSON.parse(fs.readFileSync(realPath));
 const create=()=>new ContinuousFaceController({recipes:data.recipes,morphCount:data.model.morphCount,mouthIndices:data.mouthIndices});
 for(const sample of LOCAL_MATH_SAMPLES){const c=create();c.setMathematical(sample,1);advance(c,1);
  for(const i of c.articulators)assert.ok(Math.abs(c.output[i])<1e-8,`${sample.id}: mouth ${i}`);
  for(const i of c.unilateralClosures)assert.ok(Math.abs(c.output[i])<1e-8,`${sample.id}: wink ${i}`);
 }
 for(const kind of ['attention','concern','serious','warm','curious','playful','sad','excited']){
  const c=create();c.setAttitude(attitude({id:kind,kind,strength:1}));advance(c,1);
  for(const i of c.articulators)assert.ok(Math.abs(c.output[i])<1e-8,`${kind}: mouth ${i}`);
  assert.equal(c.articulators.has(0),false,'真面目 is a brow, not a phoneme');
 }
});
test('actual 17 character-native recipes keep their signed expanded leaves and all published profiles resolve', { skip: !fs.existsSync(realPath) }, () => {
  const data = JSON.parse(fs.readFileSync(realPath)), c = new ContinuousFaceController({ recipes: data.recipes, morphCount: data.model.morphCount, mouthIndices: data.mouthIndices });
  const native = data.recipes.filter(recipe => recipe.sourceScope === 'aimisi-character'); assert.equal(native.length, 17);
  for (const recipe of native) { const result = c.sampleRecipe(recipe.id); assert.ok(result.every(Number.isFinite)); }
  for (const kind of ['attention', 'concern', 'serious', 'warm', 'curious', 'playful', 'sad', 'excited']) assert.ok(c.profile(kind), kind);
  c.setMathematical(LOCAL_MATH_SAMPLES[2], 1); c.setAttitude(attitude()); advance(c, .7, { speaking: true, lipWeights: { 52: .3, 53: .1 } });
  for (const i of [64, 65]) assert.ok(Math.abs(c.output[i]) < .01, 'current concern suppresses positive smile corners');
  assert.ok(c.output.every(Number.isFinite));
});
