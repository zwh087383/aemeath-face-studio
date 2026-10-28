async page => {
 await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready,null,{timeout:120000});
 const result=await page.evaluate(async()=>{
  const a=window.motionLibrary;a.setManual(true);await a.inspect('action:chin_tap');
  const frames=[];
  for(let i=0;i<240;i++){const s=a.step(1/60,i%12===0);if(i%30===0)frames.push({time:s.now,body:s.body.active?.action,phase:s.actorState.phase,events:s.body.events.slice(-2),supported:s.supported});}
  return {frames,fault:a.snapshot().fault};
 });
 await page.screenshot({path:'outputs/library-expansion-20261027/chin-complete.png'});
 return result;
}
