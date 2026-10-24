import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyActivityBrowserReports } from '../scripts/action-preparation/activity-browser-plan.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'activity-browser-evidence-')), file = path.join(root, 'proof.txt');
  writeFileSync(file, 'same frozen source'); t.after(() => { unlinkSync(file); rmdirSync(root); });
  const plan = { schema: 'aemeath-browser-activity-plan/v1', planHash: 'fixture-plan', activities: ['standing', 'wave'], sequences: ['read'],
    dependencies: [{ path: 'proof.txt', sha256: createHash('sha256').update('same frozen source').digest('hex') }],
    batches: [{ id: 'first', activities: ['standing', 'wave'], sequences: [] }, { id: 'second', activities: [], sequences: ['read'] }] };
  const row = id => ({ id, passed: true, accepted: true, ended: true, errors: [], frames: 120, renders: 15, surfaceSamples: 480,
    maximumGripError: .001, maximumArmReach: .8, maximumTransferJump: 0, maximumPlacedDrift: 0, maximumContactError: .001, maximumContactReach: .8 });
  const receipts = plan.batches.map(batch => ({ batchId: batch.id, planHash: plan.planHash,
    report: { passed: true, errors: [], activities: batch.activities.map(row), sequences: batch.sequences.map(row) } }));
  return { root, file, plan, receipts };
}

test('persisted browser batches require every intended activity and sequence exactly once', t => {
  const { root, plan, receipts } = fixture(t), passed = verifyActivityBrowserReports(plan, receipts, root);
  assert.equal(passed.sourceStable, true); assert.equal(passed.summary.activities, 2); assert.equal(passed.summary.sequences, 1);
  assert.throws(() => verifyActivityBrowserReports(plan, receipts.slice(0, 1), root), /incomplete/);
  assert.throws(() => verifyActivityBrowserReports(plan, [...receipts, receipts[0]], root), /repeated/);
  const missing = structuredClone(receipts); missing[0].report.activities.pop();
  assert.throws(() => verifyActivityBrowserReports(plan, missing, root), /Incomplete/);
});

test('a green label cannot replace actual ended, finite grip and rendered-surface evidence', t => {
  const { root, plan, receipts } = fixture(t);
  for (const change of [{ ended: false }, { frames: 0 }, { renders: 0 }, { surfaceSamples: 0 }, { maximumGripError: .04 }, { maximumArmReach: 1.1 }, { maximumContactError: .4 }, { maximumContactReach: 1.7 }, { maximumPlacedDrift: .1 }, { maximumTransferJump: .1 }, { maximumGripError: NaN }]) {
    const altered = structuredClone(receipts); Object.assign(altered[0].report.activities[0], change);
    assert.throws(() => verifyActivityBrowserReports(plan, altered, root), /invalid real-model evidence/);
  }
});

test('changed current source and stale part receipts cannot complete browser acceptance', t => {
  const { root, file, plan, receipts } = fixture(t), stale = structuredClone(receipts); stale[0].planHash = 'other-source';
  assert.throws(() => verifyActivityBrowserReports(plan, stale, root), /stale/);
  writeFileSync(file, 'changed while browser ran');
  assert.throws(() => verifyActivityBrowserReports(plan, receipts, root), /dependency changed/);
});
