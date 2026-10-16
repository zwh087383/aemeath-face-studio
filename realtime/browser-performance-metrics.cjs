async page => {
  await page.waitForFunction(() => window.performanceLab?.ready);
  await page.evaluate(() => { const l=window.performanceLab; l.setView('body'); l.setOptions({natural:true,expression:true,speech:false,speed:1,intensity:1}); l.playStory('all'); });
  await page.waitForTimeout(1500);
  const result = await page.evaluate(async () => {
    const l=window.performanceLab, rows=[], start=performance.now();
    l.resetMetrics();
    await new Promise(resolve => {
      let previous=null;
      function sample(now) {
        const s=l.snapshot();
        if (previous!==null) rows.push({interval:now-previous,driver:s.rendered.driverMs,render:s.rendered.renderMs,frame:s.rendered.frame,finite:s.rendered.finite,gesture:s.motion.gestures.find(g=>!g.recovering)?.gesture});
        previous=now;
        if(now-start>=15000) resolve(); else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    const stats=key=>{const a=rows.map(r=>r[key]).sort((a,b)=>a-b); return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
    return {generatedAt:new Date().toISOString(),environment:l.snapshot().environment,viewport:{width:innerWidth,height:innerHeight,ratio:devicePixelRatio},frames:rows.length,
      elapsedMs:rows.reduce((n,r)=>n+r.interval,0),fps:1000*rows.length/rows.reduce((n,r)=>n+r.interval,0),driverMs:stats('driver'),renderSubmissionMs:stats('render'),frameIntervalMs:stats('interval'),allFinite:rows.every(r=>r.finite),gestures:[...new Set(rows.map(r=>r.gesture))],error:l.snapshot().error,
      boundary:'Local Chrome test browser; headless mode is recorded in userAgent; other test browsers closed; no screen recording, cloud, audio, microphone or clothing physics. Browser-frame rate and CPU submission timings, not physical display or GPU-finished latency.',rows};
  });
  await page.evaluate(result=>{window.__performanceMetrics=result;},result);
  const {rows,...summary}=result;
  return summary;
}
