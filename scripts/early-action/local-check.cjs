async page => {
  await page.waitForFunction(() => window.earlyAction?.ready);
  const evidence = [];
  for (const cancelMs of [190, 1150, null]) {
    const result = await page.evaluate(async cancelMs => {
      const api=window.earlyAction, id='offline-'+String(cancelMs), samples=new Int16Array(48000);
      for(let i=0;i<samples.length;i++)samples[i]=Math.round(3000*Math.sin(i*2*Math.PI*190/24000));
      let binary='';for(const v of new Uint8Array(samples.buffer))binary+=String.fromCharCode(v);
      const tool={type:'tool',atMs:40,responseId:id,name:'perform_avatar',callId:'one',arguments:'{"expression":"smile","gesture":"greet"}',plan:{expression:'smile',gesture:'greet'}};
      const events=[{type:'request_sent',atMs:0},{type:'response_created',atMs:10,responseId:id},tool,
        {type:'non_silent_pcm',atMs:750,responseId:id,frame:1},{type:'audio',atMs:751,responseId:id,delta:btoa(binary)},
        {type:'complete',atMs:800,result:{completed:true,metrics:{offlineFixture:true}}}];
      let oldToolResult;
      const pending=api.runCase('greet-r1-C',{localEvents:events});
      while(!api.active||api.state.run.requestAt===undefined)await new Promise(r=>setTimeout(r,5));
      if(cancelMs!==null)setTimeout(()=>{api.cancel('offline_phase_probe',false);setTimeout(()=>{api.accept({...tool,callId:'late'});oldToolResult=api.state.run.tools.at(-1).result;},40);},cancelMs);
      const result=await pending;
      return {cancelMs,result,report:api.report,oldToolResult};
    },cancelMs);
    evidence.push(result);
    if(result.report.failure)throw Error(result.report.failure);
    if(cancelMs===null){
      if(!(result.report.latency.bodyLeadMs>100))throw Error('Body did not visibly prepare before playback');
      if(!(result.report.latency.faceLeadMs>100))throw Error('Face did not visibly prepare before playback');
      const ages=result.report.trace.flatMap(t=>t.gestures.filter(g=>g.gesture==='greet').map(g=>g.age));
      if(!ages.some(a=>a>1))throw Error('Gesture did not continue beyond preparation');
    }else{
      if(result.oldToolResult?.accepted!==false)throw Error('Old tool revived after interrupt');
      if(result.report.finalAudio.sourceCount!==0)throw Error('Audio source survived cancel');
      if(result.report.finalMotion.gestures.length)throw Error('Gesture did not retract');
      if(cancelMs===190&&result.report.latency.voiceMs!==null)throw Error('Pre-voice cancellation spoke');
    }
  }
  console.log(JSON.stringify(evidence.map(x=>({cancelMs:x.cancelMs,latency:x.report.latency,interrupt:x.report.interrupt,stale:x.oldToolResult,performance:x.report.performance})),null,2));
}
