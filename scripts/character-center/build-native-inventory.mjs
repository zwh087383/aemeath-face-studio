import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { NativeClip } from '../../preview/core/native-motion.js';
import { buildNativeBehaviorPlan } from '../../preview/core/native-behavior-adapter.js';
import { findNativeRibbonCompanion } from '../../preview/core/native-companion.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1e5) / 1e5;
const names = ['Bip001Pelvis','Bip001Head','Bip001LThigh','Bip001LCalf','Bip001LFoot','Bip001RThigh','Bip001RCalf','Bip001RFoot','Bip001LUpperArm','Bip001LForearm','Bip001LHand','Bip001RUpperArm','Bip001RForearm','Bip001RHand'];
const ordered = ['start', 'loop', 'single', 'end'];

/** Derived measurements, never a semantic or collision certificate. The
 * exported manifest contains source identities and bounds, not motion curves. */
export function measureClip(data) {
  // The audit needs nine actual source frames, not a duplicate Three.js object
  // graph for every key of a minute-long clip. Source hashing still covers ALL
  // bytes; the recorded geometry scope explicitly remains nine sampled frames.
  const sourceFrames=Array.from({length:9},(_,i)=>Math.round((data.frames.length-1)*i/8));
  const clip = new NativeClip({...data,frameCount:9,frames:sourceFrames.map(i=>data.frames[i])}), index = name => clip.indices.get(name);
  if(names.some(name=>index(name)===undefined))throw Error('Incomplete body skeleton: '+data.sourceAsset);
  const at = name => clip.world[index(name)].p;
  const rest = name => clip.restWorld[index(name)].p;
  const leg = rest('Bip001LThigh').distanceTo(rest('Bip001LCalf'))+rest('Bip001LCalf').distanceTo(rest('Bip001LFoot'));
  const samples = [];
  for(let i=0;i<=8;i++) {
    clip.sample(data.duration*i/8);
    const l=at('Bip001LFoot'),r=at('Bip001RFoot'),pelvis=at('Bip001Pelvis'),head=at('Bip001Head');
    samples.push({time:round(clip.time),pelvisHeight:round((pelvis.y-(l.y+r.y)/2)/leg),footDifference:round(Math.abs(l.y-r.y)/leg),
      headHeight:round((head.y-(l.y+r.y)/2)/leg),
      handHeadDistance:round(Math.min(at('Bip001LHand').distanceTo(head),at('Bip001RHand').distanceTo(head))/leg),
      joints:Object.fromEntries(names.map(name=>[name.replace('Bip001',''),at(name).toArray().map(round)]))});
  }
  const summary = {sampleCount:samples.length,normalization:'source thigh-calf-foot chain; source units cancel',
    start:samples[0],end:samples.at(-1),
    pelvisHeightRange:[Math.min(...samples.map(s=>s.pelvisHeight)),Math.max(...samples.map(s=>s.pelvisHeight))],
    maximumFootDifference:Math.max(...samples.map(s=>s.footDifference)),
    minimumHandHeadDistance:Math.min(...samples.map(s=>s.handHeadDistance))};
  for(const key of ['start','end']) { const {joints,...measurements}=summary[key]; summary[key]=measurements; }
  return {summary,samples};
}

export async function buildNativeInventory(resourceRoot, {inspect=false}={}) {
  const queueBytes=await fs.readFile(path.join(resourceRoot,'action-preparation-20261023/review-queue.json'));
  const manifestBytes=await fs.readFile(path.join(resourceRoot,'native-complete-20261022/manifest.json'));
  const queue=JSON.parse(queueBytes),manifest=JSON.parse(manifestBytes),groups=queue.groups.filter(row=>row.kind==='native-body-family');
  const result=[],inspection=[];
  for(const group of groups) {
    const plan=buildNativeBehaviorPlan(group,manifest),phases=[];
    for(const item of plan) {
      const descriptor=manifest.clips.find(row=>row.id===item.id),record=group.sources.find(row=>row.id===item.id);
      const sourcePath=path.resolve(resourceRoot,'native-complete-20261022',descriptor.file);
      const boundary=path.relative(path.resolve(resourceRoot,'native-complete-20261022'),sourcePath);
      if(boundary.startsWith('..')||path.isAbsolute(boundary))throw Error('Source escaped resource directory');
      const bytes=await fs.readFile(sourcePath),sha256=hash(bytes);
      if(record.sourceSha256!==sha256)throw Error('Source fingerprint changed: '+item.id);
      const jsonBytes=gunzipSync(bytes),data=JSON.parse(jsonBytes),measured=measureClip(data);
      if(Math.abs(data.duration-item.duration)>1e-6)throw Error('Duration changed: '+item.id);
      const paired=findNativeRibbonCompanion(descriptor,manifest.clips);let companion=null;
      if(paired){const companionPath=path.resolve(resourceRoot,'native-complete-20261022',paired.file),relative=path.relative(path.resolve(resourceRoot,'native-complete-20261022'),companionPath);
        if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Companion escaped resource directory');
        const pairedBytes=await fs.readFile(companionPath),pairedJSON=gunzipSync(pairedBytes),pairedData=JSON.parse(pairedJSON);
        companion={id:paired.id,sha256:hash(pairedBytes),jsonSha256:hash(pairedJSON),sourceAsset:paired.sourceAsset,duration:paired.duration,
          composition:pairedData.sourceAdditiveType==='AAT_LocalSpaceBase'&&pairedData.additiveBakedToFullPose?'replace':'additive'};
      }
      phases.push({...item,sha256,jsonSha256:hash(jsonBytes),geometry:measured.summary,companion});
      if(inspect)inspection.push({groupId:group.id,name:group.name,id:item.id,phase:item.phase,samples:measured.samples});
    }
    result.push({groupId:group.id,name:group.name,sourceFamily:group.sourceFamily,
      reviewCategory:group.priority.label,sourceSeamTier:group.sourceSeamReview.tier,
      sourceRootMovement:group.dependencyProfile.sourceRootMovement,
      phases:phases.sort((a,b)=>ordered.indexOf(a.phase)-ordered.indexOf(b.phase)||a.sourcePhase.localeCompare(b.sourcePhase,undefined,{numeric:true})),
      missingStart:group.sourceSeamReview.missingNamedStart,missingEnd:group.sourceSeamReview.missingNamedEnd});
  }
  return {inventory:{schema:1,source:{queueSha256:hash(queueBytes),manifestSha256:hash(manifestBytes)},
    evidence:'Exact source bytes hashed and nine real skeletal poses sampled per clip. Measurements do not prove semantics, contacts, clothing clearance or visual acceptance.',groups:result},inspection};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),resourceAt=args.indexOf('--resource-root');
  if(resourceAt<0)throw Error('Specify --resource-root for the private outputs directory; no implicit original-checkout writes.');
  const {inventory,inspection}=await buildNativeInventory(path.resolve(args[resourceAt+1]),{inspect:args.includes('--inspect')});
  const destination=path.join(root,'realtime/character-center/native-inventory-data.mjs');
  await fs.writeFile(destination,'// Generated by scripts/character-center/build-native-inventory.mjs. Derived metadata only.\nexport const NATIVE_SOURCE_INVENTORY = '+JSON.stringify(inventory,null,2)+';\n');
  if(inspection.length){await fs.mkdir(path.join(root,'outputs/library-expansion'),{recursive:true});await fs.writeFile(path.join(root,'outputs/library-expansion/native-pose-inspection.json'),JSON.stringify(inspection));}
  console.log(JSON.stringify({groups:inventory.groups.length,clips:inventory.groups.reduce((n,g)=>n+g.phases.length,0),destination}));
}
