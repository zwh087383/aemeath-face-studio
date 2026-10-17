// Compare actual skeleton motion against the accepted 63199b1 revision.
// No renderer/cloud. Mesh checks are rigid-skinning heuristics, not cloth simulation.
// node scripts/compare-body-elbows.mjs --capture-baseline --baseline-only
// node scripts/compare-body-elbows.mjs --mesh
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'outputs/body-elbows-20261016');
export const BASELINE = join(OUT, 'baseline');
const MODULES = ['motion-controller.js', 'motion-skeleton.js', 'motion-profile.js', 'motion-math.js'];
const degrees = x => x * 180 / Math.PI;
const distance = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
const delta = (a,b) => a.map((v,i)=>v-b[i]);
export const rotationDistance = (a,b) => 2*Math.acos(Math.min(1,Math.abs(a.reduce((s,v,i)=>s+v*b[i],0))));
const rotateInverse = (q,v) => {
  const [x,y,z,w]=[-q[0],-q[1],-q[2],q[3]], [a,b,c]=v;
  const tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);
  return [a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];
};
export function captureBaseline() {
  mkdirSync(BASELINE,{recursive:true});
  for(const file of MODULES) writeFileSync(join(BASELINE,file),execFileSync('git',['show',`63199b1:preview/core/${file}`],{cwd:ROOT}));
  writeFileSync(join(BASELINE,'package.json'),'{"type":"module"}\n');
  writeFileSync(join(BASELINE,'revision.txt'),'63199b1fdf06c33de21f448f3c2bc66cf7ffb2a2\n');
}
export async function loadVariant(directory=join(ROOT,'preview/core')) {
  const [controller,skeleton,profile]=await Promise.all(['motion-controller.js','motion-skeleton.js','motion-profile.js'].map(f=>import(pathToFileURL(join(directory,f)).href)));
  const inspection=JSON.parse(readFileSync(join(ROOT,'assets/Aemeath-inspection.json'),'utf8'));
  return {...controller,...skeleton,...profile,skeleton:skeleton.skeletonFromInspection(inspection),directory};
}
export function makeController(variant,posture='relaxed') {
  const c=new variant.MotionController({skeleton:variant.skeleton});c.setOptions({natural:false});c.setPosture(posture,0);
  for(let i=1;i<=120;i++)c.update(i/60,1/60);
  return c;
}
export function readPose(variant,c) {
  const fk=variant.forwardKinematics(c.rig,c.locals), parts={};
  for(const key of ['spine','upperChest','head']) { const p=fk.get(c.rig.torso[key].name);parts[key]={position:[...p.position],rotation:[...p.rotation]}; }
  const waist=fk.get(c.rig.support?.root??c.rig.torso.spine.name);parts.waist={position:[...waist.position],rotation:[...waist.rotation]};
  const elbows={},wrists={},chest=parts.upperChest;
  for(const side of ['L','R']) {
    const n=c.rig.sides[side].names,s=fk.get(n.arm).position,e=fk.get(n.elbow).position;
    const v=rotateInverse(chest.rotation,delta(e,s)),length=Math.hypot(...v),lateral=v[0]*c.rig.sides[side].sign;
    elbows[side]={position:[...e],lateral,abductionDeg:degrees(Math.asin(Math.min(1,Math.max(0,lateral/length)))),elevationDeg:degrees(Math.acos(Math.max(-1,Math.min(1,-v[1]/length))))};
    wrists[side]=[...fk.get(n.wrist).position];
  }
  return {parts,elbows,wrists};
}
const pairRange=(poses,getter,metric)=>{let max=0;for(let i=0;i<poses.length;i++)for(let j=i+1;j<poses.length;j++)max=Math.max(max,metric(getter(poses[i]),getter(poses[j])));return max;};
export function measureAction(variant,id,{posture='relaxed',fps=60}={}) {
  const c=makeController(variant,posture),baseline=readPose(variant,c),samples=[];
  c.trigger(id,`compare-${id}`,2);
  for(let i=1;i<fps*14;i++) {
    c.update(2+i/fps,1/fps);const g=c.snapshot().gestures.find(g=>g.gesture===id&&!g.recovering);
    samples.push({time:i/fps,phase:g?.phase??'done',age:g?.age,...readPose(variant,c)});
    if(i>fps&&!c.snapshot().gestures.length)break;
  }
  const hold=samples.filter(s=>s.phase==='hold'), expressive=samples.filter(s=>['stroke','hold'].includes(s.phase));
  const peak={};
  for(const key of Object.keys(baseline.parts))peak[key]={rotationDeg:Math.max(...samples.map(s=>degrees(rotationDistance(s.parts[key].rotation,baseline.parts[key].rotation)))),translation:Math.max(...samples.map(s=>distance(s.parts[key].position,baseline.parts[key].position)))};
  const elbows={};
  for(const side of ['L','R'])elbows[side]={restLateral:baseline.elbows[side].lateral,peakLateral:Math.max(...samples.map(s=>s.elbows[side].lateral)),expressiveLateral:Math.max(...expressive.map(s=>s.elbows[side].lateral)),meanExpressiveLateral:expressive.reduce((n,s)=>n+s.elbows[side].lateral,0)/expressive.length,peakAbductionDeg:Math.max(...expressive.map(s=>s.elbows[side].abductionDeg)),peakElevationDeg:Math.max(...expressive.map(s=>s.elbows[side].elevationDeg))};
  let wristSpeed=0,elbowSpeed=0,previous=baseline;
  for(const s of samples){for(const side of ['L','R']){wristSpeed=Math.max(wristSpeed,distance(s.wrists[side],previous.wrists[side])*fps);elbowSpeed=Math.max(elbowSpeed,distance(s.elbows[side].position,previous.elbows[side].position)*fps);}previous=s;}
  const quietHold=hold.slice(1).filter((s,i)=>degrees(rotationDistance(s.parts.upperChest.rotation,hold[i].parts.upperChest.rotation))*fps<.5).length;
  return {id,posture,peak,elbows,hold:{frames:hold.length,chestRotationRangeDeg:degrees(pairRange(hold,s=>s.parts.upperChest.rotation,rotationDistance)),chestQuietFraction:quietHold/Math.max(1,hold.length-1),headTranslationRange:pairRange(hold,s=>s.parts.head.position,distance),waistTranslationRange:pairRange(hold,s=>s.parts.waist.position,distance)},wristSpeed,elbowSpeed,duration:samples.at(-1).time};
}
async function meshEvidence(variant) {
  const {loadModel,check}=await import('./check-motion-clearance.mjs');
  const {skinCoordinated}=await import('./check-coordinated-motion.mjs');
  const model=await loadModel(),poses=[];
  for(const [index,id] of variant.GESTURE_IDS.entries()) {
    const def=variant.GESTURES[id];
    for(const age of [...new Set([def.apex,...Object.values(def.phases).map(p=>(p[0]+p[1])/2)])]){
      const c=makeController(variant);c.inspect(id,age);for(let i=1;i<=120;i++)c.update(2+i/60,1/60);
      poses.push({id,age,...check(model,skinCoordinated(model,c.locals))});
    }
    if((index+1)%8===0)console.log(`Mesh ${variant.directory===BASELINE?'63199b1':'current'}: ${index+1}/${variant.GESTURE_IDS.length} actions sampled`);
  }
  return {method:'80 held poses; nearest-vertex/normal rigid skinning including grants and local translations; physics disabled',summary:{poses:poses.length,marked:poses.filter(p=>p.penetrating>0).length,maxHand:Math.max(...poses.map(p=>p.hand)),maxSleeve:Math.max(...poses.map(p=>p.sleeve)),maxDepth:Math.max(...poses.map(p=>p.maxDepth))},poses};
}
function hashes(directory){return Object.fromEntries(MODULES.map(f=>[f,createHash('sha256').update(readFileSync(join(directory,f))).digest('hex')]));}
export async function run({baselineOnly=false,mesh=false}={}) {
  if(!existsSync(join(BASELINE,'motion-controller.js')))throw new Error('Capture baseline first with --capture-baseline');
  const currentDirectory=join(ROOT,'preview/core'),currentStart=baselineOnly?null:hashes(currentDirectory);
  const baseline=await loadVariant(BASELINE),before={revision:'63199b1',sourceHashes:hashes(BASELINE),actions:baseline.GESTURE_IDS.map(id=>measureAction(baseline,id))};
  const result={boundary:'Actual PMX skeleton FK, natural idle disabled; no visual-quality or all-view clearance claim.',baseline:before};
  if(mesh)before.mesh=await meshEvidence(baseline);
  if(!baselineOnly){
    const start=currentStart,current=await loadVariant(currentDirectory);
    result.current={sourceHashes:start,actions:current.GESTURE_IDS.map(id=>measureAction(current,id))};
    if(mesh)result.current.mesh=await meshEvidence(current);
    const end=hashes(current.directory);result.sourceChangedDuringRun=MODULES.filter(f=>start[f]!==end[f]);
  }
  const rows=before.actions.map((b,i)=>{
    const a=result.current?.actions.find(a=>a.id===b.id),fmt=(x,y,digits=1)=>`${x.toFixed(digits)}${y===undefined?'':` → ${y.toFixed(digits)}`}`;
    return {action:b.id,'elbow L/R units':`${fmt(b.elbows.L.expressiveLateral,a?.elbows.L.expressiveLateral,2)} / ${fmt(b.elbows.R.expressiveLateral,a?.elbows.R.expressiveLateral,2)}`,'abduction L/R deg':`${fmt(b.elbows.L.peakAbductionDeg,a?.elbows.L.peakAbductionDeg)} / ${fmt(b.elbows.R.peakAbductionDeg,a?.elbows.R.peakAbductionDeg)}`,'chest peak deg':fmt(b.peak.upperChest.rotationDeg,a?.peak.upperChest.rotationDeg),'head travel':fmt(b.peak.head.translation,a?.peak.head.translation,2),'waist travel':fmt(b.peak.waist.translation,a?.peak.waist.translation,2),'hold chest range deg':fmt(b.hold.chestRotationRangeDeg,a?.hold.chestRotationRangeDeg)};
  });
  result.table=rows;mkdirSync(OUT,{recursive:true});writeFileSync(join(OUT,baselineOnly?'baseline.json':'comparison.json'),JSON.stringify(result,null,2)+'\n');
  console.table(rows);
  if(result.sourceChangedDuringRun?.length)throw new Error(`Source changed: ${result.sourceChangedDuringRun}`);
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(process.argv.includes('--capture-baseline'))captureBaseline();await run({baselineOnly:process.argv.includes('--baseline-only'),mesh:process.argv.includes('--mesh')});}
