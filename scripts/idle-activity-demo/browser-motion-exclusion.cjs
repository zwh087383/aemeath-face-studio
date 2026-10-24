async page => {
  await page.waitForFunction(()=>window.idleActivityDemo?.snapshot().ready,null,{timeout:60000});
  const result=await page.evaluate(()=>{
    const api=window.idleActivityDemo;api.setManualClock(true);
    const rows=[],seen=new Set();
    const step=seconds=>{for(let t=0;t<seconds-1e-8;t+=1/60){api.step(Math.min(1/60,seconds-t));seen.add(api.motion.plan[api.motion.player.index].id);}};
    const reject=id=>{
      const serial=api.motion.serial;
      let error='';try{api.motion.replace([{id,phase:'loop',duration:4,sourceAsset:'Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/Stand2.uasset'}],'idle');}catch(e){error=e.message;}
      if(!error.includes('User-excluded motion')||api.motion.serial!==serial)throw Error('Excluded replacement changed playback');
      return error;
    };
    const rejected=[reject('body-stand2-84d0c0a158'),reject('renamed-stand')];
    for(const [at,mode] of [[.2,'listening'],[.9,'paused'],[2,'complete'],[3.4,'idle'],[5.1,'listening']]){
      api.motion.setMode('idle');step(3);api.motion.clearCheckpoint();api.motion.setMode('working');step(at);
      const before=api.motion.player.pose().map(p=>({p:p.p.clone(),q:p.q.clone()}));
      const entry=api.motion.player.snapshot();api.motion.setMode(mode);
      const after=api.motion.player.pose();
      const jump=Math.max(...before.map((p,i)=>p.p.distanceTo(after[i].p)));
      const angle=Math.max(...before.map((p,i)=>p.q.angleTo(after[i].q)));
      step(3);
      if(api.motion.mode!==mode||api.motion.plan[0].id!=='aimisi-stand01')throw Error('Rest choice regressed: '+mode);
      if(jump>1e-7||angle>1e-6)throw Error('Immediate pose discontinuity');
      if(!api.mesh.skeleton.bones.every(b=>Array.from(b.matrixWorld.elements).every(Number.isFinite)))throw Error('Nonfinite PMX');
      const checkpoint=structuredClone(api.motion.checkpoint);
      api.motion.setMode('working');step(.1);
      if(['listening','paused'].includes(mode)&&!api.motion.transitions.at(-1).resumed)throw Error('Checkpoint lost');
      rows.push({at,mode,entryPhase:entry.phase,jump,angle,checkpoint,cloth:api.motion.snapshot().adapter.cloth.active});
    }
    api.motion.setMode('idle');step(3);
    const bones=api.mesh.skeleton.bones;
    const joint=name=>{const b=bones.find(b=>b.name===name);return b.getWorldPosition(b.position.clone());};
    const chest=()=>joint('上半身2').y;
    let minHandBelowChest=Infinity;
    for(let i=0;i<480;i++){api.step(1/60);for(const name of ['左手首','右手首'])minHandBelowChest=Math.min(minHandBelowChest,chest()-joint(name).y);}
    if(!(minHandBelowChest>0))throw Error('Resting hand rises to chest');
    if(seen.has('body-stand2-84d0c0a158'))throw Error('Excluded source sampled');
    api.setManualClock(false);
    return {passed:true,rows,rejected,seen:[...seen],restSource:api.motion.snapshot().restSource,
      minHandBelowChest,bodyAmplitude:1,sourceSpeed:1,actualPmx:true,
      scope:'Current independent demo: rest/loop/pause/listening/complete/resume and negative source-injection checks. No global archive removal, cloud, real microphone or full autonomous director claim.'};
  });
  const download=page.waitForEvent('download');
  await page.evaluate(value=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download='motion-exclusion.json';a.click();},result);
  await (await download).saveAs('outputs/character-director-plan-20261024/motion-exclusion.json');
  await page.screenshot({path:'outputs/character-director-plan-20261024/stand01-front.png'});
  await page.evaluate(()=>window.idleActivityDemo.setView('side'));
  await page.screenshot({path:'outputs/character-director-plan-20261024/stand01-side.png'});
  await page.evaluate(()=>window.idleActivityDemo.setView('front'));
  return result;
}
