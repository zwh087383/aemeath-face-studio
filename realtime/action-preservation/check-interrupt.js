async page => {
  await page.waitForFunction(()=>window.comparison?.ready===true,null,{timeout:120000});
  await page.evaluate(()=>window.comparison.load('short-03',24));
  await page.evaluate(()=>{window.comparison.setView('angle');window.comparison.advance(24.1);});
  await page.locator('.columns').screenshot({path:'outputs/action-preservation-20261028/before-interrupt-angle.png'});
  const before=await page.evaluate(()=>window.comparison.result());
  if(before.engines[1].active!=='gesture:comfort')throw Error('target_not_active_before_interrupt');
  const cancelled=await page.evaluate(()=>window.comparison.interrupt());
  if(cancelled.interruption.after.some(e=>e.active||e.pending))throw Error('interruption_kept_old_work');
  const after=await page.evaluate(()=>window.comparison.advance(26));
  if(after.engines.some(e=>e.active||e.submissions.some(s=>s.videoSeconds>24.1&&s.result.accepted)))throw Error('old_command_resurrected');
  await page.locator('.columns').screenshot({path:'outputs/action-preservation-20261028/after-interrupt-angle.png'});
  return {before,cancelled,after,checks:{activeWasPreserved:true,interruptionCancelledImmediately:true,lateCommandRejected:true}};
}
