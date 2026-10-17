import { createScene } from '../qwen/scene.mjs';
import { LiveAvatarSession } from '../qwen/live-session.mjs';
import { captureMicrophone, resample16k } from '../qwen/input-audio.mjs';
import { DuplexClient } from './client.mjs';
import { C, VOWELS } from '/preview/core/profile.js';
const $ = id => document.getElementById(id), now = () => performance.now();
let scene, session, client, context, mix, capture, rendered, frameAt = now(), lastUi = 0;
let silenceTimer, feeding = false, microphone, micParts = [], generation = 0, ready = false;
let recording, recordingBlob, trace = [], frameRows = [], service, replaying = false, replaySerial = 0;
const savedTurns = [];
const reportError = e => { $('status').textContent = e.message ?? String(e); };
const round = n => Number.isFinite(n) ? n.toFixed(1) : '—';
function event(e) {
  if (['blocked','closed','input_exhausted'].includes(e.type)) { stopMic(); clearInterval(silenceTimer); }
  if (e.type === 'client_error') reportError(e.code);
  const s = e.event;
  if (s?.type === 'input_partial') $('input').textContent = (s.text ?? '') + (s.stash ?? '');
  if (s?.type === 'input_final') $('input').textContent = s.transcript;
  if (s?.type === 'turn_started') { $('pipeline').textContent = '检索记忆、准备上下文'; $('answer').textContent = ''; }
  if (s?.type === 'context_ready') $('pipeline').textContent = '记忆已就绪，Qwen 正在回复';
  if (s?.type === 'handoff_requested') $('pipeline').textContent = 'Qwen 请求完整分析，准备第二段回复';
  if (s?.type === 'response_created' && s.segmentIndex === 1) $('pipeline').textContent = '第二个 Qwen 已接入，语音按顺序播放';
  if (s?.type === 'turn_output_done') $('pipeline').textContent = '本轮生成完成，等待实际播放结束';
  if (s?.type === 'tool') $('plan').textContent = JSON.stringify(JSON.parse(s.arguments), null, 2);
  if (s?.type === 'settled') $('pipeline').textContent = '已播完，回复已结算';
}
function updateUI() {
  const t = client.current, a = session.audio.snapshot();
  const budget = client.budget ?? service?.budget;
  const batchExhausted = budget && (budget.turns >= budget.turnLimit || budget.responses + (budget.reserved ?? 0) >= budget.responseLimit);
  $('connect').disabled = !ready || replaying || client.ready || (client.blocked && !client.canReconnect) || budget?.blocked || batchExhausted || service?.offline;
  for (const id of ['mic', 'feed', 'send']) $(id).disabled = !client.ready || client.blocked || client.inputExhausted;
  $('stop-mic').disabled = !microphone;
  $('phase').textContent = replaying ? '离线回放 · 不调用模型' : client.blocked ? '新调用已停止 · 本地记录保留' : a.status === 'playing' ? '正在回应 · 仍在持续接收语音' : a.status === 'paused' ? '听到声音，暂时停下' : client.ready ? '正在倾听' : '未连接';
  if (t) {
    $('caption').textContent = t.transcript; $('answer').textContent = t.transcript || '…';
    $('latency').textContent = round(t.playbackAt - t.input?.lastSpeechAt);
    $('prepare').textContent = round(t.context?.preparationMs);
    $('motion-delay').textContent = round(t.motionAt - t.playbackAt);
    $('face-delay').textContent = round(t.expressionAt - t.playbackAt);
    if(t.error){$('pipeline').textContent='本轮未完成';$('status').textContent=t.error==='reply_has_no_complete_speech'?'模型本轮没有给出完整语音，失败记录已保留。':t.error;}
  }
  const b = client.budget ?? service?.budget;
  if (b) $('budget').textContent = `${b.blocked ? '本批暂停：有未知用量。' : '有界实验：'} 回复 ${b.turns}/${b.turnLimit} · Qwen 响应 ${b.responses}/${b.responseLimit} · 未知 ${b.unknown}`;
  $('diagnostics').textContent = JSON.stringify({ turn: t ? { text:t.text, variant:t.variant, context:t.context, contexts:t.contexts,
    handoff:t.handoff, segments:t.segments, tools:t.tools, result:t.result, settledAt:t.settledAt, error:t.error } : null,
    interruptions:client.interruptions, inputPackets:client.sequence, budget:b }, null, 2);
}
async function loadReplays() {
  const status=await(await fetch('/api/duplex/status')).json();service=status;
  for(const name of status.savedSessions){
    const record=await(await fetch(`/duplex-data/${name}.json`)).json();
    for(const turn of record.turns.filter(t=>t.result?.frames>0)){
      savedTurns.push({record,turn});
      const option=document.createElement('option');option.value=String(savedTurns.length-1);
      option.textContent=`${turn.revoked?'中断':'语音'} · ${turn.text.slice(0,36)}`;$('replay-choice').append(option);
    }
  }
  $('replay').disabled=!savedTurns.length;
}
async function replay(index=+$('replay-choice').value) {
  if(replaying||client.socket?.readyState<2)throw Error('请先断开实时会话，再回放。');
  const item=savedTurns[index];if(!item)throw Error('没有可回放的语音');
  await context.resume();
  stopMic();clearInterval(silenceTimer);replaying=true;trace=[];frameRows=[];
  // Same PCM, tool validation and scheduler, without a websocket or delivery ACK.
  client=new DuplexClient({session,onEvent:event});
  const connectionId=`replay-${++replaySerial}`;
  client.message({type:'ready',connectionId,listenerConfiguration:{},budget:service.budget,variant:item.record.variant??item.turn.variant});client.inputExhausted=true;
  const terminal=item.record.events.findLast(e=>e.turnId===item.turn.id&&['turn_output_done','response_done'].includes(e.type));
  const contentEnd=(terminal?.serverMs??Infinity)+(item.turn.result.frames/24)+2000;
  const events=item.record.events.filter(e=>e.turnId===item.turn.id&&!['delivery','settled','runtime_state','wai_submitted'].includes(e.type)
    &&!(e.type==='revoked'&&e.serverMs>contentEnd));
  const origin=events[0].serverMs,start=now();
  try {
    $('status').textContent=service?.offline?'离线协议演示：历史音频拼接，转交事件为模拟，不是本版云端结果。':'离线回放本批真实事件。不会请求模型或写入已送达历史。';
    $('input').textContent=item.turn.text;
    for(const saved of events){
      await new Promise(r=>setTimeout(r,Math.max(0,start+saved.serverMs-origin-now())));
      if(client.current?.revoked)break;
      client.message({...saved,connectionId});
    }
    const deadline=now()+36000;
    while(now()<deadline&&!client.current?.revoked&&!['ended','fault','cancelled'].includes(session.audio.snapshot().status))
      await new Promise(r=>setTimeout(r,40));
    return snapshot();
  } finally {client.ready=false;replaying=false;}
}
function frame(time) {
  const dt = Math.min(.05, Math.max(0, (time-frameAt)/1000)); frameAt = time;
  try {
    client.sync(); const audio = session.audio.snapshot(), visual = session.visualState(audio);
    rendered = scene.step(time, dt, session.lipSample(audio), { ...visual, idle:true });
    const motion = scene.motion.snapshot(), t = client.current;
    if (t && !t.revoked && session.owner === t.owner) {
      t.baselineWeights ??= Array.from(rendered.weights);
      if (audio.status === 'playing' && rendered.mouthOpen > .04) t.mouthAt ??= now();
      if (t.tools.some(x=>x.result?.accepted)) {
        if (motion.execution?.lastDisplayed?.id?.startsWith(`fc:e${t.owner.epoch}.`)
          || motion.gestures.some(g=>g.id?.startsWith(`fc:e${t.owner.epoch}.`) && !g.recovering && g.age > 0)) t.motionAt ??= now();
        if (Object.entries(C).some(([name,index])=>name!=='blink' && !VOWELS.includes(index) && Math.abs(rendered.weights[index]-t.baselineWeights[index])>.025)) t.expressionAt ??= now();
      }
    }
    for (const stop of client.interruptions) {
      if (stop.turnId !== client.current?.id) continue;
      if (rendered.mouthOpen <= .01) stop.mouthClosedMs ??= now()-stop.at;
      if (!motion.gestures.length && !motion.reactions.length && motion.interactionPose.handsSettled) stop.motionStoppedMs ??= now()-stop.at;
      stop.sourcesRemain = audio.sourceCount;
    }
    frameRows.push({at:time,driver:rendered.driverMs,render:rendered.renderMs,interval:dt*1000});
    if (frameRows.length > 15000) frameRows.shift();
    if (!trace.length || time-trace.at(-1).at>40) { trace.push({at:time,turnId:t?.id,audio:{status:audio.status,time:audio.time,sources:audio.sourceCount},mouth:rendered.mouthOpen,
      gestures:motion.gestures,reactions:motion.reactions,pose:motion.interactionPose,bones:rendered.bones}); if(trace.length>10000)trace.shift(); }
    if (time-lastUi>250) { updateUI(); lastUi=time; }
  } catch (e) { reportError(e); client.cancel('render_error'); }
  requestAnimationFrame(frame);
}
async function connect(variant=$('variant')?.value ?? 'full-cold') {
  if (service?.offline) throw Error('本页仅为离线协议演示，不提供云端连接。');
  const url = new URL('/api/duplex', location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  url.searchParams.set('variant',variant);
  await context.resume(); const reply = await client.connect(url.href);
  clearInterval(silenceTimer);
  silenceTimer = setInterval(()=>{ if(client.ready&&!client.blocked&&!feeding&&!microphone)client.sendAudio(new Int16Array(1600),{source:'silence'}); },100);
  $('status').textContent = '已连接持续监听。可以送入测试问题，或开启麦克风自由对话。'; return reply;
}
async function fixture(name=$('fixture').value) {
  if (!client.ready || client.blocked || feeding || microphone) throw Error('input_not_ready');
  const ownGeneration = ++generation; feeding=true;
  try {
    const response=await fetch(`/duplex-data/${encodeURIComponent(name)}.wav`);if(!response.ok)throw Error('fixture_missing');
    const decoded=await context.decodeAudioData(await response.arrayBuffer());
    const pcm=resample16k(decoded.getChannelData(0),decoded.sampleRate), started=now();
    const source=context.createBufferSource();source.buffer=decoded;source.connect(mix);source.start();
    for(let p=0;p<pcm.length;p+=1600){
      const chunk=pcm.slice(p,p+1600);
      await new Promise(r=>setTimeout(r,Math.max(0,started+(p+chunk.length)/16-now())));
      if(ownGeneration!==generation||!client.ready||client.blocked){source.stop();return false;}
      if(!client.sendAudio(chunk,{source:`fixture:${name}`})){source.stop();return false;}
    }
    $('status').textContent='问题已送入，持续监听保持开启。';return true;
  } finally {feeding=false;}
}
async function startMic() {
  if (!client.ready || feeding || microphone || client.blocked) return false;
  const ownGeneration=++generation;
  const captured=await captureMicrophone(context,chunk=>{
    if(ownGeneration!==generation||!client.ready||client.blocked)return;
    micParts.push(chunk);
    if(micParts.length>=5){const packet=new Int16Array(1600);micParts.forEach((p,i)=>packet.set(p,i*320));micParts=[];client.sendAudio(packet);}
  });
  if(ownGeneration!==generation||!client.ready||client.blocked){captured.stop();return false;}
  microphone=captured;$('status').textContent='麦克风持续开启。人物回应时也可以说话。';return true;
}
function stopMic() { ++generation;microphone?.stop();microphone=null;micParts=[]; }
function close() { stopMic();clearInterval(silenceTimer);client?.close(); }
function snapshot() {return {client:client.snapshot(),audio:session.audio.snapshot(),session:session.snapshot(),motion:scene.motion.snapshot(),rendered,
  trace:structuredClone(trace),frames:structuredClone(frameRows),environment:scene.environment,
  acousticVerified:false,syntheticMemory:true,source:service?.offline?'offline_protocol_fixture':'actual_WAI_D_duplex'};}
function startRecording(label='真实对话') {
  if(recording)throw Error('already_recording');
  // Capture the submitted WebGL canvas directly. Copying it to a second 2D
  // canvas can record transparent frames on the WebGPU renderer's GL backend.
  const canvas=$('stage').querySelector('canvas'),stream=canvas.captureStream(30);
  capture.stream.getAudioTracks().forEach(t=>stream.addTrack(t));
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:2000000}),parts=[];
  let resolve;const done=new Promise(r=>resolve=r);recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
  recorder.onstop=()=>{recordingBlob=new Blob(parts,{type:recorder.mimeType});stream.getVideoTracks().forEach(t=>t.stop());resolve();};
  recording={canvas,recorder,done,label,startedAt:now()};recorder.start(250);return recording.startedAt;
}
async function stopRecording() {if(!recording)return null;const r=recording;r.recorder.stop();await r.done;recording=null;return {bytes:recordingBlob.size,startedAt:r.startedAt,endedAt:now(),capture:'renderer_canvas_direct',width:r.canvas.width,height:r.canvas.height};}
async function videoBase64(){if(!recordingBlob)return null;return await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.slice(r.result.indexOf(';base64,')+8));r.readAsDataURL(recordingBlob);});}
async function boot(){
  service=await(await fetch('/api/duplex/status')).json();
  if (service.offline) {
    $('status').textContent='离线协议演示：历史音频拼接，转交事件为模拟，不是本版云端结果。';
    document.querySelector('.notice').textContent='离线协议演示：历史音频拼接，转交事件为模拟，不是本版云端结果。只验收顺序播放、动作时序和整轮打断，不代表云端响应速度。';
    $('replay').textContent='播放离线协议演示';
    $('replay-choice').setAttribute('aria-label','离线协议演示片段');
  }
  if($('variant')){
    const labels={'full-cold':'完整前置 · 原连接方式','full-warm':'完整前置 · 连接预热',
      'memory-warm':'旧实验 · DeepSeek 短答后 Qwen 配音','qwen-direct':'新实验 · Qwen 直接记忆快答与按需转交'};
    $('variant').replaceChildren(...(service.variants??['full-cold']).map(v=>{const o=document.createElement('option');o.value=v;o.textContent=labels[v];return o;}));
    $('variant').value=(service.variants??[]).includes('qwen-direct')?'qwen-direct':(service.variants??[]).includes('memory-warm')?'memory-warm':'full-cold';
    if(service.variants)document.querySelector('a[href="./results.html"]')?.setAttribute('href',
      service.variants.includes('qwen-direct') ? './direct-results.html' : './fast-results.html');
  }
  context=new AudioContext({sampleRate:24000,latencyHint:'interactive'});mix=context.createGain();mix.gain.value=.16;mix.connect(context.destination);
  capture=context.createMediaStreamDestination();mix.connect(capture);
  const host={get state(){return context.state;},get currentTime(){return context.currentTime;},destination:mix,resume:()=>context.resume(),createBuffer:(...a)=>context.createBuffer(...a),createBufferSource:()=>context.createBufferSource(),createGain:()=>context.createGain()};
  scene=await createScene($('stage'),text=>$('loading').textContent=text);
  session=new LiveAvatarSession({context:host,face:scene.face,motion:scene.motion,naturalConversation:false});
  session.audio.setVolume(1);client=new DuplexClient({session,onEvent:event});client.blocked=service.budget.blocked;
  ready=true;$('loading').remove();requestAnimationFrame(frame);
  $('connect').onclick=()=>connect().catch(reportError);$('feed').onclick=()=>fixture().catch(reportError);
  $('mic').onclick=()=>startMic().catch(reportError);$('stop-mic').onclick=stopMic;$('disconnect').onclick=close;
  $('cancel').onclick=()=>client.cancel();$('send').onclick=()=>client.sendText($('text').value);
  $('replay').onclick=()=>replay().catch(reportError);loadReplays().catch(reportError);
  $('volume').oninput=()=>mix.gain.value=+$('volume').value;for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>scene.setView(b.dataset.view);
  window.__duplex={ready:true,connect,fixture,startMic,stopMic,close,cancel:()=>client.cancel(),snapshot,
    startRecording,stopRecording,videoBase64,replay,get savedCount(){return savedTurns.length;},get state(){return {ready:client.ready,blocked:client.blocked,current:client.current?{...client.current,driver:undefined}:null,audio:session.audio.snapshot(),motion:scene.motion.snapshot()};}};
}
window.addEventListener('pagehide',()=>{close();session?.dispose();});boot().catch(reportError);
