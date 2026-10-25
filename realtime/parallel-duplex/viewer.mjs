import {createScene} from '../qwen/scene.mjs';
import {LiveAvatarSession} from '../qwen/live-session.mjs';
import {captureMicrophone,resample16k,pcmBase64} from '../qwen/input-audio.mjs';
import {VoicedPreparedMotionController,VoicedPreparedFaceController} from '../action-timing/prep-driver.mjs';
import {ParallelActionDirector} from './director.mjs';
import {ParallelDuplexClient,ACTOR_STATE,framePreflightVerdict,attemptedFixtureIds,replayTurnEvents} from './client.mjs';
import {ModelActionDirector} from '../model-director/director.mjs';
import {MODEL_ACTIONS,validateCommands} from '../model-director/catalog.mjs';
import {ModelMotionController,ModelFaceController} from '../model-director/driver.mjs';
import {ModelDuplexClient} from '../model-director/client.mjs';

const modelMode=location.pathname.startsWith('/model-director/');
const modelStateLabels={queued:'等待',admitted:'已交给播放器',playing:'正在做',completed:'已完成',cancelled:'已撤销',execution_failed:'执行失败'};
const modelReasonLabels={previous_action_running:'前一个动作还在做',body_recovery:'等待身体收势',execution_scene_unavailable:'站姿 / 空手 / 足部支撑未确认',model_delay:'等待模型指定的时间',waiting_voice:'等待出声',model_replace:'模型替换了队列',model_clear:'模型清空了队列',local_demo_clear:'手动清空',explicit_user_interrupt:'用户打断',voice_owner_revoked:'旧轮已撤销',new_turn:'进入新一轮'};

const $=id=>document.getElementById(id),now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shown=value=>Number.isFinite(value)?`${Math.round(value)} ms`:'—';
const percentile=(rows,key,p=.95)=>{const v=rows.map(x=>x[key]).filter(Number.isFinite).sort((a,b)=>a-b);return v[Math.min(v.length-1,Math.floor(v.length*p))]??null;};
let scene,session,director,client,context,mix,capture,service,manifest,rendered,lastFrame=now(),lastUI=0;
let microphone,micParts=[],inputGeneration=0,feeding=false,silenceTimer,ready=false,starting=false,suite=false,replaying=false,closing=false;
let renderError=null,suiteState=null,replaySerial=0,recording=null,recordingBlob=null,preflightState=null,reportSource='actual_WAI_parallel_duplex',previewEvidence=null;
const replays=[],savedReports=[];
let persistedAttempts=[];
const attemptKey=()=>`parallel-duplex-attempts:${service?.experimentId??location.pathname}`;
const allAttempts=()=>[...persistedAttempts,...(suiteState?.inputs??[]),...inputRecords];
function rememberAttempt(record){
  persistedAttempts=persistedAttempts.filter(x=>x.id!==record.id);persistedAttempts.push({id:record.id,sentPackets:record.sentPackets,startedAt:record.startedAt});
  try{localStorage.setItem(attemptKey(),JSON.stringify(persistedAttempts));}catch{/* current-page guard still applies */}
}
async function json(url,options){const r=await fetch(url,options);if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
function error(e){$('status').textContent=e?.message??String(e);}
function marker(){const m=session.audio.playbackMarker();return m?{...m,wallTime:m.reached?now()/1000-(context.currentTime-m.contextTime):null}:null;}
function captureVoice(t=client.current,m=marker()){
  if(!t||t.revoked||t.voiceAt!==undefined||session.owner!==t.owner||!m?.reached)return;
  t.voiceAt=m.wallTime*1000;t.voiceContextSeconds=m.contextTime;
}
function directorDecision(decision){
  const t=client?.trials.find(t=>t.id===decision.turnId);
  if(t){(t.directorDecisions??=[]).push(structuredClone(decision));
    if(decision.type==='admitted'&&decision.accepted){t.admittedAt??=now();t.poseBaseline??=rendered?structuredClone(rendered):null;t.admission=structuredClone(decision);}}
}
function event(e){
  if(['blocked','closed','input_exhausted'].includes(e.type)){stopMic();clearInterval(silenceTimer);}
  if(e.type==='client_error')error(e.code);
  const s=e.event;
  if(s?.type==='input_partial')$('input').textContent=(s.text??'')+(s.stash??'');
  if(s?.type==='input_final')$('input').textContent=s.transcript;
  if(s?.type==='turn_started'){$('pipeline').textContent='检索记忆、准备本轮上下文';$('answer').textContent='';}
  if(s?.type==='context_ready')$('pipeline').textContent='记忆已就绪；语音与动作独立进行';
  if(s?.type==='action_plan')$('plan').textContent=modelMode?`收到 ${s.command?.operation??'待校验'} 指令，共 ${s.command?.actions?.length??0} 个动作；下表记录执行结果。`:`动作建议：${s.intent??'待校验'}。是否执行由调度器判断。`;
  if(s?.type==='action_context'&&client.current?.id===s.turnId){client.current.emotionBaseline??=rendered?structuredClone(rendered):null;client.current.emotionContextAt??=now();}
  if(s?.type==='handoff_requested')$('pipeline').textContent='语音模型请求完整分析，准备接续回复';
  if(s?.type==='turn_output_done')$('pipeline').textContent='语音生成完成，等待实际播完确认';
  if(s?.type==='settled'){$('pipeline').textContent='已实际播完，回复已写入已送达历史';const t=client.trials.find(t=>t.id===s.turnId);if(t)t.measurementEndedAt??=now();}
}
function newClient(){return new (modelMode?ModelDuplexClient:ParallelDuplexClient)({session,director,onEvent:event});}
function metrics(t){
  const relative=key=>Number.isFinite(t[key])&&Number.isFinite(t.requestAt)?t[key]-t.requestAt:null;
  const lead=key=>Number.isFinite(t.voiceAt)&&Number.isFinite(t[key])?t.voiceAt-t[key]:null;
  const rows=t.renderFrames??[],frameP95=percentile(rows,'interval'),frameMax=rows.length?Math.max(...rows.map(x=>x.interval)):null;
  return {lastInputSpeechToVoiceMs:Number.isFinite(t.voiceAt)&&Number.isFinite(t.input?.lastSpeechAt)?t.voiceAt-t.input.lastSpeechAt:null,
    inputTailToVADStopMs:Number.isFinite(t.input?.stoppedAt)&&Number.isFinite(t.input?.lastSpeechAt)?t.input.stoppedAt-t.input.lastSpeechAt:null,
    vadStopToFinalTextMs:Number.isFinite(t.input?.finalAt)&&Number.isFinite(t.input?.stoppedAt)?t.input.finalAt-t.input.stoppedAt:null,
    finalTextToTurnStartMs:Number.isFinite(t.input?.finalAt)?t.startedAt-t.input.finalAt:null,
    turnStartToContextMs:Number.isFinite(t.contextReadyAt)?t.contextReadyAt-t.startedAt:null,
    contextToRequestMs:Number.isFinite(t.requestAt)&&Number.isFinite(t.contextReadyAt)?t.requestAt-t.contextReadyAt:null,
    requestToVoiceMs:relative('voiceAt'),requestToVoicedPacketMs:relative('firstVoicedPcmAt'),requestToPlanMs:relative('firstActionPlanAt'),
    commandLeadMs:lead('firstActionPlanAt'),bodyLeadMs:lead('bodyAt'),faceLeadMs:lead('faceAt'),strokeLeadMs:lead('strokeAt'),
    frameP95Ms:frameP95,frameMaxMs:frameMax,driverP95Ms:percentile(rows,'driver'),renderSubmitP95Ms:percentile(rows,'render'),
    hiddenFrames:rows.filter(x=>x.hidden).length,renderTimingValid:rows.length>0&&frameP95<=100&&frameMax<=250&&!rows.some(x=>x.hidden)};
}
function controls(){
  if(!client)return;const budget=client.localReplay?service?.budget:client.budget??service?.budget,full=budget&&(budget.turns>=budget.turnLimit||budget.responses+(budget.reserved??0)>=budget.responseLimit);
  const cloud=service?.cloudEnabled===true;
  $('connect').disabled=!ready||starting||suite||replaying||client.ready||!cloud||full||budget?.blocked||(client.blocked&&!client.canReconnect);
  const attempted=attemptedFixtureIds(allAttempts());
  $('suite').disabled=!ready||suite||starting||replaying||!cloud||full||budget?.blocked||client.blocked||attempted.size>0||budget?.turns>0;
  if(modelMode)$('suite').disabled=true; // Three-question batch is sent explicitly, never the legacy six-question suite.
  $('resume-suite').disabled=!ready||suite||starting||replaying||!cloud||full||budget?.blocked||client.blocked||!service.completedFixtures?.length||attempted.size!==service.completedFixtures.length||budget?.turns!==service.completedFixtures.length;
  const inputDisabled=!client.ready||client.blocked||client.inputExhausted||feeding||suite||replaying;
  $('feed').disabled=inputDisabled||!!microphone||attempted.has($('fixture').value);$('mic').disabled=inputDisabled||!!microphone;$('send').disabled=inputDisabled;
  $('stop-mic').disabled=!microphone;$('cancel').disabled=!client.current||client.current.revoked||(client.current.settledAt!==undefined&&!director.hasWork?.());
  $('disconnect').disabled=!client.ready&&!client.socket;$('replay').disabled=!replays.length||suite||replaying||client.ready||starting;
  $('save').disabled=!ready||starting;$('fixture').disabled=feeding||suite||replaying;$('replay-choice').disabled=replaying||suite;
  $('sound').disabled=!ready||starting||suite||feeding||replaying;
  $('preview-wave').disabled=!ready||starting||suite||feeding||replaying||client.ready||client.socket?.readyState<2;
  if(modelMode){$('model-send').disabled=!client.current||client.current.revoked||!client.localReplay;
    $('model-pause').disabled=!director.hasWork();$('model-stop').disabled=!director.hasWork();}
  for(const option of $('fixture').options)option.disabled=attempted.has(option.value);
  $('suite-progress').textContent=attempted.size?`已经送入 ${attempted.size} 条题目（包括中途停止的录音）；整批按钮已停用，请仅手动选择未发送的剩余题目。刷新页面也不会重置云端预算。`:budget?.turns>0?'当前批次已有真实轮次；禁止整批从头重测。请先核对报告，再手动选择尚未发送的题目。':'每条题目只送入一次；异常后不从头重测。';
  $('budget').textContent=budget?`本批 ${budget.turns}/${budget.turnLimit} 轮 · ${budget.responses}/${budget.responseLimit} 个 Qwen 响应 · 未知 ${budget.unknown??0}${budget.blocked?' · 已停止新调用':''}`:'正在读取预算';
}
function updateUI(){
  controls();const t=client.current,a=session.audio.snapshot(),d=director.snapshot();
  $('phase').textContent=replaying?(reportSource==='simulated_plan_cached_audio'?'本地模拟动作指令 · 缓存语音 · 无云费用':'真实记录回放 · 不调用云端'):client.blocked||service?.budget?.blocked?'未知用量或保护触发 · 已停止新调用':a.status==='playing'?'正在回应 · 输入继续监听':a.status==='paused'?'听到声音，先暂停回应':client.ready?'正在倾听':'人物预览 · 未连接语音';
  const canBarge=!!t?.outputDoneAt&&!t.revoked&&a.status==='playing'&&a.queuedSeconds>.5&&t.voiceAt!==undefined;
  $('playback-window').textContent=`播放状态：${a.status} · 已缓冲待播放 ${Math.max(0,a.queuedSeconds??0).toFixed(2)} 秒 · ${canBarge?'已满足真实播放中插话条件，可发送 barge':'尚未满足“生成完成且仍有声音在播”的插话条件'}`;
  if(t){$('caption').textContent=t.revoked?'好，我先听你说。':t.transcript;$('answer').textContent=t.transcript||'等待现场回复';
    const m=metrics(t);$('latency').textContent=shown(m.lastInputSpeechToVoiceMs);$('voice').textContent=shown(m.requestToVoiceMs);
    $('body-lead').textContent=m.renderTimingValid?shown(m.bodyLeadMs):'待画面复核';$('plan-lead').textContent=shown(m.commandLeadMs);
    if(t.error){$('pipeline').textContent='本轮未完成，证据已保留';error(t.error);}}
  $('director').textContent=JSON.stringify({mode:d.mode,selected:d.selected,execution:d.execution,pending:d.pending,lastDecisions:d.decisions?.slice(-5)},null,2);
  if(modelMode){$('queue-count').textContent=`已接收 ${d.counts.received} · 起势 ${d.counts.started} · 完成 ${d.counts.completed} · 撤销 ${d.counts.cancelled} · 拒绝 ${d.counts.rejected}`;
    $('model-rows').replaceChildren();for(const row of d.rows.slice(-20)){const tr=document.createElement('tr');for(const value of [MODEL_ACTIONS[row.action].label,modelStateLabels[row.status]??row.status,modelReasonLabels[row.reason]??row.reason??'—']){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('model-rows').append(tr);}}
  $('rows').replaceChildren();
  for(const row of client.trials){const m=metrics(row),tr=document.createElement('tr');
    const result=row.revoked?'已撤销':client.localReplay&&a.status==='ended'?'已回放，不写真实历史':row.settledAt!==undefined?'已播完并入历史':row.error?'失败：'+row.error:row.outputDoneAt?'生成完成，等待播放':'进行中';
    for(const value of [row.text,shown(m.lastInputSpeechToVoiceMs),shown(m.requestToVoiceMs),shown(m.commandLeadMs),m.renderTimingValid?shown(m.bodyLeadMs):'画面计时待复核',result]){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('rows').append(tr);}
}
function frame(time){
  const interval=time-lastFrame,dt=Math.min(.05,Math.max(0,interval/1000));lastFrame=time;
  try{
    client.sync();const a=session.audio.snapshot(),m=marker();captureVoice(client.current,m);
    director.advance(a,m);const visual=session.visualState(a);visual.paused=visual.paused||!!m?.reached&&a.status==='buffering'||(modelMode&&director.paused);
    rendered=scene.step(time,dt,session.lipSample(a),{...visual,idle:true});const t=client.current,motion=scene.motion.snapshot();
    if(t&&!t.measurementEndedAt&&(!t.revoked||now()-t.cancelAt<3500)){
      const f={at:time,interval,driver:rendered.driverMs,render:rendered.renderMs,hidden:document.visibilityState!=='visible'};(t.renderFrames??=[]).push(f);if(t.renderFrames.length>12000)t.renderFrames.shift();
      const base=t.poseBaseline,hasAdmission=t.admission?.accepted,rotations=base?.rotations;
      const moved=rotations&&['head','chest','leftShoulder','rightShoulder','leftElbow','rightElbow'].some(k=>rendered.rotations[k]?.some((v,i)=>Math.abs(v-rotations[k]?.[i])>.002));
      if(!t.revoked&&hasAdmission){
        const body=scene.motion.gestures.some(g=>!g.recovering&&Object.values(g.live?.weights??{}).some(w=>(w.position??w.body??0)>.015));
        const reaction=motion.reactions?.some(r=>r.age>.02);
        if((body||reaction)&&moved)t.bodyAt??=now();
        if(motion.gestures.some(g=>!g.recovering&&g.phase==='stroke'))t.strokeAt??=now();
      }
      const faceBase=t.emotionBaseline??base;
      if(!t.revoked&&faceBase&&[0,1,2,3,4,5,7,8,9,10,11,12,13,14,25].some(i=>Math.abs(rendered.weights[i]-faceBase.weights[i])>.04))t.faceAt??=now();
      if(!t.lastTraceAt||time-t.lastTraceAt>=80){t.lastTraceAt=time;(t.renderTrace??=[]).push({at:time,audio:{status:a.status,time:a.time,sources:a.sourceCount},marker:m,mouth:rendered.mouthOpen,
        rotations:rendered.rotations,weights:rendered.weights,gestures:motion.gestures,reactions:motion.reactions,preparations:scene.motion.preparationSnapshot(),director:modelMode?director.executionSnapshot():director.snapshot().execution});if(t.renderTrace.length>2000)t.renderTrace.shift();}
    }
    for(const stop of client.interruptions){if(stop.turnId!==t?.id)continue;
      if(rendered.mouthOpen<.01)stop.mouthClosedMs??=now()-stop.at;
      if(!motion.gestures.length&&!motion.reactions.length&&!motion.execution?.handoff&&motion.interactionPose.handsSettled)stop.motionStoppedMs??=now()-stop.at;
      stop.sourcesRemain=a.sourceCount;}
    if(time-lastUI>180){updateUI();lastUI=time;}
  }catch(e){renderError??={code:'render_failure',at:now()};error('画面发生错误；语音不等待画面。请保存报告。');}
  requestAnimationFrame(frame);
}
async function checkAudio(){
  await context.resume();const first=context.currentTime,deadline=now()+2000;
  while(context.state==='running'&&context.currentTime<=first&&now()<deadline)await sleep(20);
  if(context.state!=='running'||context.currentTime<=first)throw Error('音频时钟未运行，尚未调用云端。');
}
async function soundCheck(){
  await checkAudio();const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=440;gain.gain.value=.08;
  oscillator.connect(gain);gain.connect(mix);oscillator.start();oscillator.stop(context.currentTime+.16);
  oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};$('status').textContent='音频时钟已运行；短提示音仅用于检查输出，没有调用云模型。';
}
async function framePreflight(){
  $('status').textContent='正在检查约 0.8 秒的实际画面帧率；此检查不请求云端。';
  preflightState=await new Promise(resolve=>{
    const start=now(),intervals=[];let prior=start,hidden=document.visibilityState!=='visible',finished=false,request;
    const finish=timedOut=>{if(finished)return;finished=true;cancelAnimationFrame(request);clearTimeout(timer);resolve({...framePreflightVerdict(intervals,{hidden,timedOut}),at:now(),durationMs:now()-start});};
    const timer=setTimeout(()=>finish(true),2000);
    const sample=time=>{hidden||=document.visibilityState!=='visible';intervals.push(time-prior);prior=time;
      if(time-start>=800||hidden)finish(false);else request=requestAnimationFrame(sample);};
    request=requestAnimationFrame(sample);
  });
  if(!preflightState.valid)throw Error(`画面预检未通过（P95 ${shown(preflightState.p95)} / 最大 ${shown(preflightState.max)}）。请恢复前台窗口后重试；尚未连接云端或发送本次输入。`);
  return preflightState;
}
async function connect(){
  if(starting||replaying||client.ready)throw Error('会话已连接或正在连接');starting=true;controls();
  try{service=await json('/api/duplex/status');if(service.cloudEnabled!==true)throw Error('服务未启用云端调用');
    if(service.budget?.blocked||service.budget?.unknown>0)throw Error('当前云端批次已停止，只能本地预览；不会创建新连接。');
    await checkAudio();await framePreflight();const url=new URL('/api/duplex',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('variant','qwen-direct');
    if(client.localReplay)client=newClient();reportSource='actual_WAI_parallel_duplex';previewEvidence=null;
    await client.connect(url.href);client.send({type:'actor_state',actorState:{...ACTOR_STATE}});
    clearInterval(silenceTimer);silenceTimer=setInterval(()=>{if(client.ready&&!client.blocked&&!feeding&&!microphone)client.sendAudio(new Int16Array(1600),{source:'silence'});},100);
    $('status').textContent='已连接。记忆检索后语音与动作并行，动作侧看不到未来回答。';
  }finally{starting=false;controls();}
}
async function fixture(id=$('fixture').value){
  if(!client.ready||client.blocked||client.inputExhausted||feeding||microphone||replaying)throw Error('当前不能发送语音');
  const entry=manifest.clips.find(x=>x.id===id);if(!entry)throw Error('未知语音素材');
  if(attemptedFixtureIds(allAttempts()).has(id))throw Error('此题已送入过，不会自动重发；请选择未发送的剩余题目。');
  const generation=++inputGeneration;feeding=true;controls();
  try{if(id!=='barge')await framePreflight();const response=await fetch(entry.url??`/parallel-duplex-inputs/${encodeURIComponent(id)}.wav`);if(!response.ok)throw Error('用户问题素材不存在');
    const decoded=await context.decodeAudioData(await response.arrayBuffer());if(decoded.numberOfChannels!==1)throw Error('用户素材必须单声道');
    const pcm=resample16k(decoded.getChannelData(0),decoded.sampleRate),start=now();
    const record={id,text:entry.text,source:'local_synthetic_user_audio',sha256:entry.sha256,startedAt:start,frames:pcm.length,sentPackets:0};(suiteState?.inputs??inputRecords).push(record);
    for(let p=0;p<pcm.length;p+=1600){const chunk=pcm.slice(p,p+1600);await sleep(Math.max(0,start+(p+chunk.length)/16-now()));
      if(generation!==inputGeneration||!client.ready||client.blocked||client.inputExhausted){record.stoppedAt=now();record.complete=false;return false;}
      if(!client.sendAudio(chunk,{source:`fixture:${id}`})){record.complete=false;return false;}record.sentPackets++;if(record.sentPackets===1)rememberAttempt(record);}
    record.completedAt=now();record.complete=true;$('status').textContent='用户问题已送入持续监听；回答由模型现场生成。';return true;
  }finally{feeding=false;controls();}
}
const inputRecords=[];
async function startMic(){
  if(microphone||feeding||suite||replaying||!client.ready||client.blocked)return;
  const generation=++inputGeneration;await checkAudio();await framePreflight();const acquired=await captureMicrophone(context,chunk=>{
    if(generation!==inputGeneration||!client.ready||client.blocked)return;micParts.push(chunk);
    if(micParts.length===5){const packet=new Int16Array(1600);micParts.forEach((part,i)=>packet.set(part,i*320));micParts=[];client.sendAudio(packet,{source:'microphone'});}});
  if(generation!==inputGeneration||!client.ready||client.blocked){acquired.stop();return;}microphone=acquired;controls();
  $('status').textContent='麦克风持续开启，回复时也能开口打断。';
}
function stopMic(){++inputGeneration;microphone?.stop();microphone=null;micParts=[];controls();}
async function close(){if(closing)return;closing=true;try{stopMic();clearInterval(silenceTimer);captureVoice();client.close();await sleep(100);}finally{closing=false;controls();}}
function snapshot(mode=replaying?'replay':'live'){
  const value=client.snapshot();return {mode,reportId:crypto.randomUUID(),experimental:true,savedAt:new Date().toISOString(),client:value,
    turns:value.trials.map(t=>({...t,latency:metrics(t)})),director:director.snapshot(),audio:session.audio.snapshot(),motion:scene.motion.snapshot(),
    environment:{...scene.environment,visibility:document.visibilityState,audioBaseLatency:context.baseLatency,audioOutputLatency:context.outputLatency,sampleRate:context.sampleRate},
    suite:suiteState,inputRecords,persistedAttempts,renderError,preflight:preflightState,source:reportSource,previewEvidence,physicalAcousticsVerified:false,
    measurement:'Input tail is local PCM loud-sample time; first voice is scheduled non-silent PCM marker. Body is actual rendered pose threshold. Planner never receives a target answer.'};
}
async function saveReport(mode=replaying?'replay':'live'){
  const report=snapshot(mode),result=await json('/api/parallel-duplex/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
  savedReports.push({at:now(),name:result.name,mode});$('saved').textContent=`报告已保存：${result.name}`;return {report,result};
}
async function waitUntil(predicate,timeout=90000){const deadline=now()+timeout;while(now()<deadline){
  if(client.blocked)throw Error('调用已停止：'+client.blockReason);if(!client.ready)throw Error('监听连接已关闭');
  const value=predicate();if(value)return value;await sleep(25);}throw Error('等待超时，保留原始记录，不自动重试');}
function checkTurnCount(start,expected=1){if(client.trials.length-start>expected)throw Error('云端将输入拆成多个轮次；停止下一输入，保留记录');}
function checkFrames(t){const m=metrics(t);if(t.renderFrames?.length>5&&!m.renderTimingValid)throw Error('画面被节流；当前记录已保留，请恢复前台后手动继续，不重发已测输入');}
async function runSuite(resume=false){
  if(suite||starting||replaying||feeding||microphone)throw Error('已有输入或测试正在运行');
  const prior=resume?service.completedFixtures??[]:[];
  const sequence=['memory-drink','correction','correction-check','greet','long','barge'];
  const attempted=attemptedFixtureIds(allAttempts());
  if(resume){if(!prior.length||prior.length>4||JSON.stringify(prior)!==JSON.stringify(sequence.slice(0,prior.length))||attempted.size!==prior.length||prior.some(id=>!attempted.has(id))||(client.budget??service.budget)?.turns!==prior.length)throw Error('续测前缀与账本不一致，停止');}
  else if(attempted.size||(client.localReplay?service?.budget:client.budget??service?.budget)?.turns>0)throw Error('已有题目送入过；整批不会从头重测，请手动继续未发送的题目。');
  suite=true;suiteState={startedAt:now(),inputs:[],completed:false,resumedAfter:prior};controls();
  try{
    if(!client.ready)await connect();
    for(const id of ['memory-drink','correction','correction-check','greet']){
      if(prior.includes(id))continue;
      const start=client.trials.length;if(!await fixture(id))throw Error('用户音频未完整送入');
      const turn=await waitUntil(()=>{checkTurnCount(start);return client.trials[start];});
      await waitUntil(()=>{checkTurnCount(start);if(turn.error)throw Error(turn.error);if(turn.revoked)throw Error('正常验收轮被撤销');return turn.settledAt;});
      await saveReport();checkFrames(turn);await sleep(400);
    }
    const start=client.trials.length;if(!await fixture('long'))throw Error('长问题未完整送入');
    const turn=await waitUntil(()=>{checkTurnCount(start);return client.trials[start];});
    await waitUntil(()=>{checkTurnCount(start);if(turn.error||turn.revoked)throw Error(turn.error??'长回复提前撤销');
      const a=session.audio.snapshot();if(turn.settledAt||a.status==='ended')throw Error('长回复已播完，未伪造插话窗口');
      return turn.outputDoneAt&&a.status==='playing'&&a.queuedSeconds>.5&&turn.voiceAt!==undefined;});
    suiteState.bargeTarget=turn.id;suiteState.bargeSentAt=now();
    const next=client.trials.length;if(!await fixture('barge'))throw Error('插话音频未完整送入');
    const reply=await waitUntil(()=>{checkTurnCount(next);return client.trials[next];});
    await waitUntil(()=>{checkTurnCount(next);if(reply.error||reply.revoked)throw Error(reply.error??'插话回复被撤销');return reply.settledAt;});
    suiteState.completed=true;suiteState.endedAt=now();suiteState.bargeRevoked=turn.revoked;
    await saveReport();checkFrames(reply);$('status').textContent='六条用户输入测试完成；报告已保存。';
  }catch(e){suiteState.failure=e.message;suiteState.endedAt=now();error(e);try{await saveReport();}catch{error('测试已停止，报告保存失败，请保留页面。');}}
  finally{suite=false;controls();}
}
async function loadReplays(){
  service=await json('/api/duplex/status');replays.length=0;$('replay-choice').replaceChildren();
  for(const name of service.savedSessions??[]){const record=await json(`/duplex-data/${encodeURIComponent(name)}.json`);
    for(const turn of record.turns??[]){if(!turn.result?.frames&&!record.events.some(e=>e.type==='audio'&&e.turnId===turn.id))continue;replays.push({record,turn});const option=document.createElement('option');option.value=String(replays.length-1);option.textContent=(turn.revoked?'[含实际撤销] ':'')+(turn.text?.slice(0,60)??turn.id);$('replay-choice').append(option);}}
  controls();
}
async function replay(index=+$('replay-choice').value){
  if(suite||replaying||client.ready||client.socket?.readyState<2)throw Error('请先断开实时会话');const item=replays[index];if(!item)throw Error('没有可回放的回复');
  await checkAudio();await framePreflight();reportSource='actual_WAI_parallel_duplex';previewEvidence=null;replaying=true;client=newClient();client.localReplay=true;const connectionId=`parallel-replay-${++replaySerial}`;
  client.message({type:'ready',connectionId,variant:'qwen-direct',actionMode:'parallel',budget:{blocked:false,unknown:0},listenerConfiguration:{}});client.inputExhausted=true;controls();
  const events=replayTurnEvents(item.record,item.turn);
  const start=now(),origin=events[0]?.serverMs??0;
  try{for(const saved of events){await sleep(Math.max(0,start+saved.serverMs-origin-now()));client.message({...saved,connectionId});}
    const deadline=now()+45000;while(now()<deadline&&!['ended','fault','cancelled'].includes(session.audio.snapshot().status))await sleep(25);
    if(modelMode){const end=now()+180000;while(director.hasWork()&&!director.cancelled&&now()<end)await sleep(50);}
    await sleep(1000);if(client.current)client.current.measurementEndedAt??=now();await saveReport('replay');$('status').textContent='真实记录免费回放结束；未写对话历史。';
  }finally{client.ready=false;replaying=false;controls();}
}
async function previewWave(){
  if(suite||replaying||client.ready||client.socket?.readyState<2)throw Error('请先断开实时会话');
  let cachedContext=replays.flatMap(item=>item.record.events).filter(e=>e.type==='action_context').at(-1);
  if(!cachedContext){try{cachedContext=await json('/duplex-data/preview-context.json');}catch{/* explicit missing-context message below */}}
  if(!cachedContext)throw Error('缺少已保存的数学状态快照；没有假装生成当前 WAI 情绪。');
  await checkAudio();await framePreflight();
  const response=await fetch('/duplex-data/preview-greet.wav');if(!response.ok)throw Error('本地问候音频未准备好');
  const wav=await response.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',wav)),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!=='f4067bd23d9e827245aada56473dc89a52edd76f4226b95ba55f0010bbaf983e')throw Error('缓存问候音频校验不符');
  const decoded=await context.decodeAudioData(wav);if(decoded.sampleRate!==24000||decoded.numberOfChannels!==1)throw Error('缓存格式必须为 24k 单声道');
  const pcm=Int16Array.from(decoded.getChannelData(0),value=>Math.max(-32768,Math.min(32767,Math.round(value*32768))));
  replaying=true;reportSource='simulated_plan_cached_audio';previewEvidence={audio:'/duplex-data/preview-greet.wav',sha256:hash,
    instruction:'人工模拟 greet 指令，用于检查既有调度器和挥手轨迹；不代表本轮真实云端延迟。',
    mathContext:'cached_read_only_WAI_snapshot',mathCapturedAt:cachedContext.capturedAt??null,planToAudioInjectionDelayMs:350};
  if(modelMode)previewEvidence.instruction='人工多动作序列和缓存语音，检查同一真实执行队列；不是模型本轮决策或云端延迟。';
  client=newClient();client.localReplay=true;const connectionId=`parallel-local-preview-${++replaySerial}`,turnId=`local-preview-turn-${replaySerial}`;
  const emit=(type,fields={})=>client.message({type,connectionId,turnId,...fields});
  emit('ready',{variant:'qwen-direct',actionMode:'parallel',budget:{blocked:false,unknown:0},listenerConfiguration:{}});client.inputExhausted=true;
  emit('turn_started',{text:'本地预览：请轻快地挥挥手，跟我打个招呼。'});
  emit('action_context',{...cachedContext,type:'action_context',connectionId,turnId,actorState:{...ACTOR_STATE},userText:'请轻快地挥挥手，跟我打个招呼。'});
  const fields={segmentIndex:0,phase:'direct',startFrame:0,providerConnectionId:'local-cached-audio',responseId:`cached-response-${replaySerial}`};
  emit('request_sent',fields);emit('response_created',fields);
  if(!modelMode)emit('action_plan',{planId:`simulated-plan-${replaySerial}`,plannerConnectionId:'local-simulated-planner',plannerResponseId:`simulated-response-${replaySerial}`,
    sourceRole:'planner',intent:'greet',arguments:'{"intent":"greet"}',contextGeneration:cachedContext.contextGeneration,outputFinal:true,expiresInMs:3500});
  if(modelMode)manualModelCommand();
  controls();$('status').textContent='本地模拟动作指令 + 已保存问候音频。可点击“立即打断”；这不是新的云端实测。';
  try{
    await sleep(350);const transcript='回来啦，今天过得怎么样？我在这儿呢。';emit('subtitle',{...fields,delta:transcript});
    for(let p=0;p<pcm.length;p+=2400){emit('audio',{...fields,pcm:pcmBase64(pcm.slice(p,p+2400))});await sleep(25);}
    const segment={index:0,connectionId:fields.providerConnectionId,responseId:fields.responseId,frames:pcm.length,audioDone:true,transcriptDone:true,status:'completed',startFrame:0,phase:'direct'};
    emit('audio_done',fields);emit('response_done',{...fields,result:{...segment,transcript}});
    emit('turn_output_done',{...fields,result:{connectionId:fields.providerConnectionId,responseId:fields.responseId,frames:pcm.length,transcript,status:'completed',audioDone:true,transcriptDone:true,segments:[segment]}});
    const deadline=now()+20000;while(now()<deadline&&!['ended','fault','cancelled'].includes(session.audio.snapshot().status))await sleep(25);
    if(modelMode){const end=now()+180000;while(director.hasWork()&&!director.cancelled&&now()<end)await sleep(50);}
    await sleep(client.current?.revoked?3500:1000);if(client.current)client.current.measurementEndedAt??=now();await saveReport('replay');
    $('status').textContent=modelMode?'动作队列预览结束，报告单独保存；本次是人工指令加缓存音频，没有请求云端，也没有写入真实历史。':'本地挥手预览已结束，模拟结果已单独保存；没有请求云端，也没有写入对话历史。';
  }finally{client.ready=false;replaying=false;controls();}
}
function startRecording(){
  if(recording)throw Error('already_recording');const canvas=$('stage').querySelector('canvas'),stream=canvas.captureStream(30);capture.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:2000000}),parts=[];let resolve;const done=new Promise(r=>resolve=r);
  recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};recorder.onstop=()=>{recordingBlob=new Blob(parts,{type:recorder.mimeType});stream.getVideoTracks().forEach(track=>track.stop());resolve();};
  recording={recorder,done};recorder.start(250);
}
let manualCommandSerial=0;
function manualModelCommand(){
  if(!modelMode||!client.localReplay||!client.current||client.current.revoked)throw Error('人工指令只允许用于本地演示');
  const command=validateCommands(JSON.parse($('model-command').value)),t=client.current;
  client.message({type:'action_plan',connectionId:client.connectionId,turnId:t.id,
    planId:`manual-command-${++manualCommandSerial}`,plannerConnectionId:'local-manual-planner',
    plannerResponseId:`manual-response-${replaySerial}`,sourceRole:'planner',outputFinal:true,
    contextGeneration:t.actionContext.contextGeneration,command});
}
async function stopRecording(){if(!recording)return null;recording.recorder.stop();await recording.done;recording=null;return {bytes:recordingBlob.size};}
async function videoBase64(){if(!recordingBlob)return null;return new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(';base64,')[1]);r.readAsDataURL(recordingBlob);});}
async function boot(){
  [service,manifest]=await Promise.all([json('/api/duplex/status'),json('/api/parallel-duplex/input-manifest')]);
  try{const saved=JSON.parse(localStorage.getItem(attemptKey())??'[]');if(Array.isArray(saved))persistedAttempts=saved.filter(x=>manifest.clips.some(c=>c.id===x.id)&&x.sentPackets>0);}catch{/* no stored attempts */}
  for(const id of service.completedFixtures??[])if(!persistedAttempts.some(x=>x.id===id))persistedAttempts.push({id,sentPackets:1,source:'verified_restored_history'});
  for(const clip of manifest.clips){const option=document.createElement('option');option.value=clip.id;option.textContent=clip.text;$('fixture').append(option);}
  context=new AudioContext({sampleRate:24000,latencyHint:'interactive'});mix=context.createGain();mix.gain.value=.16;mix.connect(context.destination);capture=context.createMediaStreamDestination();mix.connect(capture);
  const host={get state(){return context.state;},get currentTime(){return context.currentTime;},destination:mix,resume:()=>context.resume(),createBuffer:(...a)=>context.createBuffer(...a),createBufferSource:()=>context.createBufferSource(),createGain:()=>context.createGain()};
  scene=await createScene($('stage'),text=>$('loading').textContent=text,{motionFactory:o=>new (modelMode?ModelMotionController:VoicedPreparedMotionController)(o),faceFactory:()=>new (modelMode?ModelFaceController:VoicedPreparedFaceController)()});scene.setExpressionEnabled(false);
  session=new LiveAvatarSession({context:host,face:scene.face,motion:scene.motion,naturalConversation:false});session.audio.setVolume(1);
  director=new (modelMode?ModelActionDirector:ParallelActionDirector)({session,onDecision:directorDecision});client=newClient();client.blocked=!!service.budget?.blocked;
  const action=fn=>()=>Promise.resolve().then(fn).catch(error);$('connect').onclick=action(connect);$('suite').onclick=action(runSuite);$('feed').onclick=action(()=>fixture());$('mic').onclick=action(startMic);$('sound').onclick=action(soundCheck);$('preview-wave').onclick=action(previewWave);$('fixture').onchange=controls;
  $('resume-suite').onclick=action(()=>runSuite(true));
  $('stop-mic').onclick=stopMic;$('disconnect').onclick=action(close);$('cancel').onclick=()=>{captureVoice();client.cancel();};$('send').onclick=()=>client.sendText($('text').value);
  $('save').onclick=action(()=>saveReport());$('replay').onclick=action(()=>replay());$('refresh').onclick=action(loadReplays);
  $('volume').oninput=()=>mix.gain.value=+$('volume').value;for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>scene.setView(button.dataset.view);
  if(modelMode){$('model-send').onclick=action(manualModelCommand);
    $('model-pause').onclick=()=>{director.paused=!director.paused;director.userPaused=director.paused;if(director.paused)session.pause();else session.resume();$('model-pause').textContent=director.paused?'继续动作 / 语音':'暂停动作 / 语音';};
    $('model-stop').onclick=()=>{director.clear('local_demo_clear');};
    $('record-start').onclick=()=>{startRecording();$('record-start').disabled=true;$('record-stop').disabled=false;};
    $('record-stop').onclick=action(async()=>{await stopRecording();const link=$('record-download');link.href=URL.createObjectURL(recordingBlob);link.hidden=false;$('record-start').disabled=false;$('record-stop').disabled=true;});
    $('catalog').textContent=Object.entries(MODEL_ACTIONS).map(([key,row])=>`${key} — ${row.label}`).join('\n');}
  ready=true;$('loading').remove();$('status').textContent=service.cloudEnabled?'人物已就绪。点击连接才开始真实监听。':'人物已就绪，云端调用未启用。';requestAnimationFrame(frame);await loadReplays();controls();
  window.parallelDuplex={ready:true,connect,fixture,startMic,stopMic,close,runSuite,replay,previewWave,saveReport,snapshot,startRecording,stopRecording,videoBase64,soundCheck,
    cancel:()=>{captureVoice();return client.cancel();},get state(){return {ready:client.ready,blocked:client.blocked,suite,replaying,current:client.current?{...client.current,driver:undefined}:null,audio:session.audio.snapshot(),director:director.snapshot()};}};
}
window.addEventListener('pagehide',()=>{stopMic();clearInterval(silenceTimer);client?.close();session?.dispose();});boot().catch(error);
