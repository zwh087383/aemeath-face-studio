import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthoredCatalog, numericEntries, parseArgs, renderNotes, scanActivity, scanGestureKeys, validateTimedDefinition } from '../scripts/action-preparation/prepare-authored.mjs';

const fixedPose = (id, time) => ({ id, time, phase: time < .5 ? 'prepare' : 'hold', support: 'standing',
  root: { position: [0, 0, 0], yaw: 0 }, pelvis: { offset: [0, 0, 0] }, body: { lean: time * .1 },
  hands: { L: { hand: [1, 2, 3] }, R: { hand: [-1, 2, 3] } },
  feet: { L: { position: [1, 0, 0], rotation: [0, 0, 0, 1], contact: true }, R: { position: [-1, 0, 0], rotation: [0, 0, 0, 1], contact: true } }, props: {}, face: {} });

test('definitions reject bad clocks, nonfinite poses and phase gaps instead of giving readiness', () => {
  const def = { duration: 1, tracks: ['body'], keys: { body: [[0, {}], [.2, { lean: NaN }], [.2, { lean: 0 }]] },
    phases: { prepare: [0, .1], stroke: [.2, .3], hold: [.3, .6], recover: [.6, 1] } };
  const errors = validateTimedDefinition(def, { keyed: true });
  assert.ok(errors.some(s => s.includes('非有限')));
  assert.ok(errors.some(s => s.includes('不递增')));
  assert.ok(errors.some(s => s.includes('间隙')));
  assert.ok(validateTimedDefinition({ duration: Infinity }).length);
});

test('activity preparation finds planted sliding from real sampled values, not contact labels', () => {
  const sampler = (id, time) => { const p = fixedPose(id, time); p.feet.L.position[0] += time; return p; };
  const measured = scanActivity({ id: 'sliding_fixture', duration: 1 }, sampler, 20);
  assert.equal(measured.samples, 21);
  assert.equal(measured.contacts.L.plantedSlipIntervals, 20);
  assert.ok(measured.contacts.L.maxPlantedStep >= .049999);
  assert.equal(measured.contacts.R.plantedSlipIntervals, 0);
  assert.ok(measured.actuallyVaryingNumericChannels.includes('body.lean'));
  assert.ok(measured.actuallyVaryingNumericChannels.includes('feet.L.position.0'));
});

test('activity preparation reports changing attachments and raw end-state mismatch honestly', () => {
  const sampler = (id, time) => {
    const p = fixedPose(id, Math.min(time, 1));
    p.props.book = { visible: true, attachment: time < .5 ? 'both' : 'table' };
    if (time > 1) p.root.position[0] = 10;
    return p;
  };
  const measured = scanActivity({ id: 'attachment_fixture', duration: 1 }, sampler, 20);
  assert.deepEqual(measured.props.book.attachments, ['both', 'table']);
  assert.deepEqual(measured.attachmentChanges, [{ id: 'book', seconds: .5, from: 'both', to: 'table' }]);
  assert.equal(measured.endpointHeldBeyondDuration, false);
  assert.equal(measured.observedPhaseWindows[1].firstSampleSeconds, .5);
});

test('nonfinite sampled output remains a named failure instead of disappearing in JSON null', () => {
  const measured = scanActivity({ id: 'bad_fixture', duration: 1 }, (id, time) => {
    const p = fixedPose(id, time); p.hands.R.hand[0] = time > .4 ? Infinity : 0; return p;
  }, 20);
  assert.ok(measured.numeric.nonFinite.length > 0);
  assert.equal(measured.numeric.nonFinite[0].key, 'hands.R.hand.0');
  assert.ok(Object.values(numericEntries({ a: [0, 1, Infinity] })).some(v => !Number.isFinite(v)));
});

test('gesture key evidence retains unreturned endpoint and marked stops; it does not fabricate home pose', () => {
  const d = { name: 'fixture', duration: 1, apex: .5, recover: .3, tracks: ['R'],
    keys: { R: [[0, { hand: [0, 0, 0] }], [.5, { hand: [2, 1, 0] }, 'stop'], [.8, { hand: [1, 1, 0] }]] },
    phases: { prepare: [0, .3], stroke: [.3, .5], hold: [.5, .7], recover: [.7, 1] } };
  const measured = scanGestureKeys(d);
  assert.deepEqual(measured.errors, []);
  assert.deepEqual(measured.tracks.R.stopTimes, [.5]);
  assert.deepEqual(measured.tracks.R.last, [.8, { hand: [1, 1, 0] }]);
  assert.equal(measured.tracks.R.ranges['hand.0'].travel, 2);
  assert.equal(measured.tracks.R.last[0], .8, 'raw last key is not the controller recovery endpoint');
});

test('CLI requires explicit paths and bounded numeric sampling frequency', () => {
  assert.equal(parseArgs(['--fps', '30']).fps, 30);
  assert.throws(() => parseArgs(['--fps', '0']), /fps/);
  assert.throws(() => parseArgs(['--fps', 'NaN']), /fps/);
  assert.throws(() => parseArgs(['--output']), /needs a path/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
  assert.throws(() => parseArgs(['--output', 'same', '--notes', 'same']), /different/);
});

test('actual current controllers prepare gestures, expressions, micro-actions, activities and sequence references without opening automatic use', async () => {
  const catalog = await buildAuthoredCatalog({ fps: 30, select: ['gesture:wave', 'expression:startled', 'micro:tiny_agree',
    'activity:jump_vertical', 'activity:read_seated', 'sequence:carry_delivery'] });
  assert.equal(catalog.schema, 'aemeath-preparation/v1');
  assert.deepEqual(catalog.summary.byKind, { gesture: 1, expression: 1, micro: 1, activity: 2, sequence: 1 });
  assert.equal(catalog.summary.total, 6);
  assert.deepEqual(catalog.summary.sourceProfileErrors, []);
  assert.deepEqual(catalog.summary.cancellationFailures, []);
  for (const item of catalog.items) {
    assert.equal(item.automaticEligible, false);
    assert.ok(item.blockers.length >= 2);
    assert.ok(item.evidence.length);
    for (const field of ['purpose', 'trigger', 'preconditions', 'prohibited', 'entry', 'exit', 'cancel']) assert.ok(item.usage[field], `${item.id}: ${field}`);
  }
  const gesture = catalog.items.find(i => i.kind === 'gesture');
  assert.equal(gesture.measurements.cancellationProbes.length, 4);
  assert.ok(gesture.measurements.cpuPose.maxWristSpeed > 0);
  assert.ok(gesture.measurements.cpuPose.numeric.ranges['body.twist'].travel > .01);
  assert.ok(gesture.measurements.cancellationProbes.every(p => p.cancelAccepted && !p.staleEpochAcceptedAfterCancel && p.remainingGestures === 0));
  const face = catalog.items.find(i => i.kind === 'expression');
  assert.ok(face.measurements.authoredMouthChannels.includes('o'));
  assert.equal(face.measurements.speechOwnershipProbe.protectedMouthMaximumDeviation, 0);
  assert.equal(face.measurements.speechOwnershipProbe.baseAfterCancel, 'neutral');
  const jump = catalog.items.find(i => i.runtimeId === 'jump_vertical');
  assert.ok(jump.measurements.airborneSamples > 0);
  assert.ok(jump.measurements.cancellationProbes.some(p => p.immediateStopMode === 'landing'));
  const read = catalog.items.find(i => i.runtimeId === 'read_seated');
  assert.ok(read.measurements.cancellationProbes.every(p => p.finalSupport === 'seated' && p.finalProps.includes('book')));
  const recipe = catalog.items.find(i => i.kind === 'sequence');
  assert.equal(recipe.measurements.segments.length, 2);
  assert.ok(recipe.measurements.boundaryRequirements[0].rawRootGapModelUnits >= 0);
  assert.match(renderNotes(catalog), /自动开放数仍为 0/);
  assert.match(renderNotes(catalog), /没有在 three-mmd grants 后/);
});
