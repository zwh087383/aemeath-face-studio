async page => {
  await page.waitForFunction(() => window.comparison?.ready === true, null, { timeout: 120000 });
  const id = await page.evaluate(() => window.comparison.result().id);
  await page.evaluate(() => {
    window.reviewRecorders = ['old','new'].map(name => {
      const canvas = document.querySelector(`#${name}-stage canvas`), stream = canvas.captureStream(30), chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType:'video/webm;codecs=vp9', videoBitsPerSecond:2200000 });
      recorder.ondataavailable = e => { if(e.data.size)chunks.push(e.data); };
      recorder.start(); return { name, recorder, stream, chunks };
    });
    window.comparison.play();
  });
  const captures = [];
  for (let i=0; i<5; i++) {
    await page.waitForTimeout(1400);
    const state = await page.evaluate(() => {
      const r=window.comparison.result();return {position:r.position,error:r.error,engines:r.engines.map(e=>({name:e.name,active:e.active,target:e.target}))};
    });
    await page.locator('.columns').screenshot({path:`outputs/action-preservation-20261028/${id}-front-${i}.png`});
    captures.push(state);
  }
  await page.waitForFunction(() => window.comparison.result().playing === false, null, { timeout:30000 });
  for (const name of ['old','new']) {
    const pending = page.waitForEvent('download');
    await page.evaluate(async name => {
      const row=window.reviewRecorders.find(r=>r.name===name);
      await new Promise(resolve=>{row.recorder.onstop=resolve;row.recorder.stop();});
      row.stream.getTracks().forEach(track=>track.stop());
      const blob=new Blob(row.chunks,{type:'video/webm'}),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=`${name}.webm`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    },name);
    const file = await pending;
    await file.saveAs(`outputs/action-preservation-20261028/${id}-${name}-original-speed.webm`);
  }
  return {id, captures, result:await page.evaluate(()=>window.comparison.result()), audioRecorded:false};
}
