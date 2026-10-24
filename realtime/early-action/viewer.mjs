import {createScene} from '../qwen/scene.mjs';
import {LiveAvatarSession} from '../qwen/live-session.mjs';
import {PreparedMotionController,PreparedFaceController,EarlyActionDriver} from './preparation.mjs';

const $=id=>document.getElementById(id),now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
let catalog,scene,session,context,mix,capture,run=null,report=null,rendered,last=now(),serial=0,stopSequence=false,batchRunning=false;
const mark=(key,value=now())=>{if(run&&run[key]===undefined)run[key]=value;};
const ms=value=>Number.isFinite(value)?`${Math.round(value)} ms`:'—';
function info(){const c=catalog.cases.find(c=>c.id===$('case').value);$('context').textContent=c.context+'\n本轮台词：'+c.text;$('prompt').textContent=catalog.settings[c.group].instructions;
  $('replay').disabled=!catalog.attempted.includes(c.id);$('compare').disabled=!catalog.attempted.length;
  $('live').disabled=catalog.blocked||!catalog.cloudEnabled||catalog.used>=catalog.limit||catalog.attempted.includes(c.id);
  $('batch').disabled=batchRunning||catalog.blocked||!catalog.cloudEnabled||catalog.used>=catalog.limit;
  $('budget').textContent=`本批已用 ${catalog.used} / ${catalog.limit} 个响应${catalog.blocked?' · 未知用量，云调用已停止':''}`;}
async function refresh(){catalog=await(await fetch('/api/early-action')).json();info();try{const response=await fetch('/api/early-action/summary');if(response.ok){const summary=await response.json();$('summary').textContent=summary.conclusion;
  $('rows').replaceChildren();for(const row of summary.rows){const tr=document.createElement('tr');for(const value of [row.id,ms(row.server?.firstNonSilentPcmMs),ms(row.client?.voiceMs),ms(row.client?.bodyLeadMs),ms(row.client?.faceLeadMs),row.server?.sameResponseBothBeforeReceipt?'是':'否',row.outcome]){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('rows').append(tr);}}}catch{/* Report is optional. */}}

function accept(e){
  if(!run||run.completed)return;
  run.received.push({type:e.type,at:now()-run.started,serverAt:e.atMs});
  if(e.type==='request_sent')mark('requestAt');
  else if(e.type==='response_created'){
    run.responseId=e.responseId;
    if(run.cancelled)return;
    const connectionId=`early-${++serial}`;session.setConnection(connectionId);
    run.owner=session.beginResponse({connectionId,responseId:e.responseId,sampleRate:24000,sidecar:false});
    if(!run.owner)throw Error('response_owner_rejected');
    run.driver=new EarlyActionDriver(session,run.owner,{early:run.case.group==='C'});
  }else if(e.type==='non_silent_pcm'){run.firstVoicedFrame=e.frame;mark('voicedPacketAt');}
  else if(e.type==='audio'){
    mark('pcmAt');if(run.cancelled)return;
    if(e.responseId!==run.owner?.responseId)throw Error('pcm_owner_mismatch');
    const bytes=Uint8Array.from(atob(e.delta),c=>c.charCodeAt(0)),data=new DataView(bytes.buffer),pcm=new Float32Array(bytes.length/2);
    for(let i=0;i<pcm.length;i++)pcm[i]=data.getInt16(i*2,true)/32768;
    for(let offset=0;offset<pcm.length;offset+=24000){if(!session.appendPcm({owner:run.owner,sequence:run.sequence++,samples:pcm.slice(offset,offset+24000)}))throw Error('pcm_append_failed');}
  }else if(e.type==='subtitle'){
    if(!run.cancelled){run.transcript+=e.delta;$('caption').textContent=run.transcript;}
  }else if(e.type==='tool'){
    mark('toolAt');const admitted=run.cancelled?{accepted:false,reason:'cancelled_turn'}:run.driver?.accept(e)??{accepted:false,reason:'missing_owner'};run.tools.push({event:e,result:admitted,at:now()-run.started});
    run.toolBaseline=structuredClone(rendered);$('plan').textContent=admitted.accepted?`${admitted.plan?.expression??e.plan.expression} · ${admitted.plan?.gesture??e.plan.gesture} · ${admitted.prepared?'已接入提前准备':'跟随实际语音播放'}`:`未执行：${admitted.reason}`;
  }else if(e.type==='tool_rejected')run.rejected.push(e);
  else if(e.type==='complete'){
    run.providerDoneAt=now();run.server=e.result;
    if(e.result.error&&!e.result.cancelled)run.failure=e.result.error;
    if(!run.cancelled&&run.owner){
      if(e.result.completed){session.finishAudio(run.owner);session.providerDone(run.owner);}
      else cancel(e.result.cancelled?'saved_provider_cancel':'no_complete_audio',false);
    }
    if(e.blocked)catalog.blocked=true;
  }else if(e.type==='error'){run.failure=e.code;run.providerDoneAt=now();cancel('bridge_error',false);}
}

function cancel(reason='user_interrupt',provider=true){
  if(reason==='user_interrupt')stopSequence=true;if(!run||run.completed||run.cancelled)return false;
  const at=now(),before=session.audio.snapshot();
  run.driver?.cancel();const accepted=session.cancel(reason,run.owner);
  run.cancelled=true;run.interrupt={reason,at,returnMs:now()-at,accepted,before,after:session.audio.snapshot(),providerRequested:false};
  if(provider&&run.mode==='live'&&!run.providerDoneAt&&run.socket?.readyState===WebSocket.OPEN){run.socket.send(JSON.stringify({type:'cancel'}));run.interrupt.providerRequested=true;}
  $('caption').textContent='好，我先听你说。';return accepted;
}
function phase(a){if(run?.mode==='offline'&&run.completed)return '本地合成音频验收 · 不是云端实测';if(run?.cancelled)return '已打断 · 从当前姿态收回';if(a.status==='playing')return '正在说话 · 动作随播放推进';if(scene.motion.preparationSnapshot().some(p=>!p.released&&!p.expired))return '动作已开始准备 · 没有等待语音';if(run&&!run.completed)return '等待回复';return '实测回放 · 不产生云端费用';}
function frame(t){
  const interval=t-last,dt=Math.min(.05,interval/1000);last=t;
  try{
    const a=session.sync(),start=now();
    scene.motion.advancePreparation(t/1000,a);scene.face.advancePreparation(t/1000,a);
    rendered=scene.step(t,dt,session.lipSample(a),session.visualState(a));
    const prepCpu=now()-start;
    if(run&&!run.completed){
      if(a.status==='playing'&&a.sourceActive){mark('playbackAt');if(Number.isFinite(run.firstVoicedFrame)&&a.time*24000>=run.firstVoicedFrame)mark('voiceAt');}
      if(a.status==='playing'&&rendered.mouthOpen>.03)mark('mouthAt');
      const active=scene.motion.gestures.filter(g=>!g.recovering&&/^(early:|fc:)/.test(g.id));
      const hasBody=active.some(g=>Object.values(g.live?.weights??{}).some(w=>(w.position??w.body??0)>.015));
      const rotations=run.toolBaseline?.rotations;
      const bodyChanged=rotations&&['head','chest','leftShoulder','rightShoulder','leftElbow','rightElbow'].some(k=>rendered.rotations[k]?.some((v,i)=>Math.abs(v-rotations[k]?.[i])>.002));
      if(hasBody&&bodyChanged)mark('bodyAt');
      const reaction=scene.motion.snapshot().reactions?.some(g=>/^(early:|fc:)/.test(g.id)&&g.age>.02);
      const faceAction=scene.face.snapshot().executedCues.some(c=>c.kind==='action'&&c.age>.02&&/^(early:|fc:)/.test(c.id));
      if((reaction||faceAction)&&bodyChanged)mark('bodyAt');
      const facial=scene.face.snapshot().executedCues.some(c=>c.kind==='expression'&&/^(early:|fc:)/.test(c.id));
      // Exclude phonemes, articulation and automatic blinking from face evidence.
      if(facial&&run.toolBaseline&&[0,1,2,3,4,5,7,8,9,10,11,12,13,14,25].some(i=>Math.abs(rendered.weights[i]-run.toolBaseline.weights[i])>.04))mark('faceAt');
      run.frames.push({interval,driver:rendered.driverMs,render:rendered.renderMs,total:prepCpu});
      if(!run.lastTrace||t-run.lastTrace>=40){run.lastTrace=t;run.trace.push({at:t-run.started,audio:a.status,media:a.time,mouth:rendered.mouthOpen,rotations:rendered.rotations,bones:rendered.bones,weights:rendered.weights,gestures:scene.motion.snapshot().gestures,preparations:scene.motion.preparationSnapshot()});}
      if(run.interrupt){
        if(rendered.mouthOpen<.01&&run.interrupt.mouthClosedMs===undefined)run.interrupt.mouthClosedMs=now()-run.interrupt.at;
        const m=scene.motion.snapshot();if(!m.gestures.length&&!m.reactions.length&&!m.execution.handoff&&m.interactionPose.handsSettled&&run.interrupt.settledMs===undefined)run.interrupt.settledMs=now()-run.interrupt.at;
      }
      if(run.case.probe==='preparation-local-drain'&&!run.cancelled&&run.bodyAt!==undefined&&run.voiceAt===undefined){
        // Deliberately local-only: provider finishes naturally to report usage.
        cancel('preparation_local_drain',false);
      }
      if(run.case.probe==='speech-provider-cancel'&&!run.cancelled&&run.voiceAt!==undefined&&now()-run.voiceAt>=350)cancel('speech_interrupt',true);
      const delta=key=>run[key]===undefined?null:run[key]-run.requestAt;
      $('voice').textContent=ms(delta('voiceAt'));$('tool').textContent=ms(delta('toolAt'));
      $('lead').textContent=ms(run.voiceAt-run.bodyAt);$('face').textContent=ms(run.voiceAt-run.faceAt);
    }
    $('phase').textContent=phase(a);
  }catch(error){$('status').textContent=error.message;if(run&&!run.failure){run.failure=error.message;cancel('render_failure');}}
  requestAnimationFrame(frame);
}

function record(){
  const stream=$('stage').querySelector('canvas').captureStream(24);for(const track of capture.stream.getAudioTracks())stream.addTrack(track);
  const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus'].find(m=>MediaRecorder.isTypeSupported(m));
  const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1500000}),chunks=[];
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.start(500);
  return ()=>new Promise(resolve=>{recorder.onstop=()=>{for(const track of stream.getVideoTracks())track.stop();resolve(new Blob(chunks,{type:mime}));};recorder.stop();});
}

async function runCase(key,{live=false,recordVideo=false,localEvents=null}={}){
  if(run&&!run.completed)throw Error('run_busy');
  const config=catalog.cases.find(c=>c.id===key);if(!config)throw Error('unknown_case');
  if(live&&(!catalog.cloudEnabled||catalog.blocked||catalog.used>=catalog.limit||catalog.attempted.includes(key)))throw Error('cloud_not_allowed');
  if(live&&localEvents)throw Error('cannot_mix_cloud_and_fixture');
  if(!live&&!localEvents&&!catalog.attempted.includes(key))throw Error('missing_recording');
  if(live)await checkAudio(false);else await context.resume();
  run={key,case:config,mode:live?'live':localEvents?'offline':'replay',started:now(),sequence:0,tools:[],rejected:[],received:[],frames:[],trace:[],transcript:'',completed:false};
  report=null;$('case').value=key;info();for(const id of ['replay','compare','live','batch'])$(id).disabled=true;
  $('caption').textContent='';$('plan').textContent='等待完整动作指令；语音不等待动作。';$('status').textContent=live?'正在执行有界云端样本':'保存事件按原间隔回放';
  const finishVideo=recordVideo?record():null;
  let events=[],index=0,base;
  if(live){
    const ws=new WebSocket(`ws://${location.host}/api/early-action/run`);run.socket=ws;const current=run;
    ws.onopen=()=>ws.send(JSON.stringify({case:key}));
    ws.onmessage=e=>{if(current!==run||current.completed)return;try{accept(JSON.parse(e.data));}catch(error){run.failure=error.message;cancel('input_failure');}};
    ws.onerror=()=>{run.failure='socket_error';cancel('socket_error');};
    ws.onclose=()=>{if(!run.providerDoneAt){run.providerDoneAt=now();run.failure='closed_without_terminal';cancel('socket_closed',false);}};
  }else{
    if(localEvents)events=localEvents;
    else{const saved=await(await fetch(`/early-action-data/${key}.json`)).json();events=[...saved.events,{type:'complete',atMs:(saved.events.at(-1)?.atMs??0)+1,result:{...saved,events:undefined}}];}base=now();
  }
  let endedAt;const deadline=now()+90000;
  while(now()<deadline){
    if(!live)while(index<events.length&&events[index].atMs<=now()-base)accept(events[index++]);
    const a=session.audio.snapshot();
    if(run.providerDoneAt&&['ended','cancelled','fault','idle'].includes(a.status)){endedAt??=now();if(now()-endedAt>3200)break;}
    await sleep(10);
  }
  if(!endedAt){run.failure??='playback_timeout';cancel('playback_timeout');}
  const blob=finishVideo?await finishVideo():null;run.completed=true;
  const percentile=key=>{const sorted=run.frames.map(f=>f[key]).sort((a,b)=>a-b);return sorted[Math.floor(sorted.length*.95)]??null;};
  const delta=key=>run[key]===undefined?null:run[key]-run.requestAt;
  const lead=key=>run.voiceAt===undefined||run[key]===undefined?null:run.voiceAt-run[key];
  const {socket,driver,frames,...saved}=run;
  report={...saved,latency:{voiceMs:delta('voiceAt'),clickToVoiceMs:run.voiceAt===undefined?null:run.voiceAt-run.started,playbackMs:delta('playbackAt'),nonSilentPacketMs:delta('voicedPacketAt'),toolMs:delta('toolAt'),bodyMs:delta('bodyAt'),faceMs:delta('faceAt'),bodyLeadMs:lead('bodyAt'),faceLeadMs:lead('faceAt')},performance:{frames:frames.length,driverP95Ms:percentile('driver'),renderSubmitP95Ms:percentile('render'),frameP95Ms:percentile('interval')},finalAudio:session.audio.snapshot(),finalMotion:scene.motion.snapshot(),environment:{...scene.environment,audioBaseLatency:context.baseLatency,audioOutputLatency:context.outputLatency},physicalSpeakerVerified:false,scope:localEvents?'Offline synthetic PCM fixture on real PMX':'Fixed text-to-voice cloud comparison; browser playback cursor and composed PMX pose.'};
  $('diagnostic').textContent=JSON.stringify({latency:report.latency,interrupt:report.interrupt,server:report.server?.metrics,performance:report.performance,failure:report.failure},null,2);
  await fetch(`/api/early-action/report/${key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)}).then(r=>{if(!r.ok)throw Error('report_save_failed');});
  if(blob&&live)await fetch(`/api/early-action/video/${key}`,{method:'POST',headers:{'Content-Type':'video/webm'},body:blob}).then(r=>{if(!r.ok)throw Error('video_save_failed');});
  await refresh();$('status').textContent=run.failure?'未通过：'+run.failure:run.cancelled?'打断完成，查看回收与时序证据。':run.server?.completed?'本段完成。可回放或切换三组。':'本响应没有完整语音，已保留失败记录，没有补发请求。';
  return {key,latency:report.latency,interrupt:report.interrupt,failure:report.failure,server:report.server?.metrics};
}

async function checkAudio(audible=true){
  if(context.state==='closed')throw Error('音频设备已关闭，请刷新页面后重试；尚未调用模型。');
  await Promise.race([context.resume(),sleep(3000).then(()=>{throw Error('浏览器未允许播放，请先点击试听。');})]);
  const initial=context.currentTime;await sleep(160);
  if(context.state!=='running'||context.currentTime<=initial)throw Error('音频时钟没有运行，请检查系统输出设备并刷新页面。');
  if(audible){const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=440;gain.gain.value=.08;oscillator.connect(gain);gain.connect(mix);oscillator.start();oscillator.stop(context.currentTime+.16);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};$('status').textContent='浏览器音频时钟正常。请确认听到了短提示音，再开始整批测试。';}
}
async function runBatch(){
  if(batchRunning||run&&!run.completed)throw Error('已有测试在运行');
  await checkAudio(false);batchRunning=true;stopSequence=false;info();
  try{
    await refresh();
    for(const c of catalog.cases){
      if(stopSequence||catalog.blocked||catalog.used>=catalog.limit)break;
      if(catalog.attempted.includes(c.id))continue;
      const result=await runCase(c.id,{live:true,recordVideo:true});
      if(result.failure)throw Error(result.failure+'。已停止整批；连接失败没有占用模型响应。可先生成结果包给 Codex 排查。');
      if(c.probe)stopSequence=false;
      await sleep(700);
    }
    $('status').textContent=catalog.blocked?'本批出现未知用量，已停止。请点击生成结果 ZIP。':'本批运行结束，请点击生成结果 ZIP；可以继续免费回放。';
  }finally{batchRunning=false;await refresh();}
}

async function boot(){
  catalog=await(await fetch('/api/early-action')).json();for(const c of catalog.cases){const option=document.createElement('option');option.value=c.id;option.textContent=`${catalog.groups[c.group]} · ${c.scene==='greet'?'招呼':'比较方案'} · ${c.repeat||'打断探针'}`;$('case').append(option);}
  context=new AudioContext({sampleRate:24000,latencyHint:'interactive'});mix=context.createGain();mix.gain.value=.16;mix.connect(context.destination);capture=context.createMediaStreamDestination();mix.connect(capture);
  const host={get state(){return context.state;},get currentTime(){return context.currentTime;},destination:mix,resume:()=>context.resume(),createBuffer:(...v)=>context.createBuffer(...v),createBufferSource:()=>context.createBufferSource(),createGain:()=>context.createGain()};
  scene=await createScene($('stage'),message=>$('loading').textContent=message,{motionFactory:options=>new PreparedMotionController(options),faceFactory:()=>new PreparedFaceController()});
  scene.motion.setPosture('relaxed');session=new LiveAvatarSession({context:host,face:scene.face,motion:scene.motion,naturalConversation:false});session.audio.setVolume(1);
  $('loading').remove();requestAnimationFrame(frame);await refresh();$('status').textContent='人物就绪。三组语音都不等待动作。';
  window.earlyAction={ready:true,runCase,runBatch,checkAudio,cancel,accept,get report(){return report;},get catalog(){return catalog;},get active(){return !!run&&!run.completed;},get scene(){return scene;},get session(){return session;},get state(){return {run:run?{key:run.key,tools:run.tools,cancelled:run.cancelled,requestAt:run.requestAt,bodyAt:run.bodyAt,voiceAt:run.voiceAt,providerDoneAt:run.providerDoneAt}:null,rendered,audio:session.audio.snapshot(),motion:scene.motion.snapshot(),preparation:scene.motion.preparationSnapshot()};},refresh};
  $('case').onchange=info;$('volume').oninput=()=>mix.gain.value=+$('volume').value;
  $('replay').onclick=()=>runCase($('case').value).catch(e=>$('status').textContent=e.message);
  $('live').onclick=()=>runCase($('case').value,{live:true,recordVideo:true}).catch(e=>$('status').textContent=e.message);
  $('batch').onclick=()=>runBatch().catch(e=>$('status').textContent=e.message);
  $('sound').onclick=()=>checkAudio().catch(e=>$('status').textContent=e.message);
  $('export').onclick=async()=>{
    if(run&&!run.completed){$('status').textContent='请等当前响应结束后再生成结果包。';return;}
    $('export').disabled=true;$('status').textContent='正在打包计时、轨迹和代表录像…';
    try{const response=await fetch('/api/early-action/package');if(!response.ok)throw Error('打包失败，请保留结果目录。');
      const result=await response.json();if(!(result.bytes>0))throw Error('结果包为空，请保留原始目录。');
      $('status').textContent=`ZIP 已保存在本机（${(result.bytes/1024/1024).toFixed(1)} MB）：${result.path}。将此文件发给 Codex 即可。`;
    }catch(error){$('status').textContent=error.message;}finally{$('export').disabled=false;}
  };
  $('cancel').onclick=()=>cancel();$('pause').onclick=()=>{const a=session.audio.snapshot();if(a.status==='paused')session.audio.play();else if(a.status==='playing')session.audio.pause();};
  $('compare').onclick=async()=>{stopSequence=false;const c=catalog.cases.find(c=>c.id===$('case').value);for(const g of ['A','B','C']){if(stopSequence)break;const key=`${c.scene}-r1-${g}`;if(catalog.attempted.includes(key))await runCase(key);}};
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>scene.setView(button.dataset.view);
}
boot().catch(error=>{$('status').textContent=error.message;console.error(error);});
