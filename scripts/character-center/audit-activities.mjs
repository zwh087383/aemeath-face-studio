import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import { FullBodyController } from '../../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';
import { ACTIVITY_LIBRARY } from '../../preview/core/activity-library.js';
import { PARTITIONED_DESK } from '../../preview/core/activity-desk-layout.js';
import { createActivityProps } from '../../realtime/activities/props.mjs';
import { fixture as safeFixture } from './audit-held-variants.mjs';
const skeleton=skeletonFromInspection(JSON.parse(fs.readFileSync(new URL('../../assets/Aemeath-inspection.json',import.meta.url),'utf8')));
const flags=Object.fromEntries(process.argv.slice(2).map((v,i,a)=>v.startsWith('--')?[v,a[i+1]]:[]).filter(x=>x.length));
const ids=flags['--ids']?.split(',')??Object.keys(ACTIVITY_LIBRARY);
const output=flags['--output']??'outputs/library-expansion-20261027/activity-final-76.json';
const sourceFiles=['preview/core/full-body-controller.js','preview/core/activity-library.js','preview/core/activity-continuation.js','preview/core/activity-prop-execution.js','preview/core/motion-skeleton.js','preview/core/activity-seat-access.js','preview/core/activity-route-access.js'];
const copy=x=>structuredClone(x),result={at:new Date().toISOString(),kind:'actual PMX FK and rendered prop receipts; no visual acceptance or model calls',
 sourceHashes:Object.fromEntries(sourceFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),rows:[]};
fs.mkdirSync(path.dirname(output),{recursive:true});
for(const id of ids){
 const d=ACTIVITY_LIBRARY[id],fixture=[],failures=[];
 const required=new Set(d.requires??[]),held=d.requiresHeld??(d.reading?'book':({drink:'mug',write:'pencil',carry:'box'})[d.kind]);
 if(held){required.add(held);required.add('table');}if(d.initialSupport==='seated')required.add('chair');
 const setup=Object.fromEntries([...required].map(prop=>[prop,copy(PARTITIONED_DESK.setupProps[prop]??true)]));
 if(required.has('box'))setup.box={visible:true,attachment:'table',position:[0,8.9,3.8]};
 const physical=safeFixture(setup),{c,props}=physical;
 fixture.push({kind:'explicit_scene',props:physical.setup,initialRoot:physical.initialRoot});
 const advance=action=>{
  const accepted=c.play(action,{context:{deskLayout:'partitioned',...(action==='stand_up_from_desk'?{deskRetreat:5.5}:{})}});let frames=0;
  for(;accepted&&!c.done&&frames<900;frames++){
   c.update(c.now+1/30,1/30);const hands=c.handAnchors();props.update({...c.sceneProps,...c.pose.props},{anchors:{leftHand:hands.L,rightHand:hands.R},root:c.root,anchor:c.pose.anchor??c.anchor,pose:c.pose,snapshot:c.snapshot(),time:c.now});
   c.setRenderedPropsSnapshot(props.snapshot());c.setPropTransferReceipts(props.snapshot());
  }
  return {action,accepted,done:c.done,active:c.activeId,frames,status:c.status,elapsed:c.elapsed,reason:c.pose.preparationBlocker??null,diagnostics:c.diagnostics.propContacts};
 };
 if(d.initialSupport==='seated'){const p=advance('sit_down');fixture.push(p);if(!p.accepted||!p.done)failures.push(p);}
 if(d.initialSupport==='seated'&&id!=='approach_desk_seated'&&id!=='stand_up'&&required.has('table')){const p=advance('approach_desk_seated');fixture.push(p);if(!p.accepted||!p.done)failures.push(p);}
 if(held){const take=held==='box'?'pickup_box':`take_${held}_${d.initialSupport==='seated'?'seated':'standing'}`;const p=advance(take);fixture.push(p);if(!p.accepted||!p.done)failures.push(p);}
 const execution=failures.length?null:advance(id);if(execution&&(!execution.accepted||!execution.done))failures.push(execution);
 const after={support:c.pose.support,root:copy(c.root),held:Object.fromEntries(Object.entries(props.snapshot().props).filter(([,p])=>['left','right','both'].includes(p.attachment)).map(([k,p])=>[k,p.attachment])),props:props.snapshot().props};
 result.rows.push({id,fixture,execution,after,failures});props.dispose();fs.writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({id,pass:failures.length===0,reason:failures.map(f=>f.reason??f.status)}));
}
if(result.rows.some(row=>row.failures.length))process.exitCode=1;
