// Actual controller playback plus dense held-recovery probes. Offline numerical
// evidence only: nearest vertex/normal signs do not prove triangle intersection.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadVariant, makeController, readPose, rotationDistance } from './compare-body-elbows.mjs';
import { skinCoordinated } from './check-coordinated-motion.mjs';
import { qconj, qrotate, sub } from '../preview/core/motion-math.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'outputs/crisp-wave-20261016/validation');
export const BASELINE = join(OUT, 'baseline-69ba756');
const MODULES = ['motion-controller.js', 'motion-skeleton.js', 'motion-profile.js', 'motion-math.js'];
export function captureBaseline() {
  mkdirSync(BASELINE, { recursive: true });
  for (const file of MODULES) writeFileSync(join(BASELINE, file), execFileSync('git', ['show', `69ba756:preview/core/${file}`], { cwd: ROOT }));
  writeFileSync(join(BASELINE, 'package.json'), '{"type":"module"}\n');
}
const hashes = directory => Object.fromEntries(MODULES.map(f => [f, createHash('sha256').update(readFileSync(join(directory, f))).digest('hex')]));
const absPeak = rows => Object.fromEntries(Object.keys(rows[0]).map(k => [k, Math.max(...rows.map(r => Math.abs(r[k])))]));

export function framePose(v, c) {
  const pose = readPose(v, c), fk = v.forwardKinematics(c.rig, c.locals), chest = pose.parts.upperChest;
  const swing = {};
  for (const side of ['L', 'R']) {
    const names = c.rig.sides[side].names;
    const direction = qrotate(qconj(chest.rotation), sub(fk.get(names.tips.middle).position, fk.get(names.wrist).position));
    swing[side] = Math.atan2(direction[0] * c.rig.sides[side].sign, direction[1]);
  }
  return { ...pose, swing, body: { ...c.bodyState }, bodyTarget: [...c.work.body] };
}

export function tracePlayback(v, id, { posture = 'relaxed', fps = 60, cancelPhase, meshCheck } = {}) {
  const c = makeController(v, posture), initial = framePose(v, c), frames = [];
  c.trigger(id, `validation-${id}`, 2);
  let cancelled = false, cancelledAt = null, completeAt = null;
  for (let i = 1; i <= fps * 12; i++) {
    const time = i / fps;
    c.update(2 + time, 1 / fps);
    let g = c.snapshot().gestures[0];
    if (cancelPhase && !cancelled && g?.phase === cancelPhase && g.age >= (v.GESTURES[id].phases[cancelPhase][0] + v.GESTURES[id].phases[cancelPhase][1]) / 2) {
      c.retract(2 + time); cancelled = true; cancelledAt = time; g = c.snapshot().gestures[0];
    }
    frames.push({ time, age: g?.age ?? null, phase: g?.phase ?? 'done', ...framePose(v, c), ...(meshCheck ? { mesh: meshCheck(c.locals) } : {}) });
    if (!g && completeAt === null) completeAt = time;
    if (completeAt !== null && time >= completeAt + .5) break;
  }
  const stroke = frames.filter(f => f.phase === 'stroke'), extrema = [];
  // Measured oscillation of the skinned skeleton's middle-finger direction in
  // chest coordinates, not the key count or configured duration alone.
  for (let i = 1; i < stroke.length - 1; i++) {
    const a = stroke[i - 1].swing.R, b = stroke[i].swing.R, d = stroke[i + 1].swing.R;
    if ((b - a) * (d - b) < 0 && Math.abs(b - a) + Math.abs(d - b) > 1e-5) extrema.push({ time: stroke[i].time, angle: b });
  }
  const periods = extrema.slice(2).map((e, i) => e.time - extrema[i].time);
  const expressive = frames.filter(f => ['stroke', 'hold'].includes(f.phase));
  const elbows = Object.fromEntries(['L', 'R'].map(side => [side, {
    maxLateral: Math.max(...expressive.map(f => f.elbows[side].lateral)),
    meanLateral: expressive.reduce((s, f) => s + f.elbows[side].lateral, 0) / expressive.length,
    maxAbductionDeg: Math.max(...expressive.map(f => f.elbows[side].abductionDeg)),
  }]));
  const bodyExcursion = frames.map(f => Object.fromEntries(Object.keys(f.body).map(k => [k, f.body[k] - initial.body[k]])));
  const fkPeak = Object.fromEntries(Object.keys(initial.parts).map(k => [k, {
    rotationDeg: Math.max(...frames.map(f => rotationDistance(f.parts[k].rotation, initial.parts[k].rotation) * 180 / Math.PI)),
    translation: Math.max(...frames.map(f => Math.hypot(...sub(f.parts[k].position, initial.parts[k].position)))),
  }]));
  return { id, posture, fps, cancelPhase: cancelPhase ?? null, cancelledAt, completeAt, frames,
    summary: { bodyPeak: absPeak(bodyExcursion), fkPeak, elbows, strokeDuration: stroke.length / fps,
      wristDirectionExtrema: extrema, frequencyHz: periods.length ? periods.length / periods.reduce((a, b) => a + b, 0) : null,
      halfCycleEquivalentHz: extrema.length >= 2 ? (extrema.length - 1) / (2 * (extrema.at(-1).time - extrema[0].time)) : null } };
}

// Retain every sleeve/hair vertex and its original skin weights. All bones and
// local transforms remain present, including any new sleeve-chain rotations.
export function sleeveHairModel(model) {
  const ids = [...model.dominant.keys()].filter(i => model.sleeveBones.has(model.dominant[i]) || /髪|辫|髮|发/.test(model.bones[model.dominant[i]].name));
  const reduced = { ...model, nv: ids.length, originalIndices: ids };
  for (const [key, stride] of [['rest', 3], ['normals', 3], ['skinIndex', 4], ['skinWeight', 4], ['dominant', 1]]) {
    reduced[key] = new model[key].constructor(ids.length * stride);
    ids.forEach((id, i) => reduced[key].set(model[key].subarray(id * stride, (id + 1) * stride), i * stride));
  }
  return reduced;
}
export function checkSleeveHair(model, skinned) {
  const { positions: p, normals: n } = skinned, grid = new Map(), cell = .3;
  const key = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < model.nv; i++) {
    if (model.sleeveBones.has(model.dominant[i])) continue;
    const k = key(...[0, 1, 2].map(j => Math.floor(p[i * 3 + j] / cell)));
    if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
  }
  let count = 0, maxDepth = 0, worst = null;
  for (let i = 0; i < model.nv; i++) {
    if (!model.sleeveBones.has(model.dominant[i])) continue;
    const pos = [0, 1, 2].map(j => p[i * 3 + j]), cells = pos.map(x => Math.floor(x / cell));
    let near = -1, distance2 = .3 ** 2;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      for (const h of grid.get(key(cells[0] + x, cells[1] + y, cells[2] + z)) ?? []) {
        const d = pos.reduce((s, v, j) => s + (v - p[h * 3 + j]) ** 2, 0);
        if (d < distance2) { distance2 = d; near = h; }
      }
    }
    if (near < 0) continue;
    const depth = -pos.reduce((s, v, j) => s + (v - p[near * 3 + j]) * n[near * 3 + j], 0);
    if (depth > .03) {
      count++;
      if (depth > maxDepth) { maxDepth = depth; worst = { sleeve: model.bones[model.dominant[i]].name, hair: model.bones[model.dominant[near]].name, vertex: model.originalIndices[i], hairVertex: model.originalIndices[near] }; }
    }
  }
  return { count, maxDepth, worst };
}
const meshSummary = frames => {
  const full = frames.filter(f => f.mesh.allBody);
  return { frames: frames.length, marked: frames.filter(f => f.mesh.count).length,
    maxCount: Math.max(...frames.map(f => f.mesh.count)), worst: frames.reduce((a, b) => a.mesh.maxDepth >= b.mesh.maxDepth ? a : b),
    allBody: { frames: full.length, marked: full.filter(f => f.mesh.allBody.penetrating).length,
      maxSleeve: Math.max(0, ...full.map(f => f.mesh.allBody.sleeve)),
      worst: full.length ? full.reduce((a, b) => a.mesh.allBody.maxDepth >= b.mesh.allBody.maxDepth ? a : b) : null },
  };
};

export function validateResume(receipt, { sourceHashes, fps, mesh }) {
  if (JSON.stringify(receipt.sourceHashes) !== JSON.stringify(sourceHashes)) throw new Error('Cannot resume a different core source revision');
  if (receipt.fps !== undefined && receipt.fps !== fps) throw new Error('Cannot resume a different FPS');
  if (receipt.mesh !== undefined && receipt.mesh !== mesh) throw new Error('Cannot resume a different mesh mode');
  if (!Array.isArray(receipt.actions)) throw new Error('Resume receipt has no actions');
  for (const action of receipt.actions) {
    if (action.fps !== fps || !Array.isArray(action.frames) || !action.frames.length) throw new Error('Resume action FPS or frames are invalid');
    if (action.frames.some(frame => !!frame.mesh !== mesh)) throw new Error('Resume frame mesh mode does not match this run');
    if (mesh) {
      if (action.frames.some(frame => !Number.isFinite(frame.mesh.count) || !Number.isFinite(frame.mesh.maxDepth))) throw new Error('Resume frame has incomplete sleeve-hair evidence');
      const full = action.frames.filter(frame => frame.mesh.allBody);
      if (full.length < Math.floor(action.frames.length / 6)) throw new Error('Resume all-body sample density is insufficient');
      if (full.some(frame => !Number.isFinite(frame.mesh.allBody.sleeve) || !Number.isFinite(frame.mesh.allBody.hand))) throw new Error('Resume frame has incomplete all-body evidence');
    }
  }
}

export async function run({ baselineOnly = false, currentOnly = false, mesh = false, postures = ['relaxed', 'speaking', 'listening'], fps = 60, outputDir = OUT, resumeFrom } = {}) {
  if (!existsSync(join(BASELINE, 'motion-controller.js'))) captureBaseline();
  mkdirSync(outputDir, { recursive: true });
  let meshCheck;
  if (mesh) {
    const { loadModel, check } = await import('./check-motion-clearance.mjs');
    const model = await loadModel(), reduced = sleeveHairModel(model);
    let index = 0;
    meshCheck = (locals, allBody = false) => ({ ...checkSleeveHair(reduced, skinCoordinated(reduced, locals)),
      ...(allBody || ++index % 6 === 0 ? { allBody: check(model, skinCoordinated(model, locals)) } : {}) });
  }
  const result = { boundary: 'Deterministic controller playback, physics disabled, every 60 FPS frame unless specified. Sleeve/hair nearest-vertex normal heuristic is not triangle collision or visual naturalness proof.', baselineRevision: '69ba756', variants: {} };
  for (const [name, directory] of [...(currentOnly ? [] : [['baseline', BASELINE]]), ...(baselineOnly ? [] : [['current', join(ROOT, 'preview/core')]])]) {
    const before = hashes(directory), v = await loadVariant(directory);
    const resumed = resumeFrom ? JSON.parse(readFileSync(resumeFrom, 'utf8')) : null;
    if (resumed) validateResume(resumed, { sourceHashes: before, fps, mesh });
    const actions = resumed ? resumed.actions.filter(a => postures.includes(a.posture)) : [];
    for (const posture of postures) for (const id of ['wave', 'greet']) for (const cancelPhase of [undefined, 'prepare', 'stroke', 'hold', 'recover']) {
      if (actions.some(a => a.posture === posture && a.id === id && a.cancelPhase === (cancelPhase ?? null))) continue;
      const trace = tracePlayback(v, id, { posture, fps, cancelPhase, meshCheck });
      actions.push({ ...trace, ...(mesh ? { meshSummary: meshSummary(trace.frames) } : {}) });
      const summary = actions.at(-1).meshSummary;
      writeFileSync(join(outputDir, `${name}-${mesh ? 'mesh' : 'kinematics'}-partial.json`), JSON.stringify({ sourceHashes: before, fps, mesh, complete: false, actions }, null, 2) + '\n');
      console.log(`${name} ${posture}/${id}/${cancelPhase ?? 'complete'} ${trace.frames.length} frames${summary ? ` hair=${summary.maxCount}/${summary.worst.mesh.maxDepth.toFixed(3)} allSleeve=${summary.allBody.maxSleeve} allDepth=${summary.allBody.worst?.mesh.allBody.maxDepth}` : ''}`);
    }
    const held = [];
    if (mesh) for (const id of ['wave', 'greet']) {
      const def = v.GESTURES[id], ages = new Set([.28, 2.3, 2.5]);
      for (let age = def.phases.hold[0]; age <= def.duration; age += .025) ages.add(+age.toFixed(4));
      for (const age of [...ages].sort((a, b) => a - b)) {
        if (age > def.duration) continue;
        const c = makeController(v); c.inspect(id, age);
        for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
        held.push({ id, age, mesh: meshCheck(c.locals, true) });
      }
    }
    const after = hashes(directory);
    result.variants[name] = { sourceHashes: before, sourceChangedDuringRun: MODULES.filter(f => before[f] !== after[f]), actions, held, ...(held.length ? { heldSummary: meshSummary(held) } : {}) };
    writeFileSync(join(outputDir, `${name}${mesh ? '-mesh' : '-kinematics'}.json`), JSON.stringify(result.variants[name], null, 2) + '\n');
    if (result.variants[name].sourceChangedDuringRun.length) throw new Error(`Source changed during ${name} measurement`);
  }
  writeFileSync(join(outputDir, mesh ? 'comparison-mesh.json' : 'comparison-kinematics.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--capture-baseline')) captureBaseline();
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  await run({ baselineOnly: process.argv.includes('--baseline-only'), currentOnly: process.argv.includes('--current-only'), mesh: process.argv.includes('--mesh'),
    ...(process.argv.includes('--relaxed-only') ? { postures: ['relaxed'] } : {}),
    ...(value('--posture') ? { postures: [value('--posture')] } : {}),
    ...(value('--output-dir') ? { outputDir: resolve(value('--output-dir')) } : {}), resumeFrom: value('--resume-from') });
}
