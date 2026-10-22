async page => {
  await page.setViewportSize({width:1440,height:1000});
  await page.reload();
  await page.waitForFunction(()=>window.nativeMotion?.snapshot().ready,{},{timeout:90000});
  const before=await page.evaluate(()=>{window.nativeMotion.pause(true);return window.nativeMotion.seek(1);});
  await page.setViewportSize({width:1400,height:980});await page.waitForTimeout(150);
  const after=await page.evaluate(()=>window.nativeMotion.snapshot());
  if(after.time!==before.time||after.frame<=before.frame)throw Error('Paused resize failed to redraw the frozen pose');
  await page.setViewportSize({width:1440,height:1000});
  for(const view of ['front','side','back','angle']){
    await page.evaluate(v=>window.nativeMotion.setView(v),view);
    if(await page.locator('[data-view="'+view+'"]').getAttribute('aria-pressed')!=='true')throw Error('View label is out of sync');
  }
  await page.evaluate(()=>{window.nativeMotion.pause(true);window.nativeMotion.seek(0);window.nativeMotion.setView('angle');});
  await page.screencast.start({path:'outputs/native-motion-20261022/comparison.webm',size:{width:1440,height:1000}});
  await page.evaluate(()=>window.nativeMotion.pause(false));
  await page.waitForTimeout(8300);
  await page.screencast.stop();
  return await page.evaluate(()=>{window.nativeMotion.pause(true);return {time:window.nativeMotion.snapshot().time,clip:window.nativeMotion.snapshot().sourceName};});
}
