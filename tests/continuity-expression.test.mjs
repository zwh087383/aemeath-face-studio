import test from 'node:test';
import assert from 'node:assert/strict';
import { C, CHANNELS, VOWELS } from '../preview/core/profile.js';
import { ExpressionChoreographer, sampleReactionExpression, sampleAttitude, blendExpressionOverlay } from '../preview/core/expression-choreography.js';

test('waiting without uncertainty retains the same face as attentive listening', () => {
  const state = { warmth: .1, uncertainty: 0, tension: .04 };
  assert.deepEqual(sampleAttitude({ ...state, mode: 'thinking' }), sampleAttitude({ ...state, mode: 'listening' }));
});

test('executed micro materials use distinct facial timing and never claim articulation', () => {
  const samples = ['listen-adjust', 'nod', 'light-explain'].map(kind => {
    const values = sampleReactionExpression({ kind, age: .3, duration: 1, strength: 1 });
    for (const channel of [...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat, C.smile, C.frown]) assert.equal(values[channel], 0);
    return Array.from(values);
  });
  assert.notDeepEqual(samples[0], samples[1]); assert.notDeepEqual(samples[1], samples[2]);
});

test('an interrupted shared reaction releases its actual face without following the old peak', () => {
  const face = new ExpressionChoreographer(), reaction = { id: 'host:2:listen', kind: 'listen-adjust', age: .06, duration: 1, strength: 1 };
  face.update(0); face.update(.02, [], { reactions: [reaction] });
  let prior = Float32Array.from(face.weights);
  assert.ok(prior[C.browUp] > 0);
  for (let n = 2; n < 50; n++) {
    const values = face.update(n * .02, [], { reactions: [{ ...reaction, age: .18, recovering: true }] });
    assert.ok(values.every((value, index) => value <= prior[index] + 1e-8)); prior = Float32Array.from(values);
  }
  const replay = face.update(1, [], { reactions: [{ ...reaction, age: .18 }] });
  assert.ok(replay.every((value, index) => value <= prior[index] + 1e-8));
});

test('micro face pauses and respects the same closed/speech mouth authorization', () => {
  const face = new ExpressionChoreographer(), reaction = { id: 'r', kind: 'nod', age: .4, duration: 1, strength: 1 };
  face.update(0); face.update(.1, [], { reactions: [reaction] });
  const prior = Float32Array.from(face.weights);
  assert.deepEqual(face.update(.2, [], { paused: true, reactions: [{ ...reaction, age: .7 }] }), prior);
  const base = new Float32Array(CHANNELS.length); base[C.a] = .4;
  assert.equal(blendExpressionOverlay(base, prior, { mouthMode: 'speech', closure: 1 })[C.a], base[C.a]);
  assert.equal(blendExpressionOverlay(base, prior, { mouthMode: 'closed' })[C.a], 0);
});
