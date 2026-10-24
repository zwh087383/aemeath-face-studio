import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), url = file => pathToFileURL(resolve(root, file)).href;
const THREE = await import(url('preview/node_modules/three/build/three.module.js'));
const hooks = registerHooks({ resolve(s, c, n) { return s === 'three' ? { url: url('preview/node_modules/three/build/three.module.js'), shortCircuit: true } : n(s, c); } });
const { createActivityProps } = await import(url('realtime/activities/props.mjs')); hooks.deregister();
const { FullBodyController } = await import(url('preview/core/full-body-controller.js'));
const { ActivityDirector } = await import(url('realtime/activities/director.mjs'));
const { skeletonFromInspection } = await import(url('preview/core/motion-skeleton.js'));
const { ACTIVITY_SEQUENCES } = await import(url('preview/core/activity-library.js'));
const { fingerprintDependencies, verifyFingerprints } = await import(url('scripts/action-preparation/source-fingerprints.mjs'));
const sourceDependencies=fingerprintDependencies(['scripts/action-preparation/validate-desk-layout.mjs','preview/core/full-body-controller.js','realtime/activities/director.mjs','realtime/activities/props.mjs'],root);
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(resolve(root, 'assets/Aemeath-inspection.json'), 'utf8')));
const body = new FullBodyController({ skeleton }), director = new ActivityDirector(body), props = createActivityProps(new THREE.Scene());
const ids = ['book', 'mug', 'paper', 'pencil', 'laptop', 'box'];
function visibleMeshes(object) {
  const result = [];
  const visit = node => { if (!node.visible) return; if (node.geometry) {
    node.geometry.computeBoundingBox(); result.push({ node, bounds: node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld) }); }
    for (const child of node.children) visit(child);
  }; visit(object); return result;
}
function bounds(meshes) { const result = new THREE.Box3(); for (const part of meshes) result.union(part.bounds); return result; }
function triangles(mesh) {
  const positions = mesh.geometry.attributes.position, indices = mesh.geometry.index, result = [];
  const point = index => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
  const n = indices ? indices.count : positions.count;
  for (let i = 0; i < n; i += 3) {
    const tri = new THREE.Triangle(...[0, 1, 2].map(j => point(indices ? indices.getX(i + j) : i + j)));
    result.push({ tri, box: new THREE.Box3().setFromPoints([tri.a, tri.b, tri.c]) });
  } return result;
}
function intersectionPoint(a, b) {
  const hit = new THREE.Vector3(), ray = new THREE.Ray(), direction = new THREE.Vector3();
  for (const [from, to] of [[a, b], [b, a]]) {
    for (const [start, end] of [[from.a, from.b], [from.b, from.c], [from.c, from.a]]) {
      direction.subVectors(end, start); const length = direction.length(); if (length < 1e-10) continue;
      ray.set(start, direction.multiplyScalar(1 / length));
      if (ray.intersectTriangle(to.a, to.b, to.c, false, hit) && hit.distanceTo(start) <= length + 1e-7) return hit.toArray();
    }
  }
  // A planar surface can lie inside another coplanar triangle with no edge ray
  // crossing. This is a surface-contact candidate, not a volume depth estimate.
  const plane = new THREE.Plane().setFromCoplanarPoints(a.a, a.b, a.c);
  for (const p of [b.a, b.b, b.c]) if (Math.abs(plane.distanceToPoint(p)) < 1e-7 && a.containsPoint(p)) return p.toArray();
  return null;
}
const findings = new Map(), entered = [], expectedContacts = [];
let wall = 0, previousStep = -1, frames = 0, samples = 0;
let maximumPalmError=0,maximumCommandedReach=0;const contactFailures=[],scaleFailures=[];
const sequenceId=process.env.LAYOUT_SEQUENCE??'desk_session';
if(!Object.hasOwn(ACTIVITY_SEQUENCES,sequenceId))throw Error('Unknown activity sequence');
if(!director.playSequence(sequenceId))throw Error('Scene refused sequence admission');
for (; frames < 30 * Number(process.env.LAYOUT_MAX_SECONDS ?? 240) && director.sequence; frames++) {
  wall += 1 / 30; const clock = director.tick(wall); body.update(clock.now, clock.dt);
  const hands = body.handAnchors(); props.update(body.pose.props, { anchors: { leftHand: hands.L, rightHand: hands.R }, root: body.root,
    anchor: body.pose.anchor ?? body.anchor, pose: body.pose, snapshot: body.snapshot(), time: clock.now });
  body.setRenderedPropsSnapshot(props.snapshot()); body.setPropTransferReceipts(props.snapshot());
  for(const [id,contact]of Object.entries(body.pose.propContacts?.props??{}))for(const [side,target]of Object.entries(contact.targets??{})){
    const error=Math.hypot(...target.map((v,i)=>v-hands[side].position[i])),reach=body.diagnostics.arms[side].reach;
    maximumPalmError=Math.max(maximumPalmError,error);maximumCommandedReach=Math.max(maximumCommandedReach,reach);
    if((error>.025||reach>.995001)&&contactFailures.length<30)contactFailures.push({at:clock.now,activity:body.activeId,id,side,error,reach});
  }
  for(const [id,state]of Object.entries(props.snapshot().props))if(state.visible&&state.scale?.some(value=>value!==1)&&scaleFailures.length<30)scaleFailures.push({at:clock.now,id,scale:state.scale});
  const step = director.sequence?.index ?? ACTIVITY_SEQUENCES[sequenceId].steps.length;
  const changed = step !== previousStep; if (changed) { entered.push({ step, at: clock.now, id: body.activeId }); previousStep = step; }
  if (!changed && frames % Number(process.env.LAYOUT_GEOMETRY_EVERY ?? 1)) continue; samples++;
  const actual = Object.fromEntries(ids.filter(id => props.objects[id].visible).map(id => [id, visibleMeshes(props.objects[id])]));
  for (const [i, left] of ids.entries()) for (const right of ids.slice(i + 1)) {
    if (!actual[left]?.length || !actual[right]?.length) continue;
    const a = bounds(actual[left]), b = bounds(actual[right]); if (!a.intersectsBox(b)) continue;
    const intersection = a.clone().intersect(b), depth = intersection.getSize(new THREE.Vector3()).toArray();
    if (Math.min(...depth) < .0001) continue;
    const key = `${left}:${right}`, volume = depth.reduce((n, v) => n * v, 1);
    let triangleHit = null, names = null;
    const previous = findings.get(key);
    if (!previous || !previous.triangleIntersection || volume > previous.maximumAabbVolume * 1.1) {
      outer: for (const p of actual[left]) for (const q of actual[right]) {
        if (!p.bounds.intersectsBox(q.bounds)) continue;
        const ta = triangles(p.node), tb = triangles(q.node);
        for (const pa of ta) for (const pb of tb) if (pa.box.intersectsBox(pb.box)) {
          const hit = intersectionPoint(pa.tri, pb.tri); if (hit) { triangleHit = hit; names = [p.node.name, q.node.name]; break outer; }
        }
      }
    }
    const item = { pair: [left, right], firstAt: previous?.firstAt ?? clock.now, firstActivity: previous?.firstActivity ?? body.activeId,
      maximumAabbVolume: Math.max(previous?.maximumAabbVolume ?? 0, volume), maximumAabbAt: volume > (previous?.maximumAabbVolume ?? 0) ? clock.now : previous.maximumAabbAt,
      maximumAabbActivity: volume > (previous?.maximumAabbVolume ?? 0) ? body.activeId : previous.maximumAabbActivity,
      aabbIntersection: volume > (previous?.maximumAabbVolume ?? 0) ? { min: intersection.min.toArray(), max: intersection.max.toArray(), depth,
        left: { min: a.min.toArray(), max: a.max.toArray() }, right: { min: b.min.toArray(), max: b.max.toArray() } } : previous.aabbIntersection,
      triangleIntersection: previous?.triangleIntersection ?? (triangleHit ? { at: clock.now, activity: body.activeId, meshes: names, point: triangleHit } : null) };
    findings.set(key, item);
  }
}
verifyFingerprints(sourceDependencies,root);
const report = { schema: 1, generatedAt: new Date().toISOString(), scope: `read-only real controller/director plus actual visible Three.js prop meshes, 30Hz stepping and one geometry sample per ${Number(process.env.LAYOUT_GEOMETRY_EVERY??1)} frames plus step boundaries`,
  sourceDependencies, sourceStable:true,
  sequence: sequenceId, completed: director.sequence === null && body.done, frames, samples, entered,
  final: { activeId: body.activeId, phase: body.pose.phase, status: body.status, contacts: body.diagnostics?.propContacts, props: props.snapshot().props }, findings: [...findings.values()],
  contacts:{maximumPalmError,maximumCommandedReach,failures:contactFailures},scaleFailures,
  evidenceLimits: ['World AABB overlap is a broad-phase candidate, not a penetration proof', 'Recorded triangle intersections are geometric surface intersections; they do not determine forces or balance', 'Pencil and paper contact during writing is intended; book-paper and book-laptop overlap require layout review', 'No production source was edited by this audit'] };
const unsafeIntersections=report.findings.filter(row=>row.triangleIntersection&&row.pair.join(':')!=='paper:pencil');
report.passed=report.completed&&!unsafeIntersections.length&&!contactFailures.length&&!scaleFailures.length;
writeFileSync(resolve(root, `outputs/action-execution-preparation-20261023/layout-review${sequenceId==='desk_session'?'':'-'+sequenceId}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed:report.passed,completed: report.completed,contacts:report.contacts, final: { activeId: body.activeId, phase: body.pose.phase, status: body.status, transfer: props.snapshot().props.pencil?.transfer, contacts: body.diagnostics?.propContacts }, frames, samples, findings: report.findings.map(row => ({ pair: row.pair, firstAt: row.firstAt, maximumAabbActivity: row.maximumAabbActivity,
  maximumAabbVolume: row.maximumAabbVolume, triangleIntersection: row.triangleIntersection })) }));
props.dispose();
if(!report.passed)process.exitCode=1;
