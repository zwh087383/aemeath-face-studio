import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {NativeClip} from '../../preview/core/native-motion.js';
import {NativeExpression} from '../../preview/core/native-expression.js';
import {GESTURE_METADATA,GESTURES} from '../../preview/core/motion-profile.js';
import {EXPANDED_PRESETS} from '../../preview/core/expanded-expression-library.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'outputs/architecture-skill-20261022/forward-test');
const dataRoot=path.join(root,'outputs/native-complete-20261022'),manifest=JSON.parse(fs.readFileSync(path.join(dataRoot,'manifest.json'),'utf8'));
const candidates=['body-stand2-84d0c0a158','aimisi-thinking01-start','aimisi-thinking01-loop','aimisi-talk01-start','aimisi-talk01-loop','aimisi-showhand01-start','aimisi-showhand01-loop'];
const inspect=id=>{
  const entry=manifest.clips.find(c=>c.id===id),raw=fs.readFileSync(path.join(dataRoot,entry.file)),data=JSON.parse(entry.file.endsWith('.gz')?gunzipSync(raw):raw),clip=new NativeClip(data);
  const names=['Bip001Spine','Bip001Head','Bip001RUpperArm','Bip001RForearm','Bip001RHand'];
  const samples=[];
  for(const fraction of [0,.25,.5,.75,1]){clip.sample(data.duration*fraction);samples.push({fraction,bones:Object.fromEntries(names.map(n=>[n,{p:clip.world[clip.indices.get(n)].p.toArray(),q:clip.world[clip.indices.get(n)].q.toArray()}]))});}
  return {id,name:entry.name,sourceAsset:entry.sourceAsset,sha256:createHash('sha256').update(raw).digest('hex'),duration:data.duration,frameCount:data.frameCount,sourceUnits:data.units,authoredEvents:Object.keys(data).filter(k=>/event|trigger|condition/i.test(k)),samples};
};
const expressions=manifest.resources.filter(x=>x.kind==='expression').map(entry=>{
  const clip=new NativeExpression(JSON.parse(fs.readFileSync(path.join(dataRoot,entry.file),'utf8')));
  return {id:entry.id,name:entry.name,curves:clip.data.curves.map(c=>({name:c.name,count:c.keys.length,min:Math.min(...c.keys.map(k=>k.value)),max:Math.max(...c.keys.map(k=>k.value))}))};
});
const result={checkedAt:new Date().toISOString(),counts:{clips:manifest.clips.length,resources:manifest.resources.length,
  kinds:Object.fromEntries([...new Set([...manifest.clips,...manifest.resources].map(x=>x.resourceKind||x.kind))].map(k=>[k,[...manifest.clips,...manifest.resources].filter(x=>(x.resourceKind||x.kind)===k).length])),originalGestures:Object.keys(GESTURE_METADATA).length,originalExpandedExpressions:EXPANDED_PRESETS.length},
  catalogScope:manifest.clips.map(({id,name,sourceAsset,category,resourceKind,group,loop})=>({id,name,sourceAsset,category,resourceKind,group,loop})),
  inspectedNative:candidates.map(inspect),expressions,
  originalNearest:['listening_pause','ask_check','embarrassed','offer_turn','refocus','clarify','reset_and_resolve','micro_ack'].map(id=>({id,...GESTURES[id]})),
  novelty:'The original contribution is an event-conditioned arrest/wait/understood-confirm sequence, independently authored trajectories and dynamic brows/eyes/corners. It is not a renamed, mirrored or retimed game clip. Stand2 and Rib_Stand2 are explicitly reused.',
  limitations:'All current descriptor metadata and original libraries were reviewed; seven closest native clips were numerically sampled. Not an exhaustive visual semantic audit of every game clip or unextracted game content.'};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'resource-comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({counts:result.counts,inspectedNative:result.inspectedNative.map(x=>({id:x.id,frames:x.frameCount,duration:x.duration})),expressionCurves:expressions.reduce((n,x)=>n+x.curves.length,0),dynamicExpressionCurves:expressions.flatMap(x=>x.curves).filter(x=>x.max!==x.min).length},null,2));
