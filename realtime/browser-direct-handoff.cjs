/** Offline fixture only: real WebAudio/rendering, synthetic Qwen handoff. */
async page => {
  await page.waitForFunction(()=>window.__duplex?.savedCount>0);
  const config=await page.evaluate(()=>window.__duplexReplayConfig);
  if(!config?.directory||!/^[A-Za-z]:[\\/]/.test(config.directory))throw Error('explicit_output_required');
  const evidence=await page.evaluate(async()=>{
    const api=window.__duplex,service=await(await fetch('/api/duplex/status')).json();
    if(!service.offline||service.connected)throw Error('offline_service_required');
    api.startRecording('离线分段协议演示');
    const complete=await api.replay(0),recording=await api.stopRecording();
    const t=complete.client.trials[0],second=t.tools.find(r=>r.segmentIndex===1);
    return {source:'synthetic_handoff_protocol_with_previously_saved_pcm',newCloudResponses:0,
      offline:true,recording,audio:complete.audio,segments:t.segments.map(s=>({index:s.index,frames:s.frames,startFrame:s.startFrame,phase:s.phase})),
      secondAction:second?{receivedAt:second.at,dispatchedAt:second.dispatchedAt,scheduledMediaTime:second.result.at,
        segmentStart:t.segments[1].startFrame/24000,accepted:second.result.accepted}:null,
      noHistoryAck:t.ackSentAt===undefined&&t.settledAt===undefined,
      passed:complete.audio.status==='ended'&&t.segments.length===2&&second?.result.accepted===true
        &&second.result.at>=t.segments[1].startFrame/24000&&t.ackSentAt===undefined&&t.settledAt===undefined};
  });
  async function video(name) {
    const download=page.waitForEvent('download');
    await page.evaluate(async()=>{const blob=new Blob([Uint8Array.from(atob(await window.__duplex.videoBase64()),c=>c.charCodeAt(0))],{type:'video/webm'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='offline.webm';a.click();},null);
    await(await download).saveAs(`${config.directory}/${name}.webm`);
  }
  await video('direct-offline-complete');
  const interruption=await page.evaluate(async()=>{
    const api=window.__duplex;api.startRecording('离线第二段打断');
    const replay=api.replay(0),deadline=performance.now()+18000;
    while(performance.now()<deadline&&!(api.state.audio.sourceActive&&api.state.current?.segments.length===2
      &&api.state.audio.time>=api.state.current.segments[1].startFrame/24000+.3
      &&api.state.motion.gestures.some(g=>!g.recovering)))await new Promise(r=>setTimeout(r,20));
    api.cancel();await replay;await new Promise(r=>setTimeout(r,1800));
    const after=api.snapshot(),recording=await api.stopRecording();
    return {recording,interrupt:after.client.interruptions.at(-1),audio:after.audio,
      noHistoryAck:after.client.trials.every(t=>t.ackSentAt===undefined&&t.settledAt===undefined)};
  });
  await video('direct-offline-interrupt');
  evidence.interruption=interruption;
  evidence.passed&&=interruption.noHistoryAck&&interruption.interrupt.activeMotion&&interruption.interrupt.sourcesBefore>0
    &&interruption.audio.sourceCount===0&&interruption.interrupt.mouthClosedMs<100&&interruption.interrupt.motionStoppedMs<1500;
  const download=page.waitForEvent('download');
  await page.evaluate(data=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='direct-browser-evidence.json';a.click();},evidence);
  await(await download).saveAs(`${config.directory}/direct-browser-evidence.json`);
  await page.screenshot({path:`${config.directory}/direct-browser-preview.png`});
  return evidence;
}
