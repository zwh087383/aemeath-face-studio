import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, sourceHashes } from '../scripts/character-center/audit-held-variants.mjs';
import { pulledOutDeskEntryFixture } from '../preview/core/activity-seat-access.js';
import { ACTIVITY_SEQUENCES } from '../preview/core/activity-library.js';
import { PARTITIONED_DESK } from '../preview/core/activity-desk-layout.js';
import { toWorld, toModel } from '../preview/core/full-body-ik.js';
const output=process.env.ACTIVITY_FURNITURE_REPORT??'outputs/library-expansion-20261027/activity-furniture-entry.json';
const report={at:new Date().toISOString(),sourceHashes:sourceHashes(),rows:[],evidence:'Actual PMX FK bone segments, actual chair/table geometry and support contacts; not skin/cloth collision or human naturalness acceptance'};
const copy=x=>structuredClone(x);
const record=(id,fn)=>test(id,()=>{const row={id,execution:{pass:false}};try{fn(row);row.execution.pass=true;}catch(e){row.execution.error=e.stack;throw e;}finally{report.rows.push(row);fs.writeFileSync(output,JSON.stringify(report,null,2));}});

function checkPhysical(f, row) {
 const c=f.c,measured=f.props.snapshot().props;row.frames=(row.frames??0)+1;
 assert.equal(measured.chair.visible,true);assert.equal(measured.table.visible,true);
 assert.deepEqual(measured.table.position,[0,0,4.3]);
 assert.ok(c.diagnostics.legs.L.error<1e-6&&c.diagnostics.legs.R.error<1e-6);
 const chair=measured.chair.position;
 for(const side of ['L','R']) {
  const names=c.rig.legs[side].names;
  for(const [a,b] of [[names.hip,names.knee],[names.knee,names.ankle]]) {
   const first=toWorld(c.root,c.fk.get(a).position),last=toWorld(c.root,c.fk.get(b).position);
   for(let i=0;i<=30;i++){
    const p=first.map((v,k)=>v+(last[k]-v)*i/30);
    const inside=Math.abs(p[0]-chair[0])<3.3&&Math.abs(p[2]-chair[2])<2.6&&p[1]>5.5&&p[1]<6.1;
    assert.equal(inside,false,`${c.activeId} ${c.pose.phase} ${a}/${b} penetrates actual cushion at ${JSON.stringify(p)}`);
   }
  }
 }
 const torsoFrom=toWorld(c.root,c.fk.get(c.rig.support.root).position),torsoTo=toWorld(c.root,c.fk.get(c.rig.torso.upperChest.name).position);
 for(let i=0;i<=30;i++){
  const p=torsoFrom.map((v,k)=>v+(torsoTo[k]-v)*i/30);
  assert.equal(Math.abs(p[0])<5&&Math.abs(p[2]-4.3)<2.5&&p[1]>8.625&&p[1]<9.175,false,`${c.activeId}: torso crosses real desktop`);
 }
 if(c.pose.support==='seated'){
  const seat=toWorld(c.root,[c.pose.pelvis.offset[0],10.55+c.pose.pelvis.offset[1],c.pose.pelvis.offset[2]]);
  assert.ok(Math.abs(seat[1]-chair[1]-6.1)<.06,`unsupported seated height ${seat[1]-chair[1]}`);
  assert.ok(Math.abs(seat[2]-chair[2])<2.6&&Math.abs(seat[0]-chair[0])<3.3);
 }
 row.maxAnkleError=Math.max(row.maxAnkleError??0,c.diagnostics.legs.L.error,c.diagnostics.legs.R.error);
}

record('tight desk refuses standing entry and side approach before changing any owner',row=>{
 const tight=fixture({chair:true,table:true},{safeSeat:false});try{
  const before=tight.c.snapshot(),physical=tight.props.snapshot(),p=tight.c.preparePlay('sit_down');
  assert.equal(p.accepted,false);assert.equal(p.reason,'seat_entry_space_blocked');assert.equal(tight.c.play('sit_down'),false);
  assert.deepEqual(tight.c.snapshot(),before);assert.deepEqual(tight.props.snapshot(),physical);row.reason=p.reason;
 }finally{tight.props.dispose();}
 const f=fixture({chair:true,table:true});try{
  const root={position:[7,0,0],yaw:0};f.c.adoptSupportedState({pose:f.c.standing(root),sceneProps:copy(f.c.sceneProps)});
  assert.equal(f.c.preparePlay('sit_down').reason,'seat_entry_requires_front_approach');
 }finally{f.props.dispose();}
});

record('pulled-out actual chair accepts front lowering and supported approach, then actual retreat and rise',row=>{
 const f=fixture({chair:true,table:true});try{
  row.fixture={sceneProps:f.setup,initialRoot:f.initialRoot};row.steps=[];
  for(const id of ['sit_down','approach_desk_seated','stand_up_from_desk'])row.steps.push(f.run(id,id==='stand_up_from_desk'?{context:{deskLayout:'partitioned',deskRetreat:7}}:{},()=>checkPhysical(f,row)));
  assert.equal(f.c.pose.support,'standing');assert.ok(Math.abs(f.c.root.position[2]-f.initialRoot.position[2])<1e-6);
  assert.ok(Math.abs(f.props.snapshot().props.chair.position[2]+8.2)<1e-6);row.after=f.props.snapshot();
 }finally{f.props.dispose();}
});

record('a real floor box blocks the entry route without moving it aside',row=>{
 const f=fixture({chair:true,table:true,box:{visible:true,attachment:'floor',position:[0,0,-4.2]}});try{
  const before=f.c.snapshot(),physical=f.props.snapshot(),result=f.c.preparePlay('sit_down');
  assert.equal(result.accepted,false);assert.equal(result.reason,'seat_route_obstructed');assert.equal(result.obstacle,'box');
  assert.deepEqual(f.c.snapshot(),before);assert.deepEqual(f.props.snapshot(),physical);row.reason=result.reason;
 }finally{f.props.dispose();}
});

for(const [id,cut] of [['sit_down',.4],['sit_down',1.4],['sit_down',2.6],['approach_desk_seated',.5],['approach_desk_seated',1.7],['approach_desk_seated',2.7],['stand_up',.9],['stand_up',1.8]])record(`${id} interrupted at ${cut}s stops on real support and can resume explicitly`,row=>{
 const f=fixture({chair:true,table:true});try{
  if(id!=='sit_down')f.run('sit_down',{},()=>checkPhysical(f,row));
  assert.equal(f.c.play(id),true);
  for(let i=0;i<300&&(f.c.bridge||f.c.elapsed<cut);i++){f.step();checkPhysical(f,row);}
  f.c.stop();let frames=0;for(;!f.c.done&&frames<360;frames++){f.step();checkPhysical(f,row);}assert.equal(f.c.done,true);
  row.afterStop={support:f.c.pose.support,root:copy(f.c.root),chair:f.props.snapshot().props.chair,elapsed:f.c.elapsed};
  if(f.c.pose.support==='seated'){
   if(id==='approach_desk_seated'&&f.c.seatAccess(id).accepted)f.run(id,{},()=>checkPhysical(f,row));
   else f.run('sit_listen',{},()=>checkPhysical(f,row));
  }else{
   assert.equal(f.c.pose.feet.L.contact&&f.c.pose.feet.R.contact,true);
   const access=f.c.seatAccess('sit_down');if(access.accepted)f.run('sit_down',{},()=>checkPhysical(f,row));
  }
  row.afterResume={support:f.c.pose.support,root:copy(f.c.root)};
 }finally{f.props.dispose();}
});

for(const id of ['reading_break','desk_session','quiet_afternoon'])record(`${id} executes the declared pulled-chair entry and complete unchanged furniture sequence`,row=>{
 const sequence=ACTIVITY_SEQUENCES[id],f=fixture({...copy(PARTITIONED_DESK.setupProps),chair:true});try{
  assert.equal(sequence.initialScene.kind,'pulled-out-desk-entry');row.fixture={sceneProps:f.setup,initialRoot:f.initialRoot};row.steps=[];
  for(const step of sequence.steps)row.steps.push(f.run(step.activity,{context:step.context},()=>{
   assert.deepEqual(f.props.snapshot().props.table.position,[0,0,4.3]);
   assert.ok(f.c.diagnostics.legs.L.error<1e-6&&f.c.diagnostics.legs.R.error<1e-6);
  }));
  row.after={support:f.c.pose.support,props:f.props.snapshot().props};
  assert.equal(f.props.snapshot().props.book.attachment,'table');assert.equal(f.props.snapshot().props.mug.attachment,'table');
 }finally{f.props.dispose();}
});
