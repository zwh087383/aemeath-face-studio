async page => {
  const output='outputs/action-preparation-20261023/native-behaviors';
  const report={schema:1,startedAt:new Date().toISOString(),url:page.url(),evidence:'Independent Chrome; actual PMX and GLTF; same-source body and exact ribbon, NativeClothBinding. Source and target output is driven by explicit behavior clock.',cases:[],errors:[],screenshots:[],limitations:['GPU appearance and sampled screenshots do not prove all transition naturalness, physical support or collision clearance.','All source families are covered separately by CPU target execution; browser cases are representative.']};
  page.on('pageerror',e=>report.errors.push(e.message));await page.waitForFunction(()=>window.nativeBehaviorLab?.snapshot().ready,{timeout:60000});
  const names=['Talk02','Thinking01','SitTalk01','Thinking02','DZ_Liaotoufa01','DZ_Beishouzhuanshen01','Turn_L90D','Stand2','Wuzui02'];
  const ids=await page.evaluate(names=>{const groups=window.nativeBehaviorLab.groups;return names.map(name=>groups.find(g=>g.name===name)).filter(Boolean).map(g=>({id:g.id,name:g.name}));},names);
  for(const entry of ids){const value=await page.evaluate(async entry=>{
    const lab=window.nativeBehaviorLab;await lab.select(entry.id);lab.pause(true);const state=lab.snapshot();if(state.error||state.groupId!==entry.id)throw Error(state.error||'Wrong group');
    const player=lab.player,adapter=lab.adapter,mesh=lab.mesh,rows=adapter.targetRest;
    const sample=()=>{adapter.apply(player.pose());return {locals:rows.map(r=>({p:r.node.position.toArray(),q:r.node.quaternion.toArray(),length:r.node.position.length()})),finite:mesh.skeleton.bones.every(b=>b.matrixWorld.elements.every(Number.isFinite)),length:Math.max(...rows.filter(r=>r.node.name!=='腰').map(r=>Math.abs(r.node.position.length()-r.p.length()))),cloth:adapter.cloth.snapshot()};};
    const probes=[];let offset=0;
    for(const phase of state.plan){for(const fraction of [.2,.5,.8]){lab.seek(offset+phase.duration*fraction);const before=sample();const epoch=player.epoch;const accepted=lab.cancel(false);const after=sample();let c0p=0,c0q=0;for(let i=0;i<rows.length;i++){c0p=Math.max(c0p,Math.hypot(...before.locals[i].p.map((v,k)=>v-after.locals[i].p[k])));let dot=0;for(let k=0;k<4;k++)dot+=before.locals[i].q[k]*after.locals[i].q[k];c0q=Math.max(c0q,2*Math.acos(Math.min(1,Math.abs(dot))));}player.pause(false);player.advance(.7);adapter.apply(player.pose());player.pause(true);const end=sample();probes.push({id:phase.id,fraction,accepted:accepted.accepted,c0p,c0q,finite:before.finite&&after.finite&&end.finite,maxLength:Math.max(before.length,after.length,end.length),state:player.state,oldEpoch:epoch,cloth:end.cloth});}offset+=phase.duration;}
    lab.restart();lab.pause(true);lab.seek(Math.min(1,state.plan[0].duration*.65));const pose=sample();const cursor=lab.snapshot().player.time;lab.player.advance(1);const pause=sample();const pausedFrozen=lab.snapshot().player.time===cursor&&JSON.stringify(pose.locals)===JSON.stringify(pause.locals);
    return {name:entry.name,id:entry.id,plan:state.plan,probes,pausedFrozen,adapter:adapter.snapshot(),passed:pausedFrozen&&probes.every(p=>p.accepted&&p.finite&&p.maxLength<1e-7&&p.c0p<1e-7&&p.c0q<1e-6)};
  },entry);report.cases.push(value);
    if(['Talk02','SitTalk01','Thinking01','Wuzui02'].includes(entry.name)){for(const view of ['front','side']){await page.evaluate(view=>window.nativeBehaviorLab.setView(view),view);const file=`${output}/browser-${entry.name}-${view}.png`;await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);}}
  }
  await page.evaluate(()=>{const lab=window.nativeBehaviorLab;const group=lab.groups.find(g=>g.name==='Talk02');return lab.select(group.id);});
  report.finishedAt=new Date().toISOString();report.passed=report.errors.length===0&&report.cases.length===names.length&&report.cases.every(c=>c.passed);return report;
}
