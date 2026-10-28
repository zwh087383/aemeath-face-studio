import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CharacterCenter } from '../realtime/character-center/center.mjs';
import { ContinuousFaceController } from '../preview/core/continuous-face-controller.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';

// Execute the actual live page frame with isolated display/audio adapters. This
// catches an omitted scene argument without loading a browser or a provider.
const viewer = readFileSync(new URL('../realtime/character-center/viewer.mjs', import.meta.url), 'utf8');
const frame = viewer.slice(viewer.indexOf('function frame(time){'), viewer.indexOf('\nfunction updateUI(){'));
assert.ok(frame.startsWith('function frame(time){'));
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const state = energy => ({ emotion: { V: 0, A: .35, S: .1 }, effectiveEnergy: energy });

function displayFrame({ face, center, component = false, wall = 0 }) {
  let options;
  const body = { active: null, executor: 'activity', events: [] };
  const scene = { bodyDirector: body, motion: { snapshot: () => ({ gestures: [] }) },
    body: { pose: { face: null } }, actionLayer: () => ({}), snapshot: () => ({}),
    step(time, dt, value) { options = { ...value, observedDt: dt }; return { actorState: {} }; } };
  runInNewContext(frame + '\nframe(testWall);', {
    testWall: wall,
    face, oldFace: face, center, scene, component, comparison: false, replaying: false,
    last: 0, frameTimes: [], lastRendered: null, renderFault: null, actorAt: 0, uiAt: 0,
    client: { current: null, ready: false, sync() {} },
    session: { audio: { snapshot: () => ({ status: 'idle', time: 0 }) }, lipSample: () => ({ weights: [], closure: 0 }) },
    captureOwnedVoice() {}, marker() {}, updateUI() {}, actionFace: { update() {} },
    AEMEATH_BINDINGS: [], requestAnimationFrame() {}, document: { hidden: false }, console,
    error(message) { throw Error(message); },
  });
  assert.ok(options, 'the real frame did not reach the scene');
  return options;
}

function seatedBody() {
  const body = new FullBodyController({ skeleton });
  assert.equal(body.play('sit_down'), true);
  for (let i = 0; i < 300 && !body.done; i++) body.update(body.now + .05, .05);
  assert.equal(body.pose.support, 'seated');
  return body;
}

test('live accepted mathematics reaches actual duration preparation, without changing default source speed', () => {
  const face = new ContinuousFaceController({ morphCount: 1 });
  const center = new CharacterCenter({ face, body: {}, clock: () => 0 });
  const body = seatedBody(), durations = [];
  for (const [index, energy] of [.15, .85].entries()) {
    assert.equal(center.message({ type: 'character_math', state: state(energy), mathRevision: index + 1 }), true);
    const frameOptions = displayFrame({ face, center });
    assert.deepEqual(frameOptions.mathematicalState, state(energy));
    const prepared = body.preparePlay('sit_listen', { totalSeconds: [10, 20], durationChoice: frameOptions.mathematicalState.effectiveEnergy });
    assert.equal(prepared.accepted, true, prepared.reason);
    assert.equal(prepared.options.speed, 1);
    assert.equal(prepared.totalSeconds, 10 + 10 * energy);
    durations.push(prepared.totalSeconds);
    const defaults = body.preparePlay('sit_listen', { durationChoice: energy });
    assert.equal(defaults.accepted, true, defaults.reason);
    assert.equal(defaults.options.targetDuration, undefined, 'math added an unrequested duration');
  }
  assert.deepEqual(durations, [11.5, 18.5]);
  // lastMath still records rejected input for diagnostics; scene must receive
  // the accepted authority that the face is actually using.
  assert.equal(center.message({ type: 'character_math', state: state(.01), mathRevision: 1 }), false);
  assert.equal(displayFrame({ face, center }).mathematicalState.effectiveEnergy, .85);
});

test('local component mathematical samples use the same frame route without a WAI event', () => {
  const face = new ContinuousFaceController({ morphCount: 1 });
  const center = new CharacterCenter({ face, body: {}, clock: () => 0 });
  assert.equal(center.lastMath, null);
  const sample = { ...state(.65), source: 'handwritten_component_fixture' };
  assert.equal(face.setMathematical(sample, 1), true);
  assert.deepEqual(displayFrame({ face, center, component: true }).mathematicalState, sample);
});

test('a visible 80 ms frame keeps source time instead of silently slowing to 50 ms', () => {
  const face = new ContinuousFaceController({ morphCount: 1 });
  const center = new CharacterCenter({ face, body: {}, clock: () => 0 });
  assert.equal(displayFrame({face,center,wall:80}).observedDt,.08);
  // An actual suspended tab still uses the existing controller safety cap.
  assert.equal(displayFrame({face,center,wall:5000}).observedDt,.1);
});
