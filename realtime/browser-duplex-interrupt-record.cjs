/** Record cancellation of saved real speech/actions. No provider connection. */
async page => {
  await page.waitForFunction(()=>window.__duplex?.savedCount>0);
  const config=await page.evaluate(()=>window.__duplexReplayConfig);
  if(!config?.directory||!/^[A-Za-z]:[\\/]/.test(config.directory))throw Error('explicit_replay_output_required');
  if(!/^[a-z0-9-]+$/.test(config.name??'saved-wave-interrupt'))throw Error('invalid_recording_name');
  const result=await page.evaluate(async({index=0,interrupt=true,name='saved-wave-interrupt'})=>{
    const api=window.__duplex,before=await(await fetch('/api/duplex/status')).json();
    if(before.connected)throw Error('live_session_must_be_disconnected');
    api.startRecording(name);
    const replay=api.replay(index),deadline=performance.now()+15000;
    let active=false;
    if(interrupt){
      while(performance.now()<deadline&&!(api.state.audio.sourceActive&&api.state.motion.gestures.some(g=>!g.recovering)&&api.state.audio.time>=1.4))
        await new Promise(r=>setTimeout(r,20));
      active=api.state.audio.sourceActive&&api.state.motion.gestures.some(g=>!g.recovering);
      api.cancel();
    }
    await replay;await new Promise(r=>setTimeout(r,1800));
    const recording=await api.stopRecording(),after=await(await fetch('/api/duplex/status')).json();
    return {source:'saved_real_events_no_cloud',activeAtInterrupt:active,interrupted:interrupt,recording,
      interruption:api.snapshot().client.interruptions.at(-1),
      noProviderCall:before.budget.responses===after.budget.responses&&!after.connected};
  },config);
  for(const kind of ['json','webm']){
    const download=page.waitForEvent('download');
    await page.evaluate(async({kind,result})=>{
      const blob=kind==='webm'?new Blob([Uint8Array.from(atob(await window.__duplex.videoBase64()),c=>c.charCodeAt(0))],{type:'video/webm'}):
        new Blob([JSON.stringify(result,null,2)],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`saved-wave-interrupt.${kind}`;a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    },{kind,result});
    await(await download).saveAs(`${config.directory}/${config.name??'saved-wave-interrupt'}.${kind}`);
  }
  await page.screenshot({path:`${config.directory}/${config.name??'saved-wave-interrupt'}.png`});
  return result;
}
