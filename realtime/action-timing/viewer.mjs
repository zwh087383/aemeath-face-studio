import {createScene} from '../qwen/scene.mjs';
import {LiveAvatarSession} from '../qwen/live-session.mjs';
import {VoicedPreparedMotionController,VoicedPreparedFaceController,VoicedActionDriver} from './prep-driver.mjs';

const $=id=>document.getElementById(id),now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ms=v=>Number.isFinite(v)?`${Math.round(v)} ms`:'—';
const closed=new Set(['ended','cancelled','fault','idle']);
let catalog,scene,session,context,mix,run=null,report=null,rendered,last=now(),serial=0,preparing=false,batch=false,stopBatch=false;
const mark=(key,value=now())=>{if(run&&run[key]===undefined)run[key]=value;};
const active=()=>preparing||!!run&&!run.completed;
const attempted=()=>catalog?.attempted??[];
async function json(url,options){const r=await fetch(url,options);if(!r.ok)throw Error(`HTTP ${r.status}: ${url}`);return r.json();}

function controls(){
  if(!catalog)return;
  const c=catalog.cases.find(c=>c.id===$('case').value),busy=active()||batch;
  if(c)$('context').textContent=`${c.context}\n本轮台词：${c.text}`;
  const unavailable=!scene||busy||catalog.busy;
  $('case').disabled=busy;
  $('replay').disabled=unavailable||!attempted().includes(c?.id);
  $('interrupt-replay').disabled=$('replay').disabled;
  $('live').disabled=unavailable||!catalog.cloudEnabled||catalog.blocked||catalog.used>=catalog.limit||attempted().includes(c?.id);
  $('batch').disabled=unavailable||!catalog.cloudEnabled||catalog.blocked||catalog.used>=catalog.limit||catalog.cases.every(c=>attempted().includes(c.id));
  $('sound').disabled=!scene||busy;
  $('pause').disabled=!run||run.completed||run.cancelled||!run.owner;
  $('cancel').disabled=!run||run.completed||run.cancelled;
  $('budget').textContent=`本批已用 ${catalog.used} / ${catalog.limit} 个响应${catalog.blocked?' · 未知用量：停止新调用':''}${catalog.busy?' · 服务端正在运行样本':''}`;
}
function table(){
  $('rows').replaceChildren();
  for(const c of catalog.cases){
    const r=catalog.results?.[c.id],client=catalog.clientReports?.[c.id],m=r?.metrics??{},l=client?.latency??{},p=client?.performance??{};
    const throttled=p.frameP95Ms>100||p.frameMaxMs>250||p.hiddenFrames>0;
    const outcome=(!r?'未测试':r.error?'失败：'+r.error:r.cancelled?'已取消':m.toolOnly?'仅工具，无语音':m.audioOnly?'仅语音，无动作':r.completed?'已完成':'未完整结束')+(throttled?' · 画面计时受节流影响':'');
    const tr=document.createElement('tr');
    for(const value of [c.id,ms(m.firstArgumentDeltaMs),ms(m.completeToolMs),ms(l.voiceMs),throttled?'需回放复核':ms(l.bodyLeadMs),throttled?'需回放复核':ms(l.faceLeadMs),outcome]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
    $('rows').append(tr);
  }
  $('summary').textContent=`固定 ${catalog.cases.length} 个样本，最多 ${catalog.limit} 个模型响应。表格保留首次真实播放报告；免费回放另存，不能覆盖实测。`;
}
async function refresh(){catalog=await json('/api/action-timing');controls();table();return catalog;}

function playbackMarker(){
  const marker=session.audio.playbackMarker();
  return marker?{...marker,wallTime:marker.reached?(now()/1000-(context.currentTime-marker.contextTime)):null}:null;
}
function captureVoice(marker=playbackMarker()){
  if(!run||run.voiceAt!==undefined||!run.owner||!marker?.reached)return;
  run.voiceContextSeconds=marker.contextTime;mark('voiceAt',marker.wallTime*1000);
}
function accept(e){
  if(!run||run.completed)return;
  const timestamp=now();run.received.push({type:e.type,at:timestamp-run.started,serverAt:e.atMs,sourceRole:e.sourceRole});
  if(e.type==='request_sent')mark('requestAt',timestamp);
  else if(e.type==='response_created'){
    if(run.cancelled)return;
    if(run.owner)throw Error('duplicate_logical_response');
    const connectionId=`action-timing-${++serial}`;session.setConnection(connectionId);
    run.owner=session.beginResponse({connectionId,responseId:e.responseId,sampleRate:24000,sidecar:false});
    if(!run.owner)throw Error('response_owner_rejected');
    run.driver=new VoicedActionDriver(session,run.owner);controls();
  }else if(e.type==='non_silent_pcm'){
    if(e.responseId!==run.owner?.responseId&&!run.cancelled)throw Error('marker_owner_mismatch');
    run.firstVoicedFrame=e.frame;mark('voicedPacketAt');
    if(!run.cancelled&&run.owner)session.audio.setPlaybackMarker(e.frame/24000);
  }else if(e.type==='audio'){
    mark('pcmAt');if(run.cancelled)return;
    if(e.responseId!==run.owner?.responseId)throw Error('pcm_owner_mismatch');
    const bytes=Uint8Array.from(atob(e.delta),c=>c.charCodeAt(0));
    if(bytes.length%2)throw Error('invalid_pcm_length');
    const view=new DataView(bytes.buffer),pcm=new Float32Array(bytes.length/2);
    for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true)/32768;
    for(let at=0;at<pcm.length;at+=24000)if(!session.appendPcm({owner:run.owner,sequence:run.sequence++,samples:pcm.slice(at,at+24000)}))throw Error('pcm_append_failed');
  }else if(e.type==='subtitle'){
    if(!run.cancelled){run.transcript+=e.delta;$('caption').textContent=run.transcript;}
  }else if(e.type==='tool'){
    mark('toolAt');run.toolBaseline=structuredClone(rendered);
    const admission=run.cancelled?{accepted:false,reason:'cancelled_turn'}:run.driver?.accept(e)??{accepted:false,reason:'missing_owner'};
    run.tools.push({event:e,result:admission,at:timestamp-run.started});
    $('plan').textContent=admission.accepted?`${admission.plan.expression} · ${admission.plan.gesture} · ${admission.prepared?'已经准备；首个有声样本释放主动作':'跟随当前语音游标'}`:`未执行：${admission.reason}`;
  }else if(e.type==='tool_rejected')run.rejected.push(e);
  else if(e.type==='voice_done'){
    mark('voiceDoneAt');run.voiceCompleted=e.completed;
    // P's planner may still be running. It never keeps the voice stream open.
    if(!run.cancelled&&run.owner){
      if(e.completed){session.finishAudio(run.owner);session.providerDone(run.owner);}
      else cancel('voice_not_completed',false);
    }
  }else if(e.type==='complete'){
    mark('providerDoneAt');run.server=e.result;
    if(e.result?.error)run.providerError=e.result.error;
    if(e.blocked)catalog.blocked=true;
    if(!run.voiceDoneAt&&!run.cancelled){run.failure='missing_voice_done';cancel('missing_voice_done',false);}
  }else if(e.type==='error'){
    run.failure=e.code??e.message??'bridge_error';mark('providerDoneAt');cancel('bridge_error',false);
  }
}
function cancel(reason='user_interrupt',provider=true){
  if(reason==='user_interrupt')stopBatch=true;
  if(!run||run.completed||run.cancelled)return false;
  captureVoice();const at=now(),before=session.audio.snapshot();run.driver?.cancel();
  const accepted=run.owner?session.cancel(reason,run.owner):false;
  run.cancelled=true;run.interrupt={reason,at,returnMs:now()-at,accepted,before,after:session.audio.snapshot(),providerRequested:false};
  if(provider&&run.mode==='live'&&!run.providerDoneAt&&run.socket?.readyState===WebSocket.OPEN){run.socket.send(JSON.stringify({type:'cancel'}));run.interrupt.providerRequested=true;}
  $('caption').textContent='好，我先听你说。';controls();return accepted;
}
function phase(a){
  if(run?.cancelled)return '已打断 · 从当前姿态收回';
  if(run&&!run.completed&&scene.motion.preparationSnapshot().some(p=>!p.released&&!p.expired))return '已经起势 · 等首个有声样本释放';
  if(a.status==='playing')return '语音直接播放 · 动作随播放推进';
  if(run&&!run.completed)return '等待流式回复';
  return '真实模型预览 · 回放不产生云端费用';
}
function frame(t){
  const interval=t-last,dt=Math.min(.05,interval/1000);last=t;
  try{
    const a=session.sync(),marker=playbackMarker(),start=now();run?.driver?.advance(marker);
    scene.motion.advancePreparation(t/1000,a,marker);scene.face.advancePreparation(t/1000,a,marker);
    const visual=session.visualState(a);
    // Once voice has started, preserve displayed pose during an audio underrun.
    visual.paused=visual.paused||!!marker?.reached&&a.status==='buffering';
    rendered=scene.step(t,dt,session.lipSample(a),visual);
    if(run&&!run.completed){
      captureVoice(marker);
      if(a.status==='playing'&&a.sourceActive)mark('playbackAt');
      if(a.status==='playing'&&rendered.mouthOpen>.03)mark('mouthAt');
      const gestures=scene.motion.gestures.filter(g=>!g.recovering&&/^(early:|fc:)/.test(g.id));
      const hasBody=gestures.some(g=>Object.values(g.live?.weights??{}).some(w=>(w.position??w.body??0)>.015));
      const rotations=run.toolBaseline?.rotations;
      const moved=rotations&&['head','chest','leftShoulder','rightShoulder','leftElbow','rightElbow'].some(k=>rendered.rotations[k]?.some((v,i)=>Math.abs(v-rotations[k]?.[i])>.002));
      if(hasBody&&moved)mark('bodyAt');
      const faceSnapshot=scene.face.snapshot();
      const reaction=scene.motion.snapshot().reactions?.some(g=>/^(early:|fc:)/.test(g.id)&&g.age>.02);
      const faceAction=faceSnapshot.executedCues.some(c=>c.kind==='action'&&c.age>.02&&/^(early:|fc:)/.test(c.id));
      if((reaction||faceAction)&&moved)mark('bodyAt');
      const facial=faceSnapshot.executedCues.some(c=>c.kind==='expression'&&/^(early:|fc:)/.test(c.id));
      if(facial&&run.toolBaseline&&[0,1,2,3,4,5,7,8,9,10,11,12,13,14,25].some(i=>Math.abs(rendered.weights[i]-run.toolBaseline.weights[i])>.04))mark('faceAt');
      run.frames.push({interval,driver:rendered.driverMs,render:rendered.renderMs,total:now()-start,visibility:document.visibilityState});
      if(!run.lastTrace||t-run.lastTrace>=40){run.lastTrace=t;run.trace.push({at:t-run.started,audio:a.status,media:a.time,marker,visibility:document.visibilityState,frameIntervalMs:interval,mouth:rendered.mouthOpen,rotations:rendered.rotations,bones:rendered.bones,weights:rendered.weights,gestures:scene.motion.snapshot().gestures,preparations:scene.motion.preparationSnapshot()});}
      if(run.interrupt){
        if(rendered.mouthOpen<.01&&run.interrupt.mouthClosedMs===undefined)run.interrupt.mouthClosedMs=now()-run.interrupt.at;
        const m=scene.motion.snapshot();if(!m.gestures.length&&!m.reactions.length&&!m.execution.handoff&&m.interactionPose.handsSettled&&run.interrupt.settledMs===undefined)run.interrupt.settledMs=now()-run.interrupt.at;
      }
      if(run.interruptAfterBodyMs!==null&&!run.cancelled&&run.bodyAt!==undefined&&now()-run.bodyAt>=run.interruptAfterBodyMs)cancel('replay_body_interrupt',false);
      const delta=key=>run[key]===undefined||run.requestAt===undefined?null:run[key]-run.requestAt;
      $('voice').textContent=ms(delta('voiceAt'));$('tool').textContent=ms(delta('toolAt'));
      $('lead').textContent=ms(run.voiceAt-run.bodyAt);$('face').textContent=ms(run.voiceAt-run.faceAt);
    }
    $('phase').textContent=phase(a);
  }catch(error){$('status').textContent=error.message;if(run&&!run.failure){run.failure=error.message;cancel('render_failure');}}
  requestAnimationFrame(frame);
}

async function checkAudio(audible=true){
  if(context.state==='closed')throw Error('音频设备已关闭，请刷新；尚未调用模型。');
  await Promise.race([context.resume(),sleep(3000).then(()=>{throw Error('浏览器未允许播放，请先点击试听。');})]);
  const initial=context.currentTime,deadline=now()+2000;
  while(context.state==='running'&&context.currentTime<=initial&&now()<deadline)await sleep(20);
  if(context.state!=='running'||context.currentTime<=initial)throw Error('音频时钟没有运行，请检查系统输出设备；尚未调用模型。');
  if(audible){const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=440;gain.gain.value=.08;oscillator.connect(gain);gain.connect(mix);oscillator.start();oscillator.stop(context.currentTime+.16);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};$('status').textContent='浏览器音频时钟已运行。短提示音用于确认输出设备。';}
}
function makeReport(){
  const percentile=key=>{const values=run.frames.map(f=>f[key]).filter(Number.isFinite).sort((a,b)=>a-b);return values[Math.floor(values.length*.95)]??null;};
  const delta=key=>run[key]===undefined||run.requestAt===undefined?null:run[key]-run.requestAt;
  const lead=key=>run.voiceAt===undefined||run[key]===undefined?null:run.voiceAt-run[key];
  const {socket,driver,frames,server,...saved}=run;
  return {...saved,server:server?{...server,events:undefined}:undefined,latency:{voiceMs:delta('voiceAt'),clickToVoiceMs:run.voiceAt===undefined?null:run.voiceAt-run.invokedAt,caseInvocationToVoiceMs:run.voiceAt===undefined?null:run.voiceAt-run.invokedAt,audioDeviceCheckMs:run.audioDeviceCheckMs,playbackMs:delta('playbackAt'),nonSilentPacketMs:delta('voicedPacketAt'),toolMs:delta('toolAt'),bodyMs:delta('bodyAt'),faceMs:delta('faceAt'),bodyLeadMs:lead('bodyAt'),faceLeadMs:lead('faceAt')},performance:{frames:frames.length,driverP95Ms:percentile('driver'),renderSubmitP95Ms:percentile('render'),frameP95Ms:percentile('interval'),frameMaxMs:frames.length?Math.max(...frames.map(f=>f.interval)):null,hiddenFrames:frames.filter(f=>f.visibility!=='visible').length},finalAudio:session.audio.snapshot(),finalMotion:scene.motion.snapshot(),environment:{...scene.environment,audioBaseLatency:context.baseLatency,audioOutputLatency:context.outputLatency,audioSampleRate:context.sampleRate,audioState:context.state,visibilityAtStart:run.visibilityAtStart,visibilityAtEnd:document.visibilityState},physicalSpeakerVerified:false,voiceMeasurementMethod:'First non-silent PCM frame mapped to scheduled AudioContext source time; performance.now minus elapsed AudioContext time; not RAF detection and not physical output.',clickTimingScope:'Compatibility clickToVoiceMs is case invocation before device check; batch members have no individual user click, and exclude the batch initial device check.',scope:'Experimental fixed script. P planner knows target line. AudioContext marker, not physical speaker. No memory/microphone/emotion-authority integration.',measurementVersion:1,preparationPolicy:'Same authored gesture instance; release at first voiced PCM sample playback, never initial silent PCM.'};
}
async function runCase(key,{live=false,interruptAfterBodyMs=null,batchMember=false}={}){
  const invokedAt=now();
  // Acquire before the first await, including audio startup and recording fetch.
  if(active()||batch&&!batchMember)throw Error('已有测试在运行');
  if(!scene)throw Error('人物还未就绪');
  const config=catalog.cases.find(c=>c.id===key);if(!config)throw Error('unknown_case');
  if(live&&(!catalog.cloudEnabled||catalog.blocked||catalog.busy||catalog.used>=catalog.limit||attempted().includes(key)))throw Error('cloud_not_allowed');
  if(live&&interruptAfterBodyMs!==null)throw Error('automatic_interrupt_is_replay_only');
  if(!live&&!attempted().includes(key))throw Error('missing_recording');
  preparing=true;controls();let saved;
  try{
    const deviceCheckAt=now();await checkAudio(false);const audioDeviceCheckMs=now()-deviceCheckAt;
    if(!live)saved=await json(`/action-timing-data/${encodeURIComponent(key)}.json`);
    scene.face.setPreset('neutral',.8);
    run={key,case:config,mode:live?'live':'replay',interruptAfterBodyMs,invokedAt,audioDeviceCheckMs,started:now(),visibilityAtStart:document.visibilityState,sequence:0,tools:[],rejected:[],received:[],frames:[],trace:[],transcript:'',completed:false};
  }finally{preparing=false;controls();}
  report=null;$('case').value=key;controls();$('caption').textContent='';$('plan').textContent='等待完整动作指令；语音不等待动作。';
  for(const id of ['voice','tool','lead','face'])$(id).textContent='—';
  $('status').textContent=live?'正在执行有界真实云端样本':'按保存事件间隔免费回放';
  try{
    let events=[],index=0,base=now();
    if(live){
      const current=run,ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/action-timing/run`);run.socket=ws;
      ws.onopen=()=>{if(current===run&&!current.completed)ws.send(JSON.stringify({case:key}));};
      ws.onmessage=e=>{if(current!==run||current.completed)return;try{accept(JSON.parse(e.data));}catch(error){current.failure=error.message;cancel('input_failure');}};
      ws.onerror=()=>{if(current===run&&!current.completed){current.failure='socket_error';cancel('socket_error');}};
      ws.onclose=()=>{if(current===run&&!current.completed&&!current.providerDoneAt){current.providerDoneAt=now();current.failure='closed_without_terminal';cancel('socket_closed',false);}};
    }else{
      events=[...saved.events];
      if(!events.some(e=>e.type==='complete'))events.push({type:'complete',atMs:(events.at(-1)?.atMs??0)+1,result:{...saved,events:undefined},blocked:false});
      base=now();
    }
    let endedAt;const deadline=now()+90000;
    while(now()<deadline){
      if(!live)while(index<events.length&&events[index].atMs<=now()-base)accept(events[index++]);
      const a=session.audio.snapshot();
      if(run.providerDoneAt&&(closed.has(a.status)||!run.owner)){endedAt??=now();if(now()-endedAt>3200)break;}
      await sleep(10);
    }
    if(!endedAt){run.failure??='playback_timeout';cancel('playback_timeout');}
  }catch(error){run.failure=error.message;cancel('playback_failure');}
  finally{run.completed=true;preparing=true;run.socket?.close();}
  report=makeReport();
  $('diagnostic').textContent=JSON.stringify({mode:report.mode,latency:report.latency,interrupt:report.interrupt,server:report.server?.metrics,roles:report.server?.roles,performance:report.performance,failure:report.failure},null,2);
  try{
    const response=await fetch(`/api/action-timing/report/${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
    if(!response.ok){report.failure??='report_save_failed';$('status').textContent='报告未保存：请保留页面。';throw Error('report_save_failed');}
    await refresh();
  }finally{preparing=false;controls();}
  $('status').textContent=run.failure?'未通过：'+run.failure:run.cancelled?'打断完成；本地回放打断不调用云端。':run.server?.metrics?.toolOnly?'本响应只有工具、没有语音；已保留，没有补发。':run.server?.completed?'本段完成，可以免费回放。':'未完整结束，保留原始证据。';
  return report;
}
async function runBatch(){
  if(active()||batch)throw Error('已有测试在运行');
  batch=true;stopBatch=false;controls();
  try{
    await checkAudio(false);await refresh();
    for(const c of catalog.cases){
      if(stopBatch||catalog.blocked||catalog.used>=catalog.limit)break;
      if(attempted().includes(c.id))continue;
      const result=await runCase(c.id,{live:true,batchMember:true});
      if(result.failure||result.providerError){stopBatch=true;throw Error(result.failure??result.providerError);}
      // Known-usage tool-only is a valid outcome of the experiment, not a retry.
      if(catalog.blocked)break;
      await sleep(700);
    }
    $('status').textContent=catalog.blocked?'本批出现未知用量，已停止新调用。':'本批结束，结果已保存在本地。';
  }finally{batch=false;await refresh();}
}

async function boot(){
  catalog=await json('/api/action-timing');
  for(const c of catalog.cases){const option=document.createElement('option');option.value=c.id;option.textContent=`${c.scene==='greet'?'招呼':'比较方案'} · ${c.group}`;$('case').append(option);}
  context=new AudioContext({sampleRate:24000,latencyHint:'interactive'});mix=context.createGain();mix.gain.value=.16;mix.connect(context.destination);
  const host={get state(){return context.state;},get currentTime(){return context.currentTime;},destination:mix,resume:()=>context.resume(),createBuffer:(...v)=>context.createBuffer(...v),createBufferSource:()=>context.createBufferSource(),createGain:()=>context.createGain()};
  scene=await createScene($('stage'),message=>$('loading').textContent=message,{motionFactory:options=>new VoicedPreparedMotionController(options),faceFactory:()=>new VoicedPreparedFaceController()});
  scene.motion.setPosture('relaxed');scene.face.setPreset('neutral',.8);
  session=new LiveAvatarSession({context:host,face:scene.face,motion:scene.motion,naturalConversation:false});session.audio.setVolume(1);
  $('loading').remove();requestAnimationFrame(frame);await refresh();$('status').textContent='人物已就绪。点击测试按钮才会调用云模型。';
  window.actionTiming={ready:true,runCase,runBatch,checkAudio,cancel,accept,refresh,get active(){return active()||batch;},get report(){return report;},get catalog(){return catalog;},get scene(){return scene;},get session(){return session;},get state(){return {run:run?{key:run.key,mode:run.mode,tools:run.tools,cancelled:run.cancelled,requestAt:run.requestAt,bodyAt:run.bodyAt,voiceAt:run.voiceAt,providerDoneAt:run.providerDoneAt}:null,rendered,audio:session.audio.snapshot(),motion:scene.motion.snapshot(),preparation:scene.motion.preparationSnapshot()};}};
  const action=fn=>()=>Promise.resolve().then(fn).catch(error=>{$('status').textContent=error.message;controls();});
  $('case').onchange=controls;$('volume').oninput=()=>mix.gain.value=+$('volume').value;
  $('sound').onclick=action(()=>checkAudio());$('replay').onclick=action(()=>runCase($('case').value));
  $('interrupt-replay').onclick=action(()=>runCase($('case').value,{interruptAfterBodyMs:200}));
  $('live').onclick=action(()=>runCase($('case').value,{live:true}));$('batch').onclick=action(runBatch);
  $('cancel').onclick=()=>cancel();$('pause').onclick=action(async()=>{captureVoice();if(session.audio.snapshot().status==='paused')await session.resume();else session.pause();});
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>scene.setView(button.dataset.view);
}
boot().catch(error=>{$('status').textContent=error.message;console.error(error);});
