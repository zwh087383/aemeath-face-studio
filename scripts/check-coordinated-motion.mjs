// Independent numerical evidence for coordinated motion. FK and mesh heuristics
// are diagnostic evidence; they do not certify all-view cloth/hair clearance.
// node scripts/check-coordinated-motion.mjs [--mesh] [--out path.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { MotionController } from '../preview/core/motion-controller.js';
import { GESTURES, GESTURE_IDS } from '../preview/core/motion-profile.js';
import { forwardKinematics, skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { qrotate, qid, qconj, qmul, qnormalize, qslerp, add, sub } from '../preview/core/motion-math.js';

export const inspection = JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8'));
export const skeleton = skeletonFromInspection(inspection);
export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export const rotationDistance = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0))));
export const angles = q => {
  const f = qrotate(q, [0, 0, 1]);
  return { pitch: Math.atan2(-f[1], Math.hypot(f[0], f[2])), yaw: Math.atan2(f[0], f[2]) };
};
export function makeMotion(posture = 'relaxed', options = {}) {
  const c = new MotionController({ skeleton });
  c.setOptions({ natural: false, ...options }); c.setPosture(posture, 0);
  for (let i = 1; i <= 120; i++) c.update(i / 60, 1 / 60);
  return c;
}
export function poseSample(c) {
  const fk = forwardKinematics(c.rig, c.locals);
  const parts = Object.fromEntries(Object.entries(c.rig.torso).map(([key, bone]) => {
    const pose = fk.get(bone.name);
    return [key, { position: [...pose.position], rotation: [...pose.rotation], ...angles(pose.rotation) }];
  }));
  const hands = Object.fromEntries(['L', 'R'].map(side => {
    const n = c.rig.sides[side].names;
    return [side, [n.wrist, ...Object.values(n.tips)].map(name => [...fk.get(name).position])];
  }));
  return { parts, hands, eyes: { pitch: c.head.eyesPitch, yaw: c.head.eyesYaw }, body: [...c.work.body] };
}
export function sampleGesture(id, { fps = 60, posture = 'relaxed', speed = 1, stopAt, replaceWith } = {}) {
  const c = makeMotion(posture, { speed }), baseline = poseSample(c), frames = [];
  if (!c.trigger(id, `independent-${id}`, 2)) throw new Error(`Unable to trigger ${id}`);
  let stopped = false;
  // Covers preparation/recovery stretching and a full second of spring settling.
  const end = 2 + GESTURES[id].duration * 3 / speed + 2;
  for (let i = 1; 2 + i / fps <= end; i++) {
    const now = 2 + i / fps;
    c.update(now, 1 / fps);
    if (!stopped && stopAt !== undefined && now >= 2 + stopAt) {
      stopped = true;
      if (replaceWith) c.trigger(replaceWith, `replace-${id}-${replaceWith}`, now);
      else c.retract(now);
    }
    frames.push({ time: now - 2, ...poseSample(c) });
  }
  return { c, baseline, frames };
}
export function summarize(trace, fps = 60) {
  const { baseline, frames } = trace;
  const ranges = {}, rotationSpeed = {};
  for (const key of Object.keys(baseline.parts)) {
    ranges[key] = { rotation: 0, pitchMin: 0, pitchMax: 0, translation: 0 };
    rotationSpeed[key] = 0;
  }
  let prev = baseline, wristSpeed = 0, tipSpeed = 0;
  for (const frame of frames) {
    for (const key of Object.keys(ranges)) {
      const p = frame.parts[key], b = baseline.parts[key], r = ranges[key];
      r.rotation = Math.max(r.rotation, rotationDistance(p.rotation, b.rotation));
      r.pitchMin = Math.min(r.pitchMin, p.pitch - b.pitch);
      r.pitchMax = Math.max(r.pitchMax, p.pitch - b.pitch);
      r.translation = Math.max(r.translation, distance(p.position, b.position));
      rotationSpeed[key] = Math.max(rotationSpeed[key], rotationDistance(p.rotation, prev.parts[key].rotation) * fps);
    }
    for (const side of ['L', 'R']) frame.hands[side].forEach((p, i) => {
      const velocity = distance(p, prev.hands[side][i]) * fps;
      if (i === 0) wristSpeed = Math.max(wristSpeed, velocity);
      else tipSpeed = Math.max(tipSpeed, velocity);
    });
    prev = frame;
  }
  return { ranges, rotationSpeed, wristSpeed, tipSpeed,
    eyesPitchRange: Math.max(...frames.map(f => f.eyes.pitch)) - Math.min(...frames.map(f => f.eyes.pitch)),
    remaining: trace.c.snapshot().gestures.length };
}

// Includes the new pelvis local translations. The older clearance helper is
// rotation-only; using it unchanged would silently omit the support shift.
export function skinCoordinated(model, locals) {
  const { bones, order, nv, rest, normals, skinIndex, skinWeight, dominant } = model;
  const local = bones.map(b => locals.get(b.name) ?? qid());
  bones.forEach((b, i) => {
    if (!b.grant?.affectRotation) return;
    const source = local[b.grant.parentIndex], ratio = b.grant.ratio;
    const granted = ratio < 0 ? qslerp(qid(), qconj(source), -ratio) : qslerp(qid(), source, ratio);
    local[i] = qnormalize(qmul(local[i], granted));
  });
  const rot = [], pos = [];
  for (const i of order) {
    const parent = bones[i].parentIndex, delta = locals.translations?.get(bones[i].name) ?? [0, 0, 0];
    if (parent < 0) { rot[i] = local[i]; pos[i] = add(bones[i].position, delta); continue; }
    rot[i] = qmul(rot[parent], local[i]);
    pos[i] = add(pos[parent], qrotate(rot[parent], add(sub(bones[i].position, bones[parent].position), delta)));
  }
  const positions = new Float64Array(nv * 3), outNormals = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const v = Array.from(rest.subarray(i * 3, i * 3 + 3));
    for (let k = 0; k < 4; k++) {
      const weight = skinWeight[i * 4 + k]; if (!weight) continue;
      const bone = skinIndex[i * 4 + k], p = add(pos[bone], qrotate(rot[bone], sub(v, bones[bone].position)));
      for (let j = 0; j < 3; j++) positions[i * 3 + j] += weight * p[j];
    }
    outNormals.set(qrotate(rot[dominant[i]], Array.from(normals.subarray(i * 3, i * 3 + 3))), i * 3);
  }
  return { positions, normals: outNormals, bonePos: pos };
}

export async function run({ mesh = false, out } = {}) {
  const sources = ['preview/core/motion-controller.js', 'preview/core/motion-skeleton.js', 'preview/core/motion-math.js', 'preview/core/motion-profile.js', 'preview/core/expression-choreography.js', 'scripts/check-coordinated-motion.mjs'];
  const hashes = () => Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')]));
  const sourceHashes = hashes();
  const result = { evidence: 'Deterministic PMX-skeleton FK; no audio/cloud/visual-quality claim', units: 'radians, model units, seconds', sourceHashes, actions: {} };
  for (const id of GESTURE_IDS) result.actions[id] = summarize(sampleGesture(id));
  if (mesh) {
    const { loadModel, check } = await import('./check-motion-clearance.mjs');
    const model = await loadModel();
    result.mesh = { method: 'nearest vertex/normal heuristic, rigid skinning with local translations, physics disabled', bind: check(model, skinCoordinated(model, new Map())), poses: [] };
    for (const id of GESTURE_IDS) {
      for (const age of [...new Set([GESTURES[id].apex, ...Object.values(GESTURES[id].phases).map(v => (v[0] + v[1]) / 2)])]) {
        const c = makeMotion(); c.inspect(id, age);
        for (let i = 1; i <= 120; i++) c.update(2 + i / 60, 1 / 60);
        result.mesh.poses.push({ gesture: id, age, ...check(model, skinCoordinated(model, c.locals)) });
      }
    }
  }
  const after = hashes();
  result.sourceChangedDuringRun = sources.filter(path => sourceHashes[path] !== after[path]);
  if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); }
  if (result.sourceChangedDuringRun.length) throw new Error(`Source changed during evidence run: ${result.sourceChangedDuringRun.join(', ')}`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outIndex = process.argv.indexOf('--out');
  const result = await run({ mesh: process.argv.includes('--mesh'), out: outIndex < 0 ? undefined : process.argv[outIndex + 1] });
  console.log(JSON.stringify(result, null, 2));
}
