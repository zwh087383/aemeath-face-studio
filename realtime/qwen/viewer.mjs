import { createScene } from './scene.mjs';
import { LiveAvatarSession } from './live-session.mjs';
import { QwenClient } from './client.mjs';
import { captureMicrophone, resample16k, rms16 } from './input-audio.mjs';
import { C, PRESET_BY_ID, VOWELS } from '/preview/core/profile.js';
const $ = id => document.getElementById(id), now = () => performance.now();
let scene, session, client, context, ready = false, error = null, rendered, lastFrame = 0, lastUI = 0, admissionBlocked=false;
let microphone, micStarting = false, micGeneration = 0, micParts = [], loudChunks = 0, feedGeneration = 0, inputTranscript = '', interruptions = [], rows = [], eventLog = [], connections = [];
const bounded = (list, item, max = 6000) => { list.push(item); if (list.length > max) list.shift(); };
const activeAudio = () => ['playing', 'buffering', 'paused'].includes(session?.audio.snapshot().status);
const settings = () => ({ sidecar: $('sidecar').checked, profile: $('profile').value });
const mark = (t, key, value = now()) => { if (t && t[key] == null) t[key] = value; };
function reportError(e) { error = e.message || String(e); $('message').textContent = error; }
function observe(event) {
  bounded(eventLog, event, 256);
  const t = event.owner ? client?.trials.find(trial=>trial.owner?.connectionId===event.owner.connectionId && trial.owner?.responseId===event.owner.responseId && trial.owner?.epoch===event.owner.epoch) : null;
  if (event.type === 'cue' && event.accepted && t) {
    t.cues ??= []; bounded(t.cues, { ...event.cue, atMs: event.atMs }, 64); mark(t, 'firstCueAt', event.atMs);
    if(event.cue.kind==='expression' && !t.expressionBaseline) {t.expressionBaseline=rendered?.weights.slice();t.expressionPreset=event.cue.preset;}
    if(event.cue.kind==='gesture' && !t.gestureBaseline) t.gestureBaseline=structuredClone(rendered?.bones);
  }
  if (event.type === 'cancel' && t && t.cancelAt !== null) startInterrupt(event.reason || 'cancel', event.atMs, t);
}
function startInterrupt(reason, time = now(), t = client?.currentTrial) {
  if (!t || interruptions.at(-1)?.responseId === t.responseId) return;
  const body = scene.motion.snapshot(), audio = session.audio.snapshot();
  const item = { responseId: t.responseId, atMs: time, reason, mouthBefore: rendered?.mouthOpen ?? 0,
    gesturesBefore: body.gestures.map(g => g.gesture), sourceCountAfter: audio.sourceCount, queuedAfter: session.scheduler.snapshot().queued,
    mouthClosedMs: null, retractCompleteMs: null };
  interruptions.push(item); if (interruptions.length > 20) interruptions.shift();
}
function interrupt(reason = 'user_interrupt') {
  const time = now(), mouth = rendered?.mouthOpen, body = scene?.motion.snapshot();
  const accepted = client?.cancel(reason); startInterrupt(reason, time);
  const item = interruptions.at(-1); if (accepted && item) { item.mouthBefore = mouth; item.gesturesBefore = body.gestures.map(g => g.gesture); item.localCancelReturnMs = now() - time; item.sourceCountAfter = session.audio.snapshot().sourceCount; }
  return accepted;
}
function stopInput() { feedGeneration++; micGeneration++; micStarting=false; microphone?.stop(); microphone = null; micParts = []; loudChunks = 0; $('input-state').textContent = '麦克风关闭'; }
function handleClient(event) {
  bounded(eventLog, { ...event, event: event.event ? { type: event.event.type } : undefined }, 256);
  if (event.type === 'error') { if(event.code==='usage_unknown_admission_blocked')admissionBlocked=true;reportError(event.code || event.message || '连接错误'); stopInput(); }
  if (event.type === 'closed') stopInput();
  if (event.type === 'provider') {
    const e = event.event;
    if (e?.type === 'conversation.item.input_audio_transcription.completed') inputTranscript = e.transcript || '';
    if (e?.type === 'conversation.item.input_audio_transcription.delta') inputTranscript = (e.text || '') + (e.stash || '');
  }
}
function timings(t) {
  if (!t) return {};
  const diff = (end, start) => Number.isFinite(t[end]) && Number.isFinite(t[start]) ? +(t[end] - t[start]).toFixed(1) : null;
  const base = t.kind !== 'text' ? 'inputLastSpeechAt' : 'submittedAt';
  return { kind: t.kind, status: t.status, responseId: t.responseId,
    inputEndToFirstPcmMs: diff('firstPcmAt', base), inputEndToFirstSubtitleMs: diff('firstSubtitleAt', base),
    inputEndToPlaybackMs: diff('firstPlaybackAt', base), firstPcmToPlaybackMs: diff('firstPlaybackAt', 'firstPcmAt'),
    firstPcmToMouthMs: diff('firstMouthAt', 'firstPcmAt'), firstSubtitleToCueMs: diff('firstCueAt', 'firstSubtitleAt'),
    firstSubtitleToExpressionMs: diff('firstExpressionRenderedAt', 'firstSubtitleAt'), firstSubtitleToGestureMs: diff('firstGestureRenderedAt', 'firstSubtitleAt'),
    inputEndToProviderDoneMs: diff('providerDoneAt', base), inputEndToPlaybackEndedMs: diff('playbackEndedAt', base),
    usage: t.usage ?? 'unknown' };
}
function performanceSummary() {
  const percentile = (key, p) => { const v = rows.map(r => r[key]).sort((a,b) => a-b); return v.length ? +v[Math.min(v.length-1, Math.floor(v.length*p))].toFixed(3) : null; };
  return { frames: rows.length, fps: rows.length > 1 ? +((rows.length-1)*1000/(rows.at(-1).at-rows[0].at)).toFixed(2) : null,
    driverP95Ms: percentile('driver',.95), renderP95Ms: percentile('render',.95), frameP95Ms: percentile('frame',.95),
    stage: { width: $('stage').clientWidth, height: $('stage').clientHeight, dpr: Math.min(devicePixelRatio,1.5) } };
}
function snapshot() { return { ready, error, client: client?.snapshot(), session: session?.snapshot(), rendered, face: scene?.face.snapshot(), motion: scene?.motion.snapshot(),
  trials: client?.trials.map(t => ({ ...t, latency: timings(t) })), interruptions: structuredClone(interruptions), performance: performanceSummary(), environment: scene?.environment,
  audioContext: context ? { sampleRate: context.sampleRate, baseLatency: context.baseLatency, outputLatency: context.outputLatency, state: context.state } : null,
  inputTranscript, connections: structuredClone(connections), events: eventLog.slice(-64), boundary: 'Browser monotonic/WebAudio and rendered morph/bones; no measured physical acoustic latency. PCM coarse mouth; subtitle chunk boundary, not phoneme/word alignment. Input end is final above-threshold packet submission: fixture 100ms, mic 20ms granularity.' }; }
function updateUI() {
  const t = client?.currentTrial, a = session?.audio.snapshot(), body = scene?.motion.snapshot(), lat = timings(t);
  const pending=!!t && !t.revoked && ['input','submitted'].includes(t.phase);
  $('state').textContent = client?.ready ? `Qwen 已连接 · ${a?.status}` : '未连接';
  $('send').disabled = !client?.ready || activeAudio() || pending; $('cancel').disabled = !activeAudio() && !pending; $('disconnect').disabled = !client?.ready;
  $('connect').disabled = !ready || client?.ready || admissionBlocked; $('mode').disabled = !!client?.ready;
  $('fixture').disabled = !client?.ready || activeAudio() || pending || !!microphone || micStarting; $('mic').disabled = !client?.ready || !!microphone || micStarting || pending; $('stop-mic').disabled = !microphone && !micStarting;
  $('live-subtitle').textContent = t?.transcript || '等待真实回复…'; $('input-transcript').textContent = inputTranscript || '用户输入字幕会显示在这里';
  $('expression-name').textContent = scene?.face.snapshot().preset || '自然'; $('gesture-name').textContent = body?.gestures.map(g => `${g.name} · ${g.phase}`).join(' / ') || '放松 · 呼吸';
  $('motion-phase').textContent = body?.gestures.map(g => `${g.gesture}:${g.phase}`).join(' / ') || '没有进行中的手势'; $('sidecar-state').textContent = `旁路 ${session?.sidecar.status}`;
  if(t) t.sessionMetrics=session.snapshot().metrics;
  const perf = performanceSummary(); $('fps').textContent = perf.fps ?? '—'; $('driver').textContent = perf.driverP95Ms ?? '—'; $('mouth').textContent = rendered?.mouthOpen.toFixed(2) ?? '—'; $('latency').textContent = lat.inputEndToPlaybackMs ?? '—';
  $('timings').textContent = JSON.stringify(lat, null, 2); $('diagnostics').textContent = JSON.stringify({ connectionId: client?.connectionId, audio: a, scheduler: session?.snapshot().scheduler, error }, null, 2);
  const stop = interruptions.at(-1); if (stop) $('interrupt-result').textContent = `本地返回 ${stop.localCancelReturnMs?.toFixed(1) ?? '—'} ms · 收口 ${stop.mouthClosedMs?.toFixed(1) ?? '—'} ms · 收势 ${stop.retractCompleteMs?.toFixed(1) ?? '—'} ms`;
}
function frame(time) {
  try {
    const interval = lastFrame ? time-lastFrame : 16, dt = Math.min(.05, interval/1000); lastFrame = time;
    const start = now(), a = session.sync(); rendered = scene.step(time, dt, session.lipSample(a)); const body = scene.motion.snapshot(), t = client.currentTrial;
    bounded(rows, { at: time, frame: interval, driver: rendered.driverMs + (now()-start-rendered.driverMs-rendered.renderMs), render: rendered.renderMs });
    if (t && t.responseId && t.responseId === session.owner?.responseId) {
      if (a.sourceActive) mark(t,'firstPlaybackAt',now());
      if (a.status === 'playing' && rendered.mouthOpen > .04) mark(t,'firstMouthAt',now());
      if (a.status === 'ended') mark(t,'playbackEndedAt',now());
      if (t.expressionBaseline && scene.face.snapshot().preset === t.expressionPreset && Object.keys(PRESET_BY_ID[t.expressionPreset]?.morphs || {}).some(key=>!VOWELS.includes(C[key]) && key!=='blink' && Math.abs(rendered.weights[C[key]]-t.expressionBaseline[C[key]])>.015)) mark(t,'firstExpressionRenderedAt',now());
      if (t.gestureBaseline && body.gestures.some(g=>g.phase !== 'retract') && Object.entries(rendered.bones).some(([k,v])=>v.some((x,i)=>Math.abs(x-t.gestureBaseline[k][i])>.01))) mark(t,'firstGestureRenderedAt',now());
      t.peakMouth = Math.max(t.peakMouth || 0, rendered.mouthOpen);
    }
    const stop = interruptions.at(-1);
    if (stop && stop.responseId === session.owner?.responseId) {
      if (stop.mouthClosedMs == null && rendered.mouthOpen <= .01) stop.mouthClosedMs = now()-stop.atMs;
      if (stop.retractCompleteMs == null && body.gestures.length === 0) stop.retractCompleteMs = now()-stop.atMs;
      stop.sourcesRemain = a.sourceCount; stop.mouthAfter = rendered.mouthOpen;
    }
    if (time-lastUI > 200) { updateUI(); lastUI = time; }
    requestAnimationFrame(frame);
  } catch (e) { reportError(e); client?.cancel('render_error'); stopInput(); }
}
async function connect(mode = $('mode').value) { if(admissionBlocked)throw new Error('当前实验批次存在未知用量，已暂停新云请求');error=null;const at=now(); await client.connect(mode);$('mode').value=mode;bounded(connections,{connectionId:client.connectionId,mode,startedAt:at,readyAt:now(),connectMs:now()-at},20); $('message').textContent = '已连接。文字、测试语音和麦克风均会产生真实云请求。'; return true; }
function sendText(text = $('prompt').value, options = settings()) { error=null; const result=client.sendText(text,options); if(!result) throw new Error('当前会话尚未就绪或上一轮尚未结束');$('prompt').value=text; return result; }
async function fixture(name=null, { interruptOutput=false, trimLeadingSilence=false, ...options } = {}) {
  if (!client.ready) throw new Error('请先连接');
  name??=client.mode==='vad'?'continuous':'greeting';
  if(!interruptOutput && client.currentTrial && !client.currentTrial.revoked && ['input','submitted'].includes(client.currentTrial.phase)) throw new Error('已有输入等待提交或生成');
  const generation = ++feedGeneration, bytes = await (await fetch(`./fixtures/${name}.wav`)).arrayBuffer();
  const audio = await context.decodeAudioData(bytes);let pcm = resample16k(audio.getChannelData(0),audio.sampleRate), trimmedFrames=0;
  if(trimLeadingSilence) {while(trimmedFrames+320<pcm.length && rms16(pcm.subarray(trimmedFrames,trimmedFrames+320))<=.015)trimmedFrames+=320;pcm=pcm.subarray(trimmedFrames);}
  if(generation!==feedGeneration || !client.ready) return false;
  const t = interruptOutput ? client.currentTrial : client.prepareInput({...settings(),...options});
  if (!t) throw new Error('当前回复未结束');
  if(interruptOutput)t.interruptInputLeadingTrimMs=trimmedFrames/16;
  if (!interruptOutput) { t.kind='audio-fixture'; t.fixture=name; t.inputStartAt=now(); }
  const started=now(); let firstLoud=false;
  for(let position=0;position<pcm.length;position+=1600) {
    if(generation!==feedGeneration || !client.ready) return false;
    const chunk=pcm.slice(position,position+1600), level=rms16(chunk);
    if (level>.015) {
      if(interruptOutput && !firstLoud) { firstLoud=true; interrupt('fixture_local_vad'); }
      else if(!interruptOutput && client.currentTrial?.phase==='input') {client.currentTrial.kind='audio-fixture';client.currentTrial.fixture=name;client.currentTrial.inputLastSpeechAt=now();}
    }
    if (!client.sendInput(chunk)) return false;
    $('input-state').textContent=`测试音频 ${(position/16000).toFixed(1)} / ${(pcm.length/16000).toFixed(1)} s`;
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,started+(position+chunk.length)/16-now())));
  }
  if(!interruptOutput) { t.inputEndAt=now(); if(client.mode==='manual') client.commit({...settings(),...options}); }
  $('input-state').textContent='测试音频已送完'; return true;
}
async function startMic() {
  if(!client.ready || microphone || micStarting) return false;
  const generation=++micGeneration, connectionId=client.connectionId;micStarting=true;
  try { const captured=await captureMicrophone(context,(chunk,level)=>{
    if(generation!==micGeneration) return;
    if(!client.ready) {stopInput();return;}
    loudChunks=level>.02?loudChunks+1:0;
    if(loudChunks>=3 && $('local-vad').checked && activeAudio()) interrupt('microphone_local_vad');
    if(level>.02 && client.currentTrial && client.currentTrial.kind!=='text' && client.currentTrial.phase==='input') {client.currentTrial.kind='audio-microphone';client.currentTrial.inputLastSpeechAt=now();}
    micParts.push(chunk);
    if(micParts.length>=5) { const packet=new Int16Array(1600);micParts.forEach((p,i)=>packet.set(p,i*320));client.sendInput(packet);micParts=[]; }
  });
  if(generation!==micGeneration || !client.ready || client.connectionId!==connectionId){captured.stop();return false;}
  if(!activeAudio()) { const t=client.prepareInput(settings()); if(!t){captured.stop();return false;}t.kind='audio-microphone';t.inputStartAt=now(); }
  microphone=captured;$('input-state').textContent='麦克风开启 · 正在发送给 Qwen'; return true;
  } finally {if(generation===micGeneration)micStarting=false;}
}
function finishMic() {
  if(micParts.length && client.ready) {const packet=new Int16Array(micParts.length*320);micParts.forEach((p,i)=>packet.set(p,i*320));client.sendInput(packet);}
  stopInput(); if(client.currentTrial) client.currentTrial.inputEndAt=now(); if(client.mode==='manual') return client.commit(settings()); return true;
}
function disconnect() {stopInput();client?.close();}
$('connect').onclick=()=>connect().catch(reportError);$('send').onclick=()=>{try{sendText();}catch(e){reportError(e);}};
$('cancel').onclick=()=>{stopInput();interrupt();};$('disconnect').onclick=disconnect;$('fixture').onclick=()=>fixture().catch(reportError);
$('mic').onclick=()=>startMic().catch(reportError);$('stop-mic').onclick=finishMic;$('volume').oninput=()=>session.audio.setVolume(+$('volume').value);
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>scene?.setView(button.dataset.view));
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`qwen-avatar-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener('pagehide',()=>{disconnect();session?.dispose();});
window.qwenLab={get ready(){return ready;},connect,sendText,fixture,interrupt,disconnect,startMic,finishMic,snapshot,setView:view=>scene?.setView(view),setSidecar:value=>{$('sidecar').checked=!!value;},resetPerformance:()=>{rows=[];}};
(async()=>{context=new AudioContext({sampleRate:24000,latencyHint:'interactive'});scene=await createScene($('stage'),text=>$('load-note').textContent=text);
  session=new LiveAvatarSession({context,face:scene.face,motion:scene.motion,onEvent:observe});session.audio.setVolume(+$('volume').value);
  client=new QwenClient({session,context,onEvent:handleClient});ready=true;$('loading').remove();updateUI();requestAnimationFrame(frame);
  const status=await(await fetch('/api/status')).json();admissionBlocked=status.usageUnknownBlocked;if(!status.configured)reportError('服务端未配置 DASHSCOPE_API_KEY');
  if(admissionBlocked)$('message').textContent='上次取消未返回用量，本批次已暂停新云请求。记录已保留；复测需明确启动新的有界批次。';updateUI();
})().catch(reportError);
