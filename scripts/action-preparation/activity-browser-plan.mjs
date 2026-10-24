import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ACTIVITY_IDS, ACTIVITY_SEQUENCES } from '../../preview/core/activity-library.js';
import { fingerprintDependencies, verifyFingerprints } from './source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function buildActivityBrowserPlan(batchSize = 5) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw Error('Batch size must be between 1 and 10');
  const activities = [...ACTIVITY_IDS], sequences = Object.keys(ACTIVITY_SEQUENCES);
  const dependencies = fingerprintDependencies([
    'preview/core/full-body-controller.js', 'realtime/activities/director.mjs', 'realtime/activities/props.mjs',
    'realtime/activities/scene.mjs', 'realtime/activities/viewer.mjs', 'preview/studio/motion-rig.js',
    'preview/core/controller.js', 'preview/core/profile.js', 'scripts/action-preparation/browser-activity-execution.cjs',
    'scripts/action-preparation/activity-browser-plan.mjs', 'scripts/action-preparation/run-activity-browser.ps1', 'assets/Aemeath-inspection.json',
    'assets/Aemeath/鸣潮_爱弥斯1.05.pmx', 'preview/node_modules/three/package.json',
    'preview/node_modules/three/build/three.module.js', 'preview/node_modules/three/build/three.webgpu.js',
    'preview/node_modules/@takahirox/three-mmd/package.json',
    'preview/node_modules/@takahirox/three-mmd/dist/index.js',
  ], root);
  const batches = [];
  for (let i = 0; i < activities.length; i += batchSize) batches.push({ id: `activities-${String(batches.length + 1).padStart(3, '0')}`, activities: activities.slice(i, i + batchSize), sequences: [] });
  sequences.forEach((id, i) => batches.push({ id: `sequence-${String(i + 1).padStart(3, '0')}`, activities: [], sequences: [id] }));
  const plan = { schema: 'aemeath-browser-activity-plan/v1', generatedAt: new Date().toISOString(), activities, sequences, dependencies, batches };
  plan.planHash = digest({ activities, sequences, dependencies, batches }); return plan;
}

export function verifyActivityBrowserReports(plan, receipts, repositoryRoot = root) {
  if (plan.schema !== 'aemeath-browser-activity-plan/v1' || !plan.dependencies?.length || !Array.isArray(plan.batches)) throw Error('Invalid activity acceptance plan');
  verifyFingerprints(plan.dependencies, repositoryRoot);
  const completed = new Map(), activities = [], sequences = [];
  for (const receipt of receipts) {
    const batch = plan.batches.find(row => row.id === receipt.batchId), report = receipt.report;
    if (!batch || completed.has(batch.id) || receipt.planHash !== plan.planHash) throw Error('Unknown, repeated or stale activity batch');
    if (!report?.passed || report.errors?.length) throw Error(`Activity browser batch did not pass: ${batch.id}`);
    for (const key of ['activities', 'sequences']) {
      const actual = report[key]?.map(row => row.id);
      if (JSON.stringify(actual) !== JSON.stringify(batch[key]) || report[key].some(row => !row.passed)) throw Error(`Incomplete or failed ${key} in ${batch.id}`);
      for (const row of report[key]) {
        if (!row.accepted || !row.ended || row.errors?.length || !Number.isInteger(row.frames) || row.frames < 1
          || !Number.isInteger(row.renders) || row.renders < 1 || !(row.surfaceSamples > 0)
          || ![row.maximumGripError, row.maximumArmReach, row.maximumTransferJump, row.maximumPlacedDrift, row.maximumContactError, row.maximumContactReach].every(Number.isFinite)
          || row.maximumGripError > .025 || row.maximumArmReach > .995001 || row.maximumContactError > .025 || row.maximumContactReach > .995001
          || row.maximumTransferJump > .03 || row.maximumPlacedDrift > .001) throw Error(`Missing or invalid real-model evidence: ${row.id}`);
      }
    }
    completed.set(batch.id, report); activities.push(...report.activities); sequences.push(...report.sequences);
  }
  if (completed.size !== plan.batches.length) throw Error(`Activity browser coverage incomplete: ${completed.size}/${plan.batches.length} batches`);
  const unique = rows => new Set(rows.map(row => row.id)).size === rows.length;
  if (!unique(activities) || !unique(sequences) || activities.length !== plan.activities.length || sequences.length !== plan.sequences.length) throw Error('Activity browser coverage has omissions or duplicates');
  const all = [...activities, ...sequences];
  return { schema: 'aemeath-browser-activity-acceptance/v1', verifiedAt: new Date().toISOString(), planHash: plan.planHash,
    sourceStable: true, passed: true, activities, sequences,
    summary: { activities: activities.length, sequences: sequences.length, batches: completed.size,
      frames: all.reduce((n, row) => n + row.frames, 0), renders: all.reduce((n, row) => n + row.renders, 0),
      maximumGripError: Math.max(...all.map(row => row.maximumGripError)), maximumArmReach: Math.max(...all.map(row => row.maximumArmReach)),
      maximumContactError: Math.max(...all.map(row => row.maximumContactError)), maximumContactReach: Math.max(...all.map(row => row.maximumContactReach)),
      maximumTransferJump: Math.max(...all.map(row => row.maximumTransferJump)) },
    scope: 'Actual PMX, grants and props at 30 Hz; sampled skin and render submissions at 3.75 Hz. Coverage and fingerprints required. No claim of physics, collision or aesthetic acceptance.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directoryArg] = process.argv.slice(2), directory = path.resolve(directoryArg ?? path.join(root, 'outputs/action-execution-preparation-20261023/browser-activity-parts'));
  if (mode === 'plan') {
    const plan = buildActivityBrowserPlan(); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n'); console.log(JSON.stringify({ planHash: plan.planHash, batches: plan.batches.length, activities: plan.activities.length, sequences: plan.sequences.length }));
  } else if (mode === 'check') {
    const plan = JSON.parse((await readFile(path.join(directory, 'plan.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (plan.schema !== 'aemeath-browser-activity-plan/v1' || !plan.dependencies?.length) throw Error('Invalid frozen-source plan');
    verifyFingerprints(plan.dependencies, root); console.log(JSON.stringify({ sourceStable: true, planHash: plan.planHash }));
  } else if (mode === 'verify') {
    const plan = JSON.parse((await readFile(path.join(directory, 'plan.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const receipts = await Promise.all(plan.batches.map(async batch => JSON.parse((await readFile(path.join(directory, `${batch.id}.json`), 'utf8')).replace(/^\uFEFF/, ''))));
    const result = verifyActivityBrowserReports(plan, receipts);
    await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result.summary));
  } else throw Error('Use plan, check or verify, followed by the private output directory');
}
