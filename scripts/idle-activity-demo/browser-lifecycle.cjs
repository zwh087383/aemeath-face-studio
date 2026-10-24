async page => {
  await page.waitForFunction(()=>window.idleActivityDemo?.snapshot().ready,null,{timeout:60000});
  await page.evaluate(()=>{
    const api=window.idleActivityDemo;window.idleReview={started:Date.now(),checks:[],samples:0,maxFrameBoneMove:0,last:null};
    const chunks=[],canvas=document.querySelector('#stage canvas'),stream=canvas.captureStream(30);
    const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
    const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2400000});
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    window.idleRecording={recorder,chunks,stream};recorder.start(500);
    const observe=()=>{
      const review=window.idleReview;if(review.stopped)return;
      const bones=api.mesh.skeleton.bones;
      const points=bones.filter(b=>['頭','腰','左ひじ','右ひじ','左手首','右手首'].includes(b.name)).map(b=>Array.from(b.matrixWorld.elements));
      if(!points.flat().every(Number.isFinite))review.error='nonfinite bone matrix';
      if(review.last)review.maxFrameBoneMove=Math.max(review.maxFrameBoneMove,...points.map((p,i)=>Math.hypot(...[12,13,14].map(j=>p[j]-review.last[i][j]))));
      review.last=points;review.samples++;requestAnimationFrame(observe);
    };requestAnimationFrame(observe);
  });
  await page.evaluate(()=>window.idleActivityDemo.command('start'));
  await page.waitForTimeout(1900);
  await page.screenshot({path:'outputs/idle-activity-demo-20261024/working.png'});
  const paused=await page.evaluate(async()=>{
    const api=window.idleActivityDemo;await api.command('pause');return {backend:api.snapshot().backend.progress,motion:api.snapshot().motion};
  });
  await page.waitForTimeout(2200);
  const held=await page.evaluate(()=>({backend:window.idleActivityDemo.snapshot().backend.progress,motion:window.idleActivityDemo.snapshot().motion}));
  if(held.backend!==paused.backend)throw Error('Paused real work progressed');
  if(held.motion.mode!=='paused')throw Error('Body failed native exit on pause: '+held.motion.mode);
  await page.evaluate(()=>window.idleActivityDemo.command('resume'));
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().backend.task.status==='running',null,{timeout:7000});
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().motion.mode==='working',null,{timeout:4000});
  const resumed=await page.evaluate(()=>window.idleActivityDemo.snapshot().motion);
  if(!resumed.transitions.at(-1).resumed)throw Error('Resume did not preserve source phase offset');
  await page.waitForTimeout(900);
  // Exercise the real AudioContext -> analyser -> detector -> backend path with
  // a synthetic, inaudible input stream; this is not physical microphone proof.
  await page.evaluate(()=>{
    const ctx=new AudioContext(),osc=ctx.createOscillator(),gain=ctx.createGain(),out=ctx.createMediaStreamDestination();
    osc.frequency.value=210;gain.gain.value=0;osc.connect(gain).connect(out);osc.start();
    window.syntheticMic={ctx,osc,gain,out,original:navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)};
    navigator.mediaDevices.getUserMedia=async()=>out.stream;
  });
  await page.click('#mic');
  await page.evaluate(async()=>{await window.syntheticMic.ctx.resume();window.syntheticMic.gain.gain.value=.09;window.idleReview.voiceAt=performance.now();});
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().backend.engaged,null,{timeout:5000});
  const attention=await page.evaluate(()=>{const s=window.idleActivityDemo.snapshot();return {ackMs:performance.now()-window.idleReview.voiceAt,scheduler:s.scheduler.mode,backend:s.backend.task.status};});
  await page.waitForTimeout(800);
  await page.evaluate(()=>window.syntheticMic.gain.gain.value=0);
  await page.waitForTimeout(1700);
  const listening=await page.evaluate(()=>window.idleActivityDemo.snapshot());
  if(!listening.backend.engaged||listening.backend.task.status!=='paused'||listening.scheduler.mode!=='listening')throw Error('Silence incorrectly resumed activity');
  await page.screenshot({path:'outputs/idle-activity-demo-20261024/listening.png'});
  await page.click('#mic');
  await page.evaluate(async()=>{window.syntheticMic.osc.stop();await window.syntheticMic.ctx.close();navigator.mediaDevices.getUserMedia=window.syntheticMic.original;});
  await page.evaluate(()=>window.idleActivityDemo.command('conversation-end'));
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().backend.task.status==='running',null,{timeout:7000});
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().backend.task.status==='done',null,{timeout:30000});
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().motion.mode==='complete',null,{timeout:5000});
  const report=await page.evaluate(async()=>{
    window.idleReview.stopped=true;
    const recording=window.idleRecording;
    await new Promise(resolve=>{recording.recorder.onstop=resolve;recording.recorder.stop();});
    recording.stream.getTracks().forEach(t=>t.stop());
    recording.blob=new Blob(recording.chunks,{type:'video/webm'});
    const s=window.idleActivityDemo.snapshot();
    const sorted=s.timings.samples.map(x=>x.driverMs).sort((a,b)=>a-b);
    return {passed:s.errors.length===0&&!window.idleReview.error,elapsedMs:Date.now()-window.idleReview.started,
      samples:window.idleReview.samples,maxFrameBoneMove:window.idleReview.maxFrameBoneMove,
      backend:{status:s.backend.task.status,provider:s.backend.provider,progress:s.backend.progress,total:s.backend.total,artifactId:s.backend.artifact?.id,
        sessionId:s.backend.sessionId,generation:s.backend.generation,sourceHash:s.backend.sourceHash,events:s.backend.events,integration:s.backend.integration},
      motion:s.motion,errors:s.errors,videoBytes:recording.blob.size,driverP95:sorted[Math.floor(sorted.length*.95)],startup:s.timings.startup};
  });
  if(!report.passed||!report.backend.artifactId||report.backend.progress!==report.backend.total)throw Error('Incomplete actual lifecycle');
  const downloadPromise=page.waitForEvent('download');
  await page.evaluate(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(window.idleRecording.blob);a.download='idle-activity-lifecycle.webm';a.click();});
  await (await downloadPromise).saveAs('outputs/idle-activity-demo-20261024/idle-activity-lifecycle.webm');
  await page.screenshot({path:'outputs/idle-activity-demo-20261024/complete.png'});
  await page.click('#artifact');
  await page.screenshot({path:'outputs/idle-activity-demo-20261024/artifact.png'});
  await page.click('#close-result');
  const result={...report,paused:{progress:paused.backend,phase:paused.motion.checkpoint},held:{progress:held.backend,mode:held.motion.mode},
    resumed:resumed.transitions.at(-1),attention,scope:'Actual PMX, native clothing, real WAI planner/artifacts in isolated data; synthetic AudioContext input, no cloud, ASR, physical microphone or aesthetic verdict.'};
  const receiptDownload=page.waitForEvent('download');
  await page.evaluate(value=>{window.idleFinalReceipt=value;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download='lifecycle.json';a.click();},result);
  await (await receiptDownload).saveAs('outputs/idle-activity-demo-20261024/lifecycle.json');
  return {passed:result.passed,elapsedMs:result.elapsedMs,samples:result.samples,videoBytes:result.videoBytes,driverP95:result.driverP95,attention:result.attention,artifactId:result.backend.artifactId};
}
