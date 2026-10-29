async function installLiveProbe() {
  // Observation only: originals receive unchanged arguments and keep their return values.
  const {DuplexClient} = await import('/duplex/client.mjs');
  const {CharacterBodyDirector} = await import('/character-center/body-director.mjs');
  const {CharacterCenter} = await import('/character-center/center.mjs');
  const probe = window.liveProbe = {inputs:[],clientEvents:[],bodyEvents:[],centerCancels:[],frames:[],audioBlocks:[],errors:[],active:true};
  let client=null, tap=null, mix=null, context=null, raf;
  const keys=['head','chest','pelvis','leftWrist','rightWrist','leftElbow','rightElbow'];
  probe.poseKeys=keys;probe.frameColumns=['wallMs','audioContextSeconds','paused','activeId','sourceCount','audioStatus','pose'];
  const originalConnect=DuplexClient.prototype.connect;
  DuplexClient.prototype.connect=async function(...args){
    client=this;mix=this.session.audio.context.destination;context=mix.context;
    if(tap)throw Error('measurement_duplicate_connect');
    probe.audioEnvironment={sampleRate:context.sampleRate,baseLatency:context.baseLatency,outputLatency:context.outputLatency,
      clock:'AudioContext render quanta; no physical speaker loopback',userPcmPacketFrames:1600,userPcmRate:16000};
    const code=`class OutputMeter extends AudioWorkletProcessor{
      constructor(){super();this.n=0;this.peak=0;this.first=0;}
      process(inputs,outputs){const x=inputs[0]?.[0];
        if(!this.n)this.first=currentFrame;
        if(x)for(let i=0;i<x.length;i++)this.peak=Math.max(this.peak,Math.abs(x[i]));
        this.n+=outputs[0][0].length;
        if(this.n>=512){this.port.postMessage([this.first/sampleRate,this.n/sampleRate,this.peak]);this.n=0;this.peak=0;}
        return true;
      }
    }registerProcessor('live-output-meter',OutputMeter);`;
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    try{await context.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
    tap=new AudioWorkletNode(context,'live-output-meter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    tap.port.onmessage=e=>{if(probe.active)probe.audioBlocks.push(e.data);};
    // Extra branch only. The meter output is zero; original playback is untouched.
    mix.connect(tap);tap.connect(context.destination);
    return originalConnect.apply(this,args);
  };
  const originalAudio=DuplexClient.prototype.sendAudio;
  DuplexClient.prototype.sendAudio=function(samples,...args){
    const at=performance.now(),audio=this.session.audio.snapshot();
    let sum=0,first=-1;for(let i=0;i<samples.length;i++){const x=samples[i]/32768;sum+=x*x;if(first<0&&Math.abs(x)>.015)first=i;}
    const row={at,contextTime:this.session.audio.context.currentTime,rms:Math.sqrt(sum/samples.length),firstThresholdFrame:first,
      previousTurnId:this.current?.id??null,audioBefore:audio.status,sourcesBefore:audio.sourceCount,bodyBefore:this.director?.body.active?.action??null};
    const result=originalAudio.call(this,samples,...args);
    row.accepted=result;row.returnAt=performance.now();probe.inputs.push(row);return result;
  };
  const originalEmit=DuplexClient.prototype.emit;
  DuplexClient.prototype.emit=function(type,fields){
    if(['provisional_pause','cancel','unconfirmed_noise_resumed','invalid_turn_resumed'].includes(type))
      probe.clientEvents.push({type,...structuredClone(fields),wallMs:performance.now(),contextTime:this.session.audio.context.currentTime});
    return originalEmit.call(this,type,fields);
  };
  const originalRecord=CharacterBodyDirector.prototype.record;
  CharacterBodyDirector.prototype.record=function(...args){
    const event=originalRecord.apply(this,args);
    probe.bodyEvents.push({...structuredClone(event),wallMs:performance.now(),contextTime:context?.currentTime??null});
    return event;
  };
  const originalCancel=CharacterCenter.prototype.cancel;
  CharacterCenter.prototype.cancel=function(...args){
    const before={active:this.body.active?.id??null,pending:this.body.pending.length};
    const at=performance.now(),answer=originalCancel.apply(this,args);
    probe.centerCancels.push({at,returnAt:performance.now(),command:structuredClone(args[0]??{}),before,
      after:{active:this.body.active?.id??null,pending:this.body.pending.length}});return answer;
  };
  function frame(){
    if(!probe.active)return;
    try{if(client){
      const body=client.director.body,audio=client.session.audio.snapshot(),actor=body.getActorState();
      const pose=keys.flatMap(k=>[...(actor.bones?.[k]??[]),...(actor.rotations?.[k]??[])]).map(v=>Math.round(v*1e7)/1e7);
      probe.frames.push([performance.now(),context.currentTime,body.paused,body.active?.id??null,audio.sourceCount,audio.status,pose]);
    }}catch(e){probe.errors.push(e.message);probe.active=false;}
    raf=requestAnimationFrame(frame);
  }
  raf=requestAnimationFrame(frame);
  probe.finish=()=>{probe.active=false;cancelAnimationFrame(raf);if(tap){mix.disconnect(tap);tap.disconnect();tap.port.close();}
    const {finish,...data}=probe;return data;};
  return {installed:true,outputMeter:'passive_512_frame_WebAudio_branch',motionObserver:'rendered_world_bone_pose_per_frame'};
}
