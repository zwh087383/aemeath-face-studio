async page => {
  await page.waitForFunction(()=>window.nativeBehaviorLab?.snapshot().ready,{timeout:60000});
  const cases=[];
  for(const [name,view,waitMs,useEnd] of [['Talk02','front',12000,null],['Thinking01','side',3100,false],['DZ_Liaotoufa01','side',1800,false],['Talk02','front',3000,true]]){
    await page.evaluate(async ({name,view})=>{const lab=window.nativeBehaviorLab,group=lab.groups.find(g=>g.name===name);await lab.select(group.id);lab.setView(view);lab.restart();lab.pause(false);},{name,view});
    await page.waitForTimeout(waitMs);const before=await page.evaluate(()=>window.nativeBehaviorLab.snapshot());const cancelled=useEnd===null?null:await page.evaluate(useEnd=>window.nativeBehaviorLab.cancel(useEnd),useEnd);const afterWait=useEnd===true?Math.ceil((Math.max(...before.plan.filter(p=>p.phase==='end').map(p=>p.duration),0)+.6)*1000):useEnd===null?0:1400;if(afterWait)await page.waitForTimeout(afterWait);const after=await page.evaluate(()=>window.nativeBehaviorLab.snapshot());cases.push({name,view,waitMs,useEnd,before,cancelled,after});
  }
  const final=await page.evaluate(()=>{const lab=window.nativeBehaviorLab;lab.pause(true);return lab.snapshot();});return {schema:1,recordedAt:new Date().toISOString(),cases,final,note:'Real-time rendering and cancellation movie is playback evidence, not completed human aesthetic acceptance.'};
}
