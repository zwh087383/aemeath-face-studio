async page => {
  await page.waitForFunction(()=>window.idleActivityDemo?.snapshot().ready,null,{timeout:60000});
  const result=await page.evaluate(()=>{
    const api=window.idleActivityDemo;api.setManualClock(true);
    const rows=[];
    for(const at of [.2,.9,2.0,3.4,5.1]){
      api.motion.setMode('idle');for(let i=0;i<100;i++)api.step(1/30);
      api.motion.clearCheckpoint();api.motion.setMode('working');
      for(let t=0;t<at-1e-8;t+=1/60)api.step(Math.min(1/60,at-t));
      const before=api.motion.player.pose().map(p=>({p:p.p.clone(),q:p.q.clone()}));
      const entry=api.motion.player.snapshot();
      api.motion.setMode('listening');
      const after=api.motion.player.pose();
      const jump=Math.max(...before.map((p,i)=>p.p.distanceTo(after[i].p)));
      const angle=Math.max(...before.map((p,i)=>p.q.angleTo(after[i].q)));
      for(let i=0;i<180;i++)api.step(1/60);
      if(api.motion.mode!=='listening')throw Error('No listening exit at '+at);
      const checkpoint=structuredClone(api.motion.checkpoint);
      api.motion.setMode('working');api.step(0);
      const resume=api.motion.snapshot();
      if(!resume.transitions.at(-1).resumed)throw Error('Checkpoint lost at '+at);
      for(let i=0;i<90;i++)api.step(1/60);
      const bones=api.mesh.skeleton.bones;
      if(!bones.every(b=>Array.from(b.matrixWorld.elements).every(Number.isFinite)))throw Error('Nonfinite real PMX');
      if(jump>1e-7||angle>1e-6)throw Error('Immediate pose discontinuity');
      rows.push({at,entryPhase:entry.phase,jump,angle,checkpoint,resumeSource:resume.phase.id,
        cloth:api.motion.snapshot().adapter.cloth.active});
    }
    api.motion.setMode('complete');for(let i=0;i<180;i++)api.step(1/60);
    if(api.motion.checkpoint!==null)throw Error('Completed work checkpoint survived');
    api.setManualClock(false);
    return {passed:true,rows,actualPmx:true,sourceSpeed:api.motion.snapshot().sourceSpeed,
      scope:'Five source-phase interrupts, same-frame continuity, native End exit and saved phase resumption. Finite real PMX matrices and native cloth; not whole-body collision or visual aesthetics.'};
  });
  const download=page.waitForEvent('download');
  await page.evaluate(value=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download='phase-interruptions.json';a.click();},result);
  await (await download).saveAs('outputs/idle-activity-demo-20261024/phase-interruptions.json');
  return result;
}
