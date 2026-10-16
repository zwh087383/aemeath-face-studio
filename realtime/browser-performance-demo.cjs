async page => {
  const directory = await page.evaluate(() => window.__performanceVisualConfig?.directory);
  if (!directory || !/^[A-Za-z]:[\\/]/.test(directory)) throw new Error('Set an absolute output directory');
  await page.waitForFunction(() => window.performanceLab?.ready);
  await page.evaluate(() => { const l = window.performanceLab; l.stop(); l.setOptions({ natural:true, expression:true, speech:false, speed:1, intensity:1 }); l.setView('angle'); });
  await page.waitForFunction(() => !window.performanceLab.snapshot().motion.gestures.length);
  const path = `${directory}/expressive-motion-demo.webm`, observations = [];
  await page.screencast.start({ path, size:{width:1440,height:1000} });
  try {
    await page.locator('[data-story="greeting"]').click();
    for (const id of ['greet','bow_smile','laugh','agree']) {
      await page.waitForFunction(id => window.performanceLab.snapshot().motion.gestures.some(g => g.gesture===id && g.phase==='hold' && !g.recovering), id, {timeout:12000});
      observations.push(await page.evaluate(() => window.performanceLab.snapshot()));
    }
    await page.locator('[data-view="side"]').click();
    await page.evaluate(() => window.performanceLab.play('look_up'));
    await page.waitForFunction(() => window.performanceLab.snapshot().motion.gestures.some(g=>g.gesture==='look_up'&&g.phase==='hold'));
    await page.locator('[data-view="angle"]').click();
    await page.locator('#hero').click();
    await page.waitForFunction(() => window.performanceLab.snapshot().motion.gestures.some(g=>g.gesture==='bow_smile'&&g.phase==='stroke'));
    observations.push(await page.evaluate(() => window.performanceLab.snapshot()));
    await page.locator('#stop').click();
    await page.waitForFunction(() => !window.performanceLab.snapshot().motion.gestures.length);
    await page.waitForTimeout(900);
    await page.screenshot({path:`${directory}/preview-page.png`});
    const result={path,observations,boundary:'Silent local PMX screen recording. Not a performance measurement, cloud reply or physical audio recording.'};
    await page.evaluate(result=>{window.__performanceDemo=result;},result);
    return {path,observations:observations.length,error:await page.evaluate(()=>window.performanceLab.snapshot().error)};
  } finally { await page.screencast.stop(); }
}
