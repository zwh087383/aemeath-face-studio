async page => {
  // Deliberately one real-cloud turn per invocation. No retries. Set
  // window.__qwenProbe={kind:'text'|'audio'|'interrupt', mode:'manual'|'vad', text, sidecar}.
  const options=await page.evaluate(()=>window.__qwenProbe || {kind:'text',mode:'manual',text:'你好，请简单介绍一下你自己。',sidecar:true});
  const checks=[],errors=[]; const read=()=>page.evaluate(()=>window.qwenLab.snapshot());
  const assert=(ok,name,detail)=>{checks.push({name,passed:!!ok,detail});if(!ok)throw new Error(name);};
  const onError=e=>errors.push(e.message); page.on('pageerror',onError);
  let result;
  try {
    await page.waitForFunction(()=>window.qwenLab?.ready,undefined,{timeout:30000});
    const before=await read();assert(!before.error && before.rendered.finite,'actual avatar ready',{error:before.error,frame:before.rendered.frame});
    if(!before.client.ready) await page.evaluate(mode=>window.qwenLab.connect(mode),options.mode||'manual');
    assert((await read()).client.mode === (options.mode||'manual'),'requested input mode active');
    await page.evaluate(value=>{window.qwenLab.setSidecar(value);window.qwenLab.resetPerformance();},options.sidecar!==false);
    if(options.kind==='audio') await page.evaluate(name=>window.qwenLab.fixture(name),options.fixture||'greeting');
    else await page.evaluate(text=>window.qwenLab.sendText(text),options.text||'你好，请简单介绍一下你自己。');
    await page.waitForFunction(()=>{const s=window.qwenLab.snapshot();return !!s.error || (s.session.audio.sourceActive && s.rendered.mouthOpen>.04);},undefined,{timeout:30000});
    const playing=await read(); assert(!playing.error && playing.session.audio.sourceActive,'actual WebAudio and PCM mouth active',{error:playing.error,mouth:playing.rendered.mouthOpen,time:playing.session.audio.time});
    if(options.kind!=='interrupt')await page.screenshot({path:`outputs/qwen-live-avatar-20261015/${options.label||options.kind}-playing.png`});
    if(options.kind==='interrupt') {
      // This records whether generation is still in flight; do not relabel a
      // completed-provider local stop as a remote cancellation success.
      const pre=await read();
      await page.evaluate(()=>window.qwenLab.fixture('interrupt',{interruptOutput:true,trimLeadingSilence:true}));
      await page.waitForFunction(()=>{const s=window.qwenLab.snapshot();return s.interruptions.length>0 && s.session.audio.sourceCount===0 && s.rendered.mouthOpen<=.01 && !s.motion.gestures.length;},undefined,{timeout:7000});
      const stopped=await read();assert(stopped.session.audio.sourceCount===0 && stopped.rendered.mouthOpen<=.01,'local cancellation removes sources and mouth',stopped.interruptions.at(-1));
      await page.waitForFunction(()=>{const s=window.qwenLab.snapshot();return s.trials.some(t=>t.cancelAt!==null && t.providerDoneAt!==null)||!!s.error;},undefined,{timeout:10000});
      result={options,preInterrupt:pre,after:await read(),checks,errors};
      await page.screenshot({path:`outputs/qwen-live-avatar-20261015/${options.label||options.kind}-stopped.png`});
    } else {
      await page.waitForFunction(()=>{const s=window.qwenLab.snapshot();return !!s.error || (s.session.audio.status==='ended' && s.client.trials.at(-1)?.providerDoneAt!==null);},undefined,{timeout:40000});
      const end=await read(),trial=end.trials.at(-1);
      assert(!end.error && trial.status==='completed','provider completed without local error',{error:end.error,status:trial.status});
      assert(end.session.audio.status==='ended' && trial.transcript.length>0,'actual playback ended and actual subtitle received',{audio:end.session.audio.status,transcript:trial.transcript});
      assert(trial.usage!==null,'provider reported usage',trial.usage);
      assert(trial.latency.inputEndToPlaybackMs>0 && trial.peakMouth>.04,'end-to-end playback/mouth measured',trial.latency);
      result={options,playing,after:end,checks,errors};
    }
    result.passed=checks.every(c=>c.passed)&&errors.length===0;
  } catch(error) {result={options,passed:false,error:error.message,checks,errors,after:await read()};}
  finally {page.off('pageerror',onError);}
  await page.evaluate(value=>{window.__qwenProbeResult=value;},result);
  console.log(JSON.stringify({passed:result.passed,checks:checks.length,error:result.error,latency:result.after.trials.at(-1)?.latency,interruptions:result.after.interruptions},null,2));
}
