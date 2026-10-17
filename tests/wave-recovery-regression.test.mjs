import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVariant, makeController } from '../scripts/compare-body-elbows.mjs';
import { tracePlayback, sleeveHairModel, checkSleeveHair, validateResume } from '../scripts/check-wave-clearance.mjs';
import { skinCoordinated } from '../scripts/check-coordinated-motion.mjs';

const variant = await loadVariant();
// Accepted 69ba756 measured at 60 FPS from relaxed posture, natural idle off.
// These are actual FK excursions, not authoring-key magnitudes.
const accepted = {
  wave: { chest: 9.817947167315722, headTravel: .4365944830803552, waistTravel: .18093307800709052, duration: 3.9833333333333334, elbow: [1.2102237346000002, 2.372240937858342] },
  greet: { chest: 11.10472413794628, headTravel: .7784292842364938, waistTravel: .24449683210301748, duration: 3.6333333333333333, elbow: [1.1972547172114558, 2.2858151163841036] },
};

test('resuming evidence rejects a different FPS, missing mesh frames, or sparse full-body checks', () => {
  const expected = { sourceHashes: { controller: 'same-source' }, fps: 60, mesh: true };
  const receipt = { sourceHashes: expected.sourceHashes, actions: [{ fps: 60,
    frames: Array.from({ length: 12 }, (_, i) => ({ mesh: { count: 0, maxDepth: 0,
      ...(i % 6 === 5 ? { allBody: { sleeve: 0, hand: 0 } } : {}) } })) }] };
  assert.doesNotThrow(() => validateResume(receipt, expected));
  const wrongFps = structuredClone(receipt); wrongFps.actions[0].fps = 30;
  assert.throws(() => validateResume(wrongFps, expected), /FPS/);
  const missing = structuredClone(receipt); delete missing.actions[0].frames[0].mesh;
  assert.throws(() => validateResume(missing, expected), /mesh mode/);
  const sparse = structuredClone(receipt); delete sparse.actions[0].frames[5].mesh.allBody;
  assert.throws(() => validateResume(sparse, expected), /density/);
});

test('quicker wave and greet retain accepted torso/head/support excursion and bring elbows inward', () => {
  for (const id of ['wave', 'greet']) {
    const trace = tracePlayback(variant, id), before = accepted[id], after = trace.summary;
    for (const [name, measured, original] of [
      ['chest rotation', after.fkPeak.upperChest.rotationDeg, before.chest],
      ['head travel', after.fkPeak.head.translation, before.headTravel],
      ['waist travel', after.fkPeak.waist.translation, before.waistTravel],
    ]) {
      assert.ok(measured >= original * .97, `${id}: ${name} ${measured} fell below 97% of accepted ${original}`);
      assert.ok(measured <= original * 1.05, `${id}: ${name} ${measured} changed beyond the requested retained amplitude`);
    }
    assert.ok(trace.completeAt < before.duration * .95, `${id}: actual playback is not faster`);
    for (const [i, side] of ['L', 'R'].entries()) assert.ok(after.elbows[side].maxLateral < before.elbow[i] - .02, `${id}/${side}: expressive elbow did not move inward`);
  }
});

test('ordinary return and cancellation during every phase finish with a continuous settled pose', () => {
  for (const posture of ['relaxed', 'speaking', 'listening']) for (const id of ['wave', 'greet']) {
    for (const cancelPhase of [undefined, 'prepare', 'stroke', 'hold', 'recover']) {
      const trace = tracePlayback(variant, id, { posture, cancelPhase });
      const label = `${posture}/${id}/${cancelPhase ?? 'complete'}`;
      assert.ok(trace.completeAt > 0 && trace.completeAt < 7, `${label}: incomplete recovery`);
      if (cancelPhase) assert.ok(trace.cancelledAt > 0, `${label}: cancellation never exercised`);
      assert.equal(trace.frames.at(-1).phase, 'done', label);
      for (let i = 1; i < trace.frames.length; i++) {
        for (const side of ['L', 'R']) {
          const a = trace.frames[i - 1].wrists[side], b = trace.frames[i].wrists[side];
          const speed = Math.hypot(...a.map((v, j) => b[j] - v)) * trace.fps;
          assert.ok(Number.isFinite(speed) && speed < 26, `${label}/${side}: discontinuous wrist ${speed}`);
        }
      }
    }
  }
});

test('dense held wave/greet recovery has no sleeve-hair normal-depth signal above .03 model units', async () => {
  const { loadModel } = await import('../scripts/check-motion-clearance.mjs');
  const model = sleeveHairModel(await loadModel());
  for (const id of ['wave', 'greet']) {
    const def = variant.GESTURES[id], ages = new Set([.28]);
    for (let age = def.phases.hold[0]; age <= def.duration; age += .05) ages.add(+age.toFixed(4));
    for (const age of ages) {
      const c = makeController(variant); c.inspect(id, age);
      for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
      const result = checkSleeveHair(model, skinCoordinated(model, c.locals));
      assert.equal(result.count, 0, `${id} held age=${age}: ${JSON.stringify(result)}`);
    }
  }
});
