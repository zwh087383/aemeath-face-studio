async page => {
  await page.setViewportSize({width:1440,height:1000});
  await page.reload();
  await page.waitForFunction(()=>window.nativeMotion?.snapshot().ready,{},{timeout:90000});
  await page.evaluate(()=>{window.nativeMotion.pause(true);window.nativeMotion.seek(0);window.nativeMotion.setView('angle');});
  await page.screencast.start({path:'outputs/native-motion-20261022/comparison.webm',size:{width:1440,height:1000}});
  await page.evaluate(()=>window.nativeMotion.pause(false));
  await page.waitForTimeout(8300);
  await page.screencast.stop();
  return await page.evaluate(()=>{window.nativeMotion.pause(true);return {time:window.nativeMotion.snapshot().time,clip:window.nativeMotion.snapshot().sourceName};});
}
