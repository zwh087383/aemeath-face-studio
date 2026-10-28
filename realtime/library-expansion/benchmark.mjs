const query=new URLSearchParams(location.search),version=query.get('version')==='baseline'?'baseline':'expanded';
const module=await import(version==='baseline'?'/baseline/realtime/character-center/scene.mjs':'../character-center/scene.mjs');
const stage=document.querySelector('#stage'),start=performance.now();
const wallEvents=[];
// Both implementations receive the exact same explicit fixture. Do not compare
// their different product defaults (new pulled-out chair versus legacy desk).
const benchmarkProps={chair:false,table:{visible:true,attachment:'floor',position:[0,0,4.3]},book:false,mug:false,paper:false,pencil:false,laptop:false,mat:false,box:false,platform:false};
const scene=await module.createScene(stage,text=>document.querySelector('#state').textContent=text,{sceneProps:benchmarkProps,
 onEvent:event=>wallEvents.push({type:event.type,action:event.action,reason:event.reason,wallMs:performance.now()})});
const preparedMs=performance.now()-start,owner={sourceKey:'benchmark:local',sourceScope:'component',sourceVersion:1,requestId:'wave'};
// compileAsync does not prove the first real skinned/morphed frame is ready.
// Record that cost separately instead of mixing it into steady-play timing.
const warmFrames=[];
for(let i=0;i<6;i++){await new Promise(requestAnimationFrame);const before=performance.now();scene.step(0,0,{render:true});warmFrames.push(performance.now()-before);}
const readyMs=performance.now()-start;
window.benchmark={ready:true,version,preparedMs,readyMs,warmFrames,scene,async run({seconds=8,loadNative=false,failResource=false,movement=null}={}){
 const ctx=new AudioContext();await ctx.resume();
 const buffer=await ctx.decodeAudioData(await (await fetch('/library-data/sample.wav')).arrayBuffer());
 const source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=buffer;source.loop=true;gain.gain.value=.06;source.connect(gain);gain.connect(ctx.destination);
 const workletURL=URL.createObjectURL(new Blob([`class Check extends AudioWorkletProcessor {constructor(){super();this.last=null;this.size=0;this.gaps=0;this.gapSamples=[];this.count=0;this.frames=0;this.peak=0;this.quantums={};}process(inputs,outputs){const x=inputs[0]?.[0];if(x){if(this.last!==null&&currentFrame-this.last!==this.size){this.gaps++;if(this.gapSamples.length<8)this.gapSamples.push({from:this.last,to:currentFrame,expected:this.size});}this.last=currentFrame;this.size=x.length;this.frames+=x.length;this.quantums[x.length]=(this.quantums[x.length]??0)+1;for(const s of x)this.peak=Math.max(this.peak,Math.abs(s));if(++this.count%128===0)this.port.postMessage({frame:currentFrame,gaps:this.gaps,gapSamples:this.gapSamples,quantums:this.quantums,processedFrames:this.frames,count:this.count,peak:this.peak});}return true;}}registerProcessor('check',Check);`],{type:'text/javascript'}));
 await ctx.audioWorklet.addModule(workletURL);URL.revokeObjectURL(workletURL);const monitor=new AudioWorkletNode(ctx,'check');source.connect(monitor);monitor.connect(ctx.destination);const audio=[];monitor.port.onmessage=e=>audio.push(e.data);
 const longTasks=[];let observer;try{observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask',buffered:false});}catch{}
 const frames=[],drivers=[],renders=[],activityPreparation=[];
 if(movement){
  const originalPrepare=scene.body.preparePlay.bind(scene.body);
  Object.defineProperty(scene.body,'preparePlay',{configurable:true,enumerable:false,
   value:(...args)=>{const at=performance.now();const value=originalPrepare(...args);activityPreparation.push({action:args[0],ms:performance.now()-at,accepted:value.accepted,reason:value.reason});return value;}});
 }
 source.start();const audioStart=ctx.currentTime,runStart=performance.now(),eventStart=wallEvents.length;
 scene.bodyDirector.submit({operation:'append',actions:[{action:'gesture:wave',anchor:'immediate'}]},owner);
 let previous=performance.now(),begin=previous,t=0,prepared=false,preparation=null;
 await new Promise((resolve,reject)=>{function frame(){try{const wall=performance.now(),dt=Math.max(0,Math.min(.1,(wall-previous)/1000));frames.push(wall-previous);previous=wall;t+=dt;
   if(loadNative&&!prepared&&wall-begin>300){prepared=true;preparation=scene.prepare?.('native:thinking01').then(()=>({ok:true}),e=>({ok:false,reason:e.message}));scene.bodyDirector.submit({operation:'append',actions:[{action:'native:thinking01',anchor:'immediate'}]},{...owner,requestId:'native'});}
   if(movement&&!prepared&&wall-begin>300){prepared=true;scene.bodyDirector.submit({operation:'append',actions:[{action:movement,anchor:'immediate'}]},{...owner,requestId:'movement'});}
   const s=scene.step(t,dt,{render:true,audioTime:ctx.currentTime-audioStart,audioStatus:'playing'});drivers.push(s.driverMs);renders.push(s.renderMs);
   if(wall-begin<seconds*1000)requestAnimationFrame(frame);else resolve();}catch(error){reject(error);}}requestAnimationFrame(frame);});
 source.stop();observer?.disconnect();await new Promise(r=>setTimeout(r,100));await ctx.close();
 const stats=a=>{const s=a.slice().sort((x,y)=>x-y);return {median:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s.at(-1),count:s.length};};
 const result={version,fixture:{actorRoot:[0,0,0],props:benchmarkProps},preparedMs,readyMs,warmFrames,environment:scene.environment,seconds,loadNative,failResource,driverMs:stats(drivers),renderMs:stats(renders),frameMs:stats(frames),over50ms:frames.filter(x=>x>50).length,longTasks,audio:{blocks:audio.at(-1)?.count??0,reportedFrameGaps:audio.at(-1)?.gaps??null,gapSamples:audio.at(-1)?.gapSamples??[],quantums:audio.at(-1)?.quantums,processedFrames:audio.at(-1)?.processedFrames,sampleRate:ctx.sampleRate,nonSilent:audio.some(x=>x.peak>.001),kind:'prebuffered existing PCM and AudioWorklet; not microphone or streaming-network acceptance'},preparation:await preparation,
  execution:scene.bodyDirector.snapshot().events.map(e=>({type:e.type,action:e.action,reason:e.reason,at:e.at})),
  executionWall:wallEvents.slice(eventStart).map(e=>({...e,wallMs:e.wallMs-runStart})),
  resources:scene.resourceStatus?.(),movement,activityPreparation,cloudCalls:0};
 if(movement)delete scene.body.preparePlay;
 document.querySelector('#state').textContent=JSON.stringify(result,null,2);return result;
}};
