// Offline, model-specific clearance evidence for the expanded vocabulary.
// This samples rigid PMX skinning and nearest-surface normals; it is deliberately
// not a continuous collision detector, cloth solver or all-view visual guarantee.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { GESTURES, GESTURE_IDS, EXPANDED_GESTURE_IDS } from '../preview/core/motion-profile.js';
import { makeMotion, skinCoordinated } from './check-coordinated-motion.mjs';
import { loadModel, check } from './check-motion-clearance.mjs';

export async function expandedClearance({ out, onlyIds } = {}) {
  const paths = ['preview/core/expanded-motion-library.js', 'preview/core/motion-profile.js', 'preview/core/motion-controller.js', 'preview/core/motion-skeleton.js', 'scripts/check-expanded-motion.mjs'];
  const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')]));
  const before = hashes(), model = await loadModel(), samples = [];
  const sample = (c, gesture, phase, time) => {
    const result = check(model, skinCoordinated(model, c.locals));
    samples.push({ gesture, phase, time: +time.toFixed(3), ...result });
  };
  const neutral = makeMotion(); sample(neutral, 'relaxed', 'baseline', 0);
  for (const id of onlyIds ? [] : GESTURE_IDS.filter(id => !EXPANDED_GESTURE_IDS.includes(id))) {
    const c = makeMotion(); c.inspect(id, GESTURES[id].apex);
    for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
    sample(c, id, 'original-apex-baseline', GESTURES[id].apex);
  }
  // Every new action gets a solved apex sample. Full paths below supplement the
  // maximal extension, bend, twist and narrowest dual-hand examples.
  const selected = onlyIds ?? EXPANDED_GESTURE_IDS;
  for (const id of selected) {
    const c = makeMotion(); c.inspect(id, GESTURES[id].apex);
    for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
    sample(c, id, 'apex-held', GESTURES[id].apex);
  }
  const pathsToCheck = ['finger_release', 'grateful', 'present_left', 'warm_welcome', 'explain_sequence', 'celebration_compact', 'storytelling_arc', 'reset_and_resolve', 'farewell_linger'].filter(id => !onlyIds || onlyIds.includes(id));
  for (const id of pathsToCheck) {
    const c = makeMotion(); c.trigger(id, `mesh-${id}`, 2);
    const maximum = 2 + GESTURES[id].duration * 2 + 2;
    for (let frame = 1; 2 + frame / 30 <= maximum; frame++) {
      const time = frame / 30; c.update(2 + time, 1 / 30);
      if (frame % 15 === 0) sample(c, id, c.snapshot().gestures[0]?.phase ?? 'settled', time);
      if (!c.snapshot().gestures.length && time > 1) break;
    }
    const interrupted = makeMotion(); interrupted.trigger(id, `mesh-cancel-${id}`, 2);
    let now = 2;
    while ((interrupted.snapshot().gestures[0]?.age ?? -1) < GESTURES[id].apex) { now += 1 / 30; interrupted.update(now, 1 / 30); }
    interrupted.retract(now);
    for (let i = 1; i <= 45; i++) {
      interrupted.update(now + i / 30, 1 / 30);
      if (i % 6 === 0) sample(interrupted, id, 'interrupted-recovery', now - 2 + i / 30);
    }
  }
  const after = hashes();
  const result = {
    method: 'Rigid PMX skinning including grants and pelvis translations; nearest vertex-normal surface heuristic; physics disabled',
    limitations: 'Apex and 0.5 s dynamic samples, plus 0.2 s interrupted recovery; may miss between-sample collisions; thin cloth layers may produce false positives; no physical contact/cloth simulation claim',
    sourceHashes: before, sourceChangedDuringRun: paths.filter(path => before[path] !== after[path]),
    sampledActions: selected.length, selectedActions: selected, sampledPaths: pathsToCheck,
    summary: {
      poses: samples.length, handPenetrationPoses: samples.filter(s => s.hand > 0).length,
      sleevePenetrationPoses: samples.filter(s => s.sleeve > 0).length,
      worstDepth: Math.max(...samples.map(s => s.maxDepth)), minHandGap: Math.min(...samples.map(s => s.handGap)),
    }, samples,
  };
  if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`); }
  if (result.sourceChangedDuringRun.length) throw new Error(`Motion source changed: ${result.sourceChangedDuringRun.join(', ')}`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--out'), selectedIndex = process.argv.indexOf('--only');
  const onlyIds = selectedIndex < 0 ? undefined : process.argv[selectedIndex + 1].split(',');
  if (onlyIds?.some(id => !EXPANDED_GESTURE_IDS.includes(id))) throw new Error('Unknown expanded gesture ID');
  const result = await expandedClearance({ out: index < 0 ? undefined : process.argv[index + 1], onlyIds });
  console.log(JSON.stringify({ ...result.summary, flags: result.samples.filter(s => s.penetrating > 0), sourceChangedDuringRun: result.sourceChangedDuringRun }, null, 2));
}
