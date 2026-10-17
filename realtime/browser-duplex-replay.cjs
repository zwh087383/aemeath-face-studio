/** Local saved-event regression. Never opens a provider connection. */
async page => {
  await page.waitForFunction(()=>window.__duplex?.savedCount>0);
  const index=await page.evaluate(()=>window.__duplexReplayIndex??0);
  const evidence=await page.evaluate(async index=>{
    const api=window.__duplex,before=await(await fetch('/api/duplex/status')).json();
    const first=await api.replay(index),second=await api.replay(index);
    const run=api.replay(index),deadline=performance.now()+15000;
    while(performance.now()<deadline&&!(api.state.audio.sourceActive&&api.state.current?.motionAt!==undefined&&api.state.audio.time >= (index ? .65 : 0)))
      await new Promise(r=>setTimeout(r,20));
    api.cancel();const interrupted=await run;
    await new Promise(r=>setTimeout(r,1800));
    const final=api.snapshot(),after=await(await fetch('/api/duplex/status')).json();
    const result={source:'saved_native_events_only',first:first.audio.status,second:second.audio.status,
      firstCall:first.client.trials[0]?.tools[0]?.result.localCallId,secondCall:second.client.trials[0]?.tools[0]?.result.localCallId,
      interrupt:final.client.interruptions.at(-1),audio:final.audio,
      noProviderCall:before.budget.responses===after.budget.responses&&!after.connected,
      noSettlement:!final.client.trials.some(t=>t.ackSentAt!==undefined||t.settledAt!==undefined)};
    result.passed=result.first==='ended'&&result.second==='ended'&&result.firstCall!==result.secondCall
      &&result.noProviderCall&&result.noSettlement&&result.audio.sourceCount===0&&result.interrupt?.sourcesBefore>0;
    return result;
  },index);
  const download=page.waitForEvent('download');
  await page.evaluate(data=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='replay-regression.json';a.click();},evidence);
  await(await download).saveAs(`F:/AI-Shared/model_test/face/outputs/qwen-duplex-d-20261017/replay-${index?'wave-':''}regression.json`);
  return evidence;
}
