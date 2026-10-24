import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import { Parser } from '../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs';
import { NativeClip, NativeRetarget } from '../../preview/core/native-motion.js';
import { nativeHairSource } from '../../preview/core/native-hair-binding.js';

// Offline acceptance uses the untouched PMX hierarchy AND positive skin weights.
// No synthetic skeleton, renderer, cloud request or source asset mutation is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDir = path.join(root, 'outputs/native-complete-20261022');
const outputDir = path.join(root, 'outputs/action-preparation-20261023/target-validation');
const pmxPath = path.join(root, 'assets/Aemeath/鸣潮_爱弥斯1.05.pmx');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const start = performance.now(), bytes = fs.readFileSync(pmxPath);
const pmx = new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
let entries = manifest.clips.filter(row => row.status === 'ready' && row.resourceKind === 'body');
const limitAt = process.argv.indexOf('--limit');
if (limitAt >= 0) entries = entries.slice(0, Number(process.argv[limitAt + 1]));
const onlyAt = process.argv.indexOf('--id');
if (onlyAt >= 0) entries = entries.filter(row => row.id === process.argv[onlyAt + 1]);
fs.mkdirSync(outputDir, { recursive: true });

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(pmx.vertices.flatMap(v => v.position), 3));
geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(pmx.vertices.flatMap(v => Array.from({ length: 4 }, (_, k) => v.skinIndices[k] ?? 0)), 4));
geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(pmx.vertices.flatMap(v => Array.from({ length: 4 }, (_, k) => v.skinWeights[k] ?? 0)), 4));
const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
const bones = pmx.bones.map(source => {
  const bone = new THREE.Bone(); bone.name = source.name; bone.position.fromArray(source.position); return bone;
});
for (let i = 0; i < bones.length; i++) {
  const parent = pmx.bones[i].parentIndex;
  if (parent >= 0) { bones[i].position.sub(new THREE.Vector3(...pmx.bones[parent].position)); bones[parent].add(bones[i]); }
  else mesh.add(bones[i]);
}
mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
const bind = bones.map(bone => ({ bone, p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() }));
const reset = () => { for (const r of bind) { r.bone.position.copy(r.p); r.bone.quaternion.copy(r.q); r.bone.scale.copy(r.s); } mesh.updateMatrixWorld(true); mesh.skeleton.update(); };

function partOf(index) {
  for (let i = index; i >= 0; i = pmx.bones[i].parentIndex) {
    const name = bones[i].name;
    if (nativeHairSource(name) || /髪|发|辫|Bone_Hair/.test(name)) return 'hair';
    if (/^(?:スカート_|[左右]侧裙_|[左右]裙[A-D])/.test(name)) return 'skirt';
    if (/^左(?:肩|腕|ひじ|手|親指|人指|中指|薬指|小指)/.test(name)) return 'left-arm-hand';
    if (/^右(?:肩|腕|ひじ|手|親指|人指|中指|薬指|小指)/.test(name)) return 'right-arm-hand';
    if (/^左(?:足|ひざ|つま先)/.test(name)) return 'left-leg-foot';
    if (/^右(?:足|ひざ|つま先)/.test(name)) return 'right-leg-foot';
    if (/^(?:頭|首|[左右]目)/.test(name)) return 'head-neck';
    if (/^(?:腰|下半身|上半身)/.test(name)) return 'torso';
  }
  return 'other';
}
const vertexParts = new Map();
for (let i = 0; i < pmx.vertices.length; i++) {
  const vertex = pmx.vertices[i]; let largest = -Infinity, dominant = -1;
  vertex.skinWeights.forEach((weight, k) => { if (weight > largest && weight > 1e-7) { largest = weight; dominant = vertex.skinIndices[k]; } });
  const part = dominant >= 0 ? partOf(dominant) : 'other';
  if (!vertexParts.has(part)) vertexParts.set(part, []);
  vertexParts.get(part).push(i);
}
const sampleBudget = 192;
const partSamples = new Map([...vertexParts].map(([part, vertices]) => [part,
  Array.from({ length: Math.min(sampleBudget, vertices.length) }, (_, k) => vertices[Math.floor(k * vertices.length / Math.min(sampleBudget, vertices.length))]) ]));
const allSampledVertices = [...new Set([...partSamples.values()].flat())];
const sampleFrames = frameCount => new Set(Array.from({ length: Math.min(31, frameCount) }, (_, k) => Math.round(k * (frameCount - 1) / (Math.min(31, frameCount) - 1 || 1))));
const vector = new THREE.Vector3(), quaternion = new THREE.Quaternion();
const bonesByPart = new Map(bones.map((_, i) => [i, partOf(i)]));
const summary = { schema: 1, startedAt: new Date().toISOString(),
  evidence: 'Raw PMX 1.05 hierarchy + real four-weight CPU skinning, existing NativeClip/NativeRetarget. MMD grant/IK/physics disabled as in isolated native viewer.',
  model: { file: path.relative(root, pmxPath), sha256: hash(bytes), bones: bones.length, vertices: pmx.vertices.length },
  coverage: { requestedClips: entries.length, poseSampling: 'Every decoded source frame including both endpoints', surfaceSampling: 'Up to 31 uniformly spaced source frames per clip; up to 192 vertices per dominant-influence body part',
    dominantInfluenceRule: 'Largest positive original PMX skin weight; first explicit anatomical ancestor. Categories describe sampling coverage, not semantic or collision masks.',
    parts: Object.fromEntries([...vertexParts].map(([part, rows]) => [part, { originalVertices: rows.length, sampledVertices: partSamples.get(part).length }])),
    totalUniqueSampledVertices: allSampledVertices.length },
  tolerances: { finite: 'All elements must be finite', localPositionLength: 1e-7, unitQuaternionError: 1e-7, movingBoneRadians: 1e-5 },
  exclusions: ['Naturalness, arbitrary interruption and cross-clip entry/exit are NOT tested.',
    'CPU skinning is actual target deformation but NOT a GPU shader/material/visibility test.',
    'Native ribbon companions and restored native skirt weights are NOT included in this raw-PMX pass; their combined surface requires browser acceptance.',
    'Finite values and movement do NOT prove contact, no foot sliding, no self-intersection or physical balance.',
    'Surface sampling is not exhaustive over every vertex or every frame. Morphs are not evaluated.'],
  clips: [], failures: [] };
const destination = path.join(outputDir, limitAt >= 0 || onlyAt >= 0 ? 'cpu-target-smoke.json' : 'cpu-target-all-body.json');
const save = () => fs.writeFileSync(destination, JSON.stringify(summary, null, 2) + '\n');

for (const entry of entries) {
  const clipStarted = performance.now();
  try {
    const packed = fs.readFileSync(path.join(sourceDir, entry.file));
    const decoded = gunzipSync(packed), data = JSON.parse(decoded.toString('utf8'));
    const clip = new NativeClip(data); reset(); const retarget = new NativeRetarget(clip, mesh);
    const surfaces = Object.fromEntries([...partSamples].map(([part, vertices]) => [part, { sampledVertices: vertices.length,
      maxWorldDisplacement: 0, maxPelvisRelativeDisplacement: 0, nonfiniteVertices: 0 }]));
    const firstSurface = new Map(), frames = sampleFrames(data.frameCount), firstTargetQ = [], firstSourceQ = [];
    const sourceRotations = retarget.mapping.map(() => 0), targetRotations = retarget.mapping.map(() => 0);
    let nonfiniteMatrices = 0, nonfiniteLocals = 0, maxLengthError = 0, maxUnitQuaternionError = 0, poses = 0, sampledSurfaceFrames = 0;
    for (let j = 0; j < data.frameCount; j++) {
      const time = data.frameCount === 1 ? 0 : data.duration * j / (data.frameCount - 1);
      clip.sample(time); retarget.apply(); poses++;
      for (let k = 0; k < bones.length; k++) {
        const bone = bones[k], original = bind[k];
        if (!bone.matrixWorld.elements.every(Number.isFinite)) nonfiniteMatrices++;
        if (![...bone.position, ...bone.quaternion, ...bone.scale].every(Number.isFinite)) nonfiniteLocals++;
        if (bone.name !== '腰') maxLengthError = Math.max(maxLengthError, Math.abs(bone.position.length() - original.p.length()));
        maxUnitQuaternionError = Math.max(maxUnitQuaternionError, Math.abs(1 - bone.quaternion.length()));
      }
      retarget.mapping.forEach((row, k) => {
        row.bone.getWorldQuaternion(quaternion);
        if (j === 0) { firstTargetQ[k] = quaternion.clone(); firstSourceQ[k] = clip.world[row.source].q.clone(); }
        sourceRotations[k] = Math.max(sourceRotations[k], firstSourceQ[k].angleTo(clip.world[row.source].q));
        targetRotations[k] = Math.max(targetRotations[k], firstTargetQ[k].angleTo(quaternion));
      });
      if (!frames.has(j)) continue;
      sampledSurfaceFrames++;
      const pelvis = retarget.bones.get('腰'), pelvisP = pelvis.getWorldPosition(new THREE.Vector3()), pelvisInv = pelvis.getWorldQuaternion(new THREE.Quaternion()).invert();
      for (const [part, indices] of partSamples) for (const index of indices) {
        mesh.applyBoneTransform(index, vector.fromArray(pmx.vertices[index].position));
        if (![...vector].every(Number.isFinite)) { surfaces[part].nonfiniteVertices++; continue; }
        const world = vector.clone(), relative = vector.sub(pelvisP).applyQuaternion(pelvisInv);
        if (j === 0) firstSurface.set(index, { world, relative: relative.clone() });
        else {
          const first = firstSurface.get(index);
          surfaces[part].maxWorldDisplacement = Math.max(surfaces[part].maxWorldDisplacement, first.world.distanceTo(world));
          surfaces[part].maxPelvisRelativeDisplacement = Math.max(surfaces[part].maxPelvisRelativeDisplacement, first.relative.distanceTo(relative));
        }
      }
    }
    const parts = {};
    for (const [part] of partSamples) {
      const mapping = retarget.mapping.map((r, i) => ({ r, i })).filter(({ r }) => bonesByPart.get(bones.indexOf(r.bone)) === part);
      const lostMovingBones = mapping.filter(({ i }) => sourceRotations[i] > 1e-5 && targetRotations[i] < 1e-5)
        .map(({ r, i }) => ({ targetBone: r.bone.name, sourceBone: data.bones[r.source].name, sourceRadians: sourceRotations[i], targetRadians: targetRotations[i] }));
      parts[part] = { ...surfaces[part], mappedBones: mapping.length,
        maxMappedSourceWorldRotation: Math.max(0, ...mapping.map(({ i }) => sourceRotations[i])),
        maxMappedTargetWorldRotation: Math.max(0, ...mapping.map(({ i }) => targetRotations[i])), lostMovingBones };
    }
    const faults = [];
    if (nonfiniteMatrices || nonfiniteLocals) faults.push('nonfinite-target-pose');
    if (maxLengthError > 1e-7) faults.push('target-local-position-length-changed');
    if (maxUnitQuaternionError > 1e-7) faults.push('nonunit-target-quaternion');
    if (Object.values(parts).some(part => part.nonfiniteVertices)) faults.push('nonfinite-target-surface');
    if (Object.values(parts).some(part => part.lostMovingBones.length)) faults.push('mapped-source-movement-lost');
    const row = { id: entry.id, name: entry.name, category: entry.category, sourceAsset: entry.sourceAsset,
      fileSha256: hash(packed), decodedSha256: hash(decoded), duration: data.duration,
      sourceFrames: data.frameCount, targetPoses: poses, targetBones: bones.length, mappedBones: retarget.mapping.length,
      nativeLongHairMapped: retarget.snapshot().nativeLongHairMapped, sampledSurfaceFrames,
      nonfiniteMatrices, nonfiniteLocals, maxLengthError, maxUnitQuaternionError, parts, faults,
      elapsedMs: performance.now() - clipStarted };
    summary.clips.push(row);
    if (faults.length) summary.failures.push({ id: entry.id, faults });
  } catch (error) { summary.failures.push({ id: entry.id, error: error.message, stack: error.stack }); }
  if ((summary.clips.length + summary.failures.filter(r => r.error).length) % 20 === 0) {
    console.log(`CPU target ${summary.clips.length}/${entries.length}; failures ${summary.failures.length}; ${((performance.now() - start) / 1000).toFixed(1)}s`); save();
  }
}
summary.completedAt = new Date().toISOString(); summary.elapsedMs = performance.now() - start;
summary.modelUnchanged = hash(fs.readFileSync(pmxPath)) === summary.model.sha256;
summary.acceptance = { auditedClips: summary.clips.length, requestedClips: entries.length,
  targetPoses: summary.clips.reduce((sum, row) => sum + row.targetPoses, 0),
  surfacePoseSamples: summary.clips.reduce((sum, row) => sum + row.sampledSurfaceFrames, 0),
  failures: summary.failures.length, passed: summary.clips.length === entries.length && !summary.failures.length && summary.modelUnchanged,
  scope: 'Finite target skeleton, invariant local bone-position lengths, normalized rotations, mapped-motion retention and sampled actual target surface only' };
save(); console.log(JSON.stringify(summary.acceptance));
if (!summary.acceptance.passed) process.exitCode = 1;
