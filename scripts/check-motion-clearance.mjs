// Offline mesh clearance check for the body-motion layer.
// Skins every PMX vertex (BDEF1/2/4 linear blend, including the model's twist, shoulder
// and eye grants) for sampled poses and reports arm/hand/sleeve vertices that end up
// behind the nearest body surface. A nearest-vertex/normal test is a heuristic: thin
// cloth layers can produce false positives, so counts are read against the bind pose.
//   node scripts/check-motion-clearance.mjs [--out <dir>] [--only <gesture>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MotionController } from '../preview/core/motion-controller.js';
import { GESTURE_IDS, GESTURES, POSTURES } from '../preview/core/motion-profile.js';
import { qconj, qid, qmul, qnormalize, qrotate, qslerp, add, sub } from '../preview/core/motion-math.js';

const root = new URL('../', import.meta.url);

export async function loadModel() {
  const { Parser } = await import(new URL('preview/node_modules/mmd-parser/build/mmdparser.module.mjs', root).href);
  const buffer = readFileSync(new URL('assets/Aemeath/鸣潮_爱弥斯1.05.pmx', root));
  const pmx = new Parser().parsePmx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), true);
  const bones = pmx.bones, count = bones.length;
  const skeleton = new Map(bones.map(b => [b.name, { position: b.position.slice(0, 3), parent: b.parentIndex >= 0 ? bones[b.parentIndex].name : null }]));
  const depth = i => { let d = 0; for (let p = bones[i].parentIndex; p >= 0; p = bones[p].parentIndex) d++; return d; };
  const order = [...bones.keys()].sort((a, b) => depth(a) - depth(b));
  const children = bones.map(() => []);
  bones.forEach((b, i) => { if (b.parentIndex >= 0) children[b.parentIndex].push(i); });
  const descend = start => { const out = new Set(); const stack = [start]; while (stack.length) { const i = stack.pop(); out.add(i); stack.push(...children[i]); } return out; };
  const index = name => bones.findIndex(b => b.name === name);
  const armSide = new Int8Array(count);
  for (const i of descend(index('左腕'))) armSide[i] = 1;
  for (const i of descend(index('右腕'))) armSide[i] = 2;
  const handBones = new Set([...descend(index('左手首')), ...descend(index('右手首'))]);
  const sleeveBones = new Set([...armSide.keys()].filter(i => armSide[i] && /袖/.test(bones[i].name)));
  const vertices = pmx.vertices, nv = vertices.length;
  const rest = new Float64Array(nv * 3), normals = new Float64Array(nv * 3), skinIndex = new Int32Array(nv * 4), skinWeight = new Float64Array(nv * 4), dominant = new Int32Array(nv);
  vertices.forEach((v, i) => {
    rest.set(v.position.slice(0, 3), i * 3); normals.set(v.normal.slice(0, 3), i * 3);
    const ix = v.skinIndices, w = v.skinWeights.slice();
    if (ix.length === 2 && w.length === 1) w.push(1 - w[0]);
    if (ix.length === 1) w[0] = 1;
    let best = 0;
    for (let k = 0; k < 4; k++) { skinIndex[i * 4 + k] = ix[k] ?? 0; skinWeight[i * 4 + k] = k < ix.length ? (w[k] ?? 0) : 0; if ((w[k] ?? 0) > (w[best] ?? 0)) best = k; }
    dominant[i] = ix[best];
  });
  return { pmx, bones, count, skeleton, order, index, armSide, handBones, sleeveBones, nv, rest, normals, skinIndex, skinWeight, dominant };
}

export function skin(model, locals) {
  const { bones, count, order, nv, rest, normals, skinIndex, skinWeight, dominant } = model;
  const local = bones.map(b => locals.get(b.name) ?? qid());
  bones.forEach((b, i) => {
    if (!b.grant || !b.grant.affectRotation) return;
    const source = local[b.grant.parentIndex], ratio = b.grant.ratio;
    const granted = ratio < 0 ? qslerp(qid(), qconj(source), -ratio) : qslerp(qid(), source, ratio);
    local[i] = qnormalize(qmul(local[i], granted));
  });
  const rot = new Array(count), pos = new Array(count);
  for (const i of order) {
    const p = bones[i].parentIndex;
    if (p < 0) { rot[i] = local[i]; pos[i] = bones[i].position.slice(0, 3); continue; }
    rot[i] = qmul(rot[p], local[i]);
    pos[i] = add(pos[p], qrotate(rot[p], sub(bones[i].position, bones[p].position)));
  }
  const out = new Float64Array(nv * 3), outN = new Float64Array(nv * 3), tmp = [0, 0, 0], v = [0, 0, 0];
  for (let i = 0; i < nv; i++) {
    let x = 0, y = 0, z = 0;
    v[0] = rest[i * 3]; v[1] = rest[i * 3 + 1]; v[2] = rest[i * 3 + 2];
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k]; if (!w) continue;
      const b = skinIndex[i * 4 + k];
      qrotate(rot[b], sub(v, bones[b].position, tmp), tmp);
      x += w * (tmp[0] + pos[b][0]); y += w * (tmp[1] + pos[b][1]); z += w * (tmp[2] + pos[b][2]);
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
    qrotate(rot[dominant[i]], [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]], tmp);
    outN.set(tmp, i * 3);
  }
  return { positions: out, normals: outN, bonePos: pos };
}

const CELL = .2;
export function check(model, skinned) {
  const { nv, armSide, dominant, handBones, sleeveBones, bones, index } = model;
  const { positions: P, normals: N, bonePos } = skinned;
  const grid = new Map(), cellKey = (a, b, c) => (a + 512) * 1048576 + (b + 512) * 1024 + (c + 512);
  for (let i = 0; i < nv; i++) {
    if (armSide[dominant[i]]) continue;
    const k = cellKey(Math.floor(P[i * 3] / CELL), Math.floor(P[i * 3 + 1] / CELL), Math.floor(P[i * 3 + 2] / CELL));
    let cell = grid.get(k); if (!cell) grid.set(k, cell = []); cell.push(i);
  }
  const shoulders = [null, bonePos[index('左腕')], bonePos[index('右腕')]];
  const parts = { hand: 0, sleeve: 0, arm: 0 };
  let penetrating = 0, maxDepth = 0, worst = null;
  const sideHands = [[], [], []];
  for (let i = 0; i < nv; i++) {
    const side = armSide[dominant[i]]; if (!side) continue;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], s = shoulders[side];
    const hand = handBones.has(dominant[i]);
    if (hand && i % 3 === 0) sideHands[side].push(i);
    // The armpit/shoulder seam deforms against the torso by construction; skip it.
    if (Math.hypot(x - s[0], y - s[1], z - s[2]) < .75) continue;
    let best = -1, bestD = .3 * .3;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cell = grid.get(cellKey(cx + a, cy + b, cz + c)); if (!cell) continue;
      for (const j of cell) {
        const dx = x - P[j * 3], dy = y - P[j * 3 + 1], dz = z - P[j * 3 + 2], d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    if (best < 0) continue;
    const depth = -((x - P[best * 3]) * N[best * 3] + (y - P[best * 3 + 1]) * N[best * 3 + 1] + (z - P[best * 3 + 2]) * N[best * 3 + 2]);
    if (depth > .03) {
      penetrating++;
      parts[hand ? 'hand' : sleeveBones.has(dominant[i]) ? 'sleeve' : 'arm']++;
      if (depth > maxDepth) { maxDepth = depth; worst = { bone: bones[dominant[i]].name, against: bones[dominant[best]].name, at: [x, y, z].map(v => +v.toFixed(2)) }; }
    }
  }
  let handGap = Infinity;
  for (const i of sideHands[1]) for (const j of sideHands[2]) {
    const d = Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
    if (d < handGap) handGap = d;
  }
  return { penetrating, ...parts, maxDepth: +maxDepth.toFixed(3), worst, handGap: +handGap.toFixed(3) };
}

export function settled(model, posture, setup) {
  const c = new MotionController({ skeleton: model.skeleton }); c.setOptions({ natural: false }); c.setPosture(posture, 0);
  setup?.(c);
  for (let t = 0; t < 1.6; t += 1 / 30) c.update(t, 1 / 30);
  return c;
}

export async function run({ only, out } = {}) {
  const model = await loadModel();
  const results = [];
  const record = (label, controller, extra = {}) => { const r = { label, ...check(model, skin(model, controller.locals)), ...extra }; results.push(r); return r; };
  results.push({ label: 'bind-pose', ...check(model, skin(model, new Map())) });
  for (const posture of Object.keys(POSTURES)) record(`posture:${posture}`, settled(model, posture));
  for (const gesture of GESTURE_IDS.filter(g => !only || g === only)) {
    for (const posture of ['speaking', 'relaxed', 'listening']) {
      const c = settled(model, posture), start = 1.6;
      c.trigger(gesture, `${gesture}-${posture}`, start);
      // Prepare/recover may be stretched by travel distance, so run until the gesture is gone.
      for (let i = 1; i < 30 * 8; i++) {
        const t = start + i / 30;
        c.update(t, 1 / 30);
        if (i % 3 === 0) record(`${gesture}/${posture}@${(t - start).toFixed(2)}`, c, { phase: c.snapshot().gestures[0]?.phase ?? 'done' });
        if (!c.snapshot().gestures.length) break;
      }
      for (const phase of ['prepare', 'stroke', 'hold']) {
        const def = GESTURES[gesture], mid = (def.phases[phase][0] + def.phases[phase][1]) / 2;
        const c2 = settled(model, posture);
        c2.trigger(gesture, `${gesture}-${posture}-${phase}`, start);
        // Interrupt at the phase middle on the gesture's own (authored) clock.
        let t = start; while (!(c2.snapshot().gestures[0]?.age >= mid) && t < start + 8) { t += 1 / 30; c2.update(t, 1 / 30); }
        c2.retract(t);
        const seconds = c2.snapshot().gestures[0]?.retractSeconds ?? def.recover;
        for (let i = 1; i / 30 < seconds + .3; i++) { const u = i / 30; c2.update(t + u, 1 / 30); if (i % 3 === 0) record(`${gesture}/${posture}/interrupt-${phase}+${u.toFixed(2)}`, c2); }
      }
    }
  }
  const base = results[0];
  const flagged = results.filter(r => r.hand > base.hand + 6 || r.arm > base.arm + 12 || r.sleeve > base.sleeve + 40 || r.maxDepth > .15);
  const summary = { measuredAt: new Date().toISOString(), samples: results.length, bindPose: base,
    thresholds: 'flag when hand > bind+6, arm > bind+12, sleeve > bind+40 vertices behind the nearest body surface, or depth > 0.15 model units',
    flagged: flagged.length, worst: [...results].sort((a, b) => (b.hand * 4 + b.arm * 2 + b.sleeve) - (a.hand * 4 + a.arm * 2 + a.sleeve)).slice(0, 8),
    minHandGap: Math.min(...results.map(r => r.handGap)),
    boundary: 'Offline LBS of the bind-pose PMX with physics off (sleeves and hair rigid); nearest-vertex normal test, not a watertight volume test.' };
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/motion-clearance.json`, JSON.stringify({ ...summary, results }, null, 1)); }
  return { summary, flagged, results };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const { summary, flagged } = await run({ only: option('--only'), out: option('--out') });
  console.log(JSON.stringify({ ...summary, flaggedLabels: flagged.slice(0, 60).map(r => `${r.label} hand=${r.hand} arm=${r.arm} sleeve=${r.sleeve} depth=${r.maxDepth} ${r.worst ? r.worst.bone + '->' + r.worst.against + '@' + r.worst.at : ''}`) }, null, 1));
}
