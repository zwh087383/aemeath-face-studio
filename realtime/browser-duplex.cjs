/** playwright-cli -s=duplex run-code --filename=realtime/browser-duplex.cjs
 * Set window.__duplexCase={name,directory,mode:'normal'|'barge'|'cancel'} first.
 * Uses real streamed input. No mock responses or automatic retries.
 */
async page => {
  const config = await page.evaluate(() => window.__duplexCase);
  if (!config?.directory || !/^[A-Za-z]:[\\/]/.test(config.directory) || !/^[a-z0-9-]+$/.test(config.name)) throw Error('invalid_case');
  await page.setViewportSize({width:1440,height:1080});
  await page.waitForFunction(() => window.__duplex?.ready);
  const result = await page.evaluate(async ({name,mode='normal',input=name}) => {
    const api=window.__duplex, start=performance.now(), before=api.snapshot().client.trials.length;
    const wait=async(predicate,timeout=45000)=>{
      const end=performance.now()+timeout;
      while(performance.now()<end){
        if(predicate())return;
        if(api.state.blocked)throw Error('usage_or_protocol_blocked');
        if(api.snapshot().client.trials.length>before && api.state.current?.error)throw Error(api.state.current.error);
        await new Promise(r=>setTimeout(r,40));
      }
      throw Error('acceptance_timeout');
    };
    let failure=null;
    api.startRecording(name);
    try {
      if(!api.state.ready)await api.connect();
      await api.fixture(input);
      await wait(()=>api.snapshot().client.trials.length>before && api.state.current?.playbackAt!==undefined);
      if(mode==='barge'){
        // Complete provider accounting first, interrupt still-playing audio.
        await wait(()=>api.state.current?.providerDoneAt!==undefined);
        if(api.state.audio.status!=='playing'||api.state.audio.queuedSeconds<2)throw Error('barge_window_missing');
        await api.fixture('barge');
        await wait(()=>api.snapshot().client.trials.length>before+1);
      } else if(mode==='cancel') {
        if(api.state.current?.providerDoneAt!==undefined)throw Error('remote_cancel_window_missing');
        api.cancel();
        await new Promise(r=>setTimeout(r,10000));
      }
      if(mode!=='cancel')await wait(()=>api.state.current?.settledAt!==undefined);
      await new Promise(r=>setTimeout(r,800));
    } catch(error){failure=error.message;}
    const recording=await api.stopRecording();
    window.__duplexCaseReport={name,mode,start,ended:performance.now(),failure,recording,...api.snapshot()};
    const trials=window.__duplexCaseReport.client.trials.slice(before);
    return {name,mode,failure,recording,trials:trials.map(t=>({id:t.id,text:t.text,transcript:t.transcript,
      context:t.context?.syntheticFactsPresent,preparationMs:t.context?.preparationMs,
      inputEndToPlaybackMs:t.playbackAt-t.input?.lastSpeechAt,requestToPlaybackMs:t.playbackAt-t.requestAt,
      motionAfterPlaybackMs:t.motionAt-t.playbackAt,expressionAfterPlaybackMs:t.expressionAt-t.playbackAt,
      calls:t.tools.map(c=>({plan:c.event.arguments,result:c.result})),settled:t.settledAt!==undefined,revoked:t.revoked,error:t.error})),
      budget:api.snapshot().client.budget,interruptions:api.snapshot().client.interruptions};
  },config);
  const save=async(kind,path)=>{
    const download=page.waitForEvent('download');
    await page.evaluate(async kind=>{
      const blob=kind==='video'?new Blob([Uint8Array.from(atob(await window.__duplex.videoBase64()),c=>c.charCodeAt(0))],{type:'video/webm'}):
        new Blob([JSON.stringify(window.__duplexCaseReport,null,2)],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=kind==='video'?'recording.webm':'browser.json';a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    },kind);
    await(await download).saveAs(path);
  };
  await save('report',`${config.directory}/${config.name}-browser.json`);
  await save('video',`${config.directory}/${config.name}.webm`);
  await page.screenshot({path:`${config.directory}/${config.name}.png`});
  return result;
}
