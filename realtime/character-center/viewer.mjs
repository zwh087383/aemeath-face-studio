import {createScene} from './scene.mjs';
import {CharacterCenter} from './center.mjs';
import {CharacterClient} from './client.mjs';
import {ContinuousFaceController} from '/preview/core/continuous-face-controller.js';
import {ContinuousFaceController as LegacyFaceController} from '/preview/core/legacy-continuous-face-controller.js';
import {FaceController} from '/preview/core/controller.js';
import {MotionController} from '/preview/core/motion-controller.js';
import {skeletonFromMesh} from '/preview/studio/motion-rig.js';
import {AEMEATH_BINDINGS} from '/preview/core/profile.js';
import {LiveAvatarSession} from '../qwen/live-session.mjs';
import {resample16k,captureMicrophone} from '../qwen/input-audio.mjs';
import {ATTITUDE_KINDS} from './face-profiles.mjs';
import {runFirstStage,finishFirstStage} from './suite.mjs';
import {captureOwnedVoice,compactReport} from './measurement.mjs';
import {CHARACTER_ACTIONS} from './catalog.mjs';
import {ActionFaceAdapter} from './action-face.mjs';
import {CHARACTER_AUDIO_OPTIONS} from './audio-options.mjs';

const $=id=>document.getElementById(id),now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shown=x=>Number.isFinite(x)?`${Math.round(x)} ms`:'—';
const attitudeNames={attention:'注意',concern:'关切',serious:'认真',warm:'温和',curious:'好奇',playful:'俏皮',sad:'低落',excited:'兴奋',surprise:'惊讶',confused:'疑惑',smile:'微笑'};
const actionName=id=>CHARACTER_ACTIONS[id]?.label??CHARACTER_ACTIONS[id]?.name??id;
const replayPage=new URL(location.href).searchParams.get('replay');
let scene,center,face,oldFace,session,client,context,mix,service,manifest,faceData,samples,actionFace;
let ready=false,feeding=false,microphone=null,component=true,comparison=false,replaying=false,manualRevision=0,last=now(),uiAt=0,actorAt=0;
let record,recordParts=[],renderFault=null,lastRendered=null;
const frameTimes=[],inputRecords=[],rawEvents=[],diagnostics=[],receipts=new Set();
const bodyReceipts=new Set();
async function json(url,options){const response=await fetch(url,options);if(!response.ok)throw Error(`${response.status}: ${await response.text()}`);return response.json();}
const post=(url,value)=>json(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
function error(value){$('status').textContent=value?.message??String(value);}
function makeFace(){return new ContinuousFaceController({recipes:faceData.recipes,morphCount:faceData.model.morphCount,mouthIndices:faceData.mouthIndices});}
function makeLegacyFace(){return new LegacyFaceController({recipes:faceData.recipes,morphCount:faceData.model.morphCount,mouthIndices:faceData.mouthIndices});}
function bindActionFace(){actionFace=new ActionFaceAdapter({face,current:o=>center.current(o),nextRevision:()=>++center.faceRevision});}
function observed(event){
  const e=event.event;if(!e){if(event.type==='client_error'){diagnostics.push({...event,browserAt:now()});error(event.code);}return;}
  rawEvents.push({...structuredClone(e),browserAt:now()});
  if(e.type==='input_partial')$('input').textContent=(e.text??'')+(e.stash??'');
  if(e.type==='input_final')$('input').textContent=e.transcript;
  if(e.type==='turn_started'){$('answer').textContent='正在检索记忆…';}
  if(e.type==='character_actions'||e.type==='character_expression'){
    const t=client.trials.find(t=>t.id===e.turnId);if(t){t.firstActionAt??=e.type==='character_actions'?now():undefined;
      t.firstFaceAt??=e.type==='character_expression'?now():undefined;t.faceBaseline??=Array.from(face.output);
      t.boneBaseline??=scene.mesh.skeleton.bones.map(b=>b.quaternion.toArray());}
  }
  if(e.type==='turn_error'||e.type==='blocked')error(e.code);
}
function marker(){const m=session.audio.playbackMarker();return m?{...m,wallTime:m.reached?now()/1000-(context.currentTime-m.contextTime):null}:null;}
function metrics(t){return {lastSpeechToVoiceMs:t.voiceAt-t.input?.lastSpeechAt,requestToVoiceMs:t.voiceAt-t.requestAt,
  commandLeadMs:t.voiceAt-t.firstActionAt,bodyStartLeadMs:t.voiceAt-t.bodyStartedAt,
  faceTargetLeadMs:t.voiceAt-t.faceAppliedAt,visibleFaceLeadMs:t.voiceAt-t.faceVisibleAt,visibleBodyLeadMs:t.voiceAt-t.bodyVisibleAt};}
function frame(time){
  const elapsed=time-last,dt=Math.min(.05,Math.max(0,elapsed/1000));last=time;frameTimes.push({at:time,dt:elapsed,hidden:document.hidden});if(frameTimes.length>20000)frameTimes.shift();
  try{
    client.sync();const a=session.audio.snapshot(),m=marker(),t=client.current;
    captureOwnedVoice(client,time);
    center.advance(a,t);
    const lip=session.lipSample(a),speaking=a.status==='playing',lipWeights={};
    AEMEATH_BINDINGS.forEach(([index],i)=>{if(i>=15&&i<=19)lipWeights[index]=lip.weights[i]??0;});
    const blinkAge=(time/1000)%4.7,blink=blinkAge<.18?Math.sin(Math.PI*blinkAge/.18):0;
    const layer=scene.actionLayer?.()??scene.bodyDirector.actionLayer?.()??{};
    actionFace.update({active:scene.bodyDirector.active,gestures:scene.motion.snapshot().gestures,
      activityFace:scene.body.pose.face,executor:scene.bodyDirector.executor,paused:center.paused});
    let weights=face.update(time/1000,{speaking,lipWeights,closure:lip.closure??0,blink,actionBlink:layer.blink??0,paused:center.paused});
    if(component){const oldWeights=oldFace.update(time/1000,{speaking,lipWeights,closure:lip.closure??0,blink,actionBlink:layer.blink??0,paused:center.paused});if(comparison)weights=oldWeights;}
    lastRendered=scene.step(time/1000,dt,{faceWeights:weights,paused:center.paused,audioTime:a.time,audioStatus:a.status,mediaOwner:t?{turnId:t.id}:null,segmentEnded:a.status==='ended'});
    const actualActor={...lastRendered.actorState,communication:{turnId:t?.id??null,audioStatus:a.status,paused:center.paused}};
    if(client.ready&&!replaying&&!component){
      for(const event of scene.bodyDirector.events){
        if(!['action_admitted','action_started','action_completed','action_rejected','action_failed','action_expired','action_cancelled'].includes(event.type))continue;
        const key=`${event.id}:${event.type}`;if(bodyReceipts.has(key)||!Number.isInteger(event.index))continue;
        if(client.send({type:'action_receipt',commandId:event.owner.requestId,index:event.index,action:event.action,
          status:event.type.slice(7),reason:event.reason??null,actorState:actualActor})){
          bodyReceipts.add(key);diagnostics.push({type:'body_feedback_sent',browserAt:time,action:event.action,status:event.type.slice(7),commandId:event.owner.requestId});
        }
      }
    }
    if(t&&!t.revoked){
      const started=scene.bodyDirector.events.find(e=>e.type==='action_started'&&e.executor!=='face'&&e.owner?.turnId===t.id);
      if(started&&t.bodyStartedAt===undefined){t.bodyStartedAt=time;t.firstBodyAction=started.action;t.bodyStartSimulationTime=started.at;}
      const faceTarget=center.events.find(e=>e.type==='face_target'&&e.turnId===t.id&&e.accepted===true);
      if(faceTarget&&t.faceAppliedAt===undefined)t.faceAppliedAt=faceTarget.at*1000;
      if(t.faceAppliedAt!==undefined&&t.faceBaseline&&t.faceVisibleAt===undefined&&weights.some((v,i)=>!face.articulators.has(i)&&!face.closures.has(i)&&Math.abs(v-t.faceBaseline[i])>.02))t.faceVisibleAt=time;
      if(t.bodyStartedAt!==undefined&&t.boneBaseline&&t.bodyVisibleAt===undefined&&scene.mesh.skeleton.bones.some((b,i)=>b.quaternion.toArray().some((v,k)=>Math.abs(v-t.boneBaseline[i][k])>.005)))t.bodyVisibleAt=time;
    }
    for(const e of center.events.filter(e=>e.type==='segment_played')){
      const id=`${e.turnId}:${e.index}`;if(receipts.has(id)||replaying)continue;receipts.add(id);
      client.send({type:'playback_receipt',turnId:e.turnId,segmentIndex:e.index,providerConnectionId:e.providerConnectionId,responseId:e.responseId,playedFrame:e.playedFrame});
    }
    if(client.ready&&!replaying&&time-actorAt>500){actorAt=time;client.send({type:'actor_state',actorState:actualActor});}
    if(time-uiAt>200){uiAt=time;updateUI();}
  }catch(e){if(!renderFault){renderFault={at:time,message:e.message};error('画面错误：'+e.message);console.error(e);}}
  requestAnimationFrame(frame);
}
function updateUI(){
  const a=session.audio.snapshot(),t=client.current,b=client.budget??service.budget,s=center.snapshot();
  $('phase').textContent=replaying?'真实记录回放 · 不调用云端':component?`本地对照 · ${comparison?'上一版：整张游戏表情常驻':'本次：持续表情与嘴形分离'}`:a.status==='playing'?'正在回复 · 保持双工倾听':client.ready?'在线倾听 · 表情持续运行':'已断开 · 保留最后状态';
  $('budget').textContent=`${b.turns??0}/${b.turnLimit??0} 轮 · ${b.responses??0}/${b.responseLimit??0} 请求 · 未知用量 ${b.unknown??0}（保留最大预留） · PCM ${Number(b.pcmSeconds??0).toFixed(1)}/${b.pcmLimitSeconds??0} 秒`;
  $('connect').disabled=!ready||client.ready||!service.cloudEnabled||b.blocked||!!replayPage;
  for(const id of ['feed','send','mic','activity-start','activity-revoke'])$(id).disabled=!client.ready||client.blocked||feeding||replaying;
  $('sample').disabled=!component;$('compare').disabled=!component;for(const button of $('attitudes').children)button.disabled=!component;
  $('local-wave').disabled=!component;
  $('caption').textContent=t?.revoked?'好，我先听你说。':t?.transcript??'';$('answer').textContent=t?.transcript??'';
  if(t){const m=metrics(t);$('latency').textContent=shown(m.lastSpeechToVoiceMs);$('plan-latency').textContent=shown(m.commandLeadMs);}
  const attitude=s.face.attitude;$('face-basis').textContent=attitude?`当前态度：${attitudeNames[attitude.effectiveKind??attitude.kind]??attitude.kind} · 数学底色持续运行`:'数学底色持续运行 · 暂无话题态度';
  $('body-state').textContent=`身体：${{conversation:'交流动作',native:'游戏原生动作',activity:'生活活动'}[s.body.executor]??'保持'} · ${{standing:'站着',seated:'坐着'}[s.body.actorState?.support]??'正在转换支撑'} · ${s.body.actorState?.hands==='free'?'双手空闲':s.body.actorState?.hands==='occupied'?'手中持物':'按当前持物姿势保持'} · 等待动作 ${s.body.pending?.length??0}`;
  const act=s.activity;$('activity-state').textContent=act?.activityId?`${act.label}：${act.status}；WAI 工作${act.actualWorkRunning?'仍在执行':'已返回/未开始'}；模型请求${act.actualModelRequestRunning?'正在等待':'未在途'}；${act.artifactId?'已产生真实笔记：'+act.artifactSummary:'尚无真实产物'}`:'未启动后台活动';
  if($('timing-detail')){
    const rows=rawEvents.filter(e=>e.type==='character_semantic_done').slice(-4);
    $('timing-detail').textContent=rows.length?rows.map(e=>{
      const t=e.timings??{},diff=(a,b)=>Number.isFinite(t[a])&&Number.isFinite(t[b])?shown(t[b]-t[a]):'未记录';
      return `${e.sourceScope} · 排队 ${shown(t.queueMs)} · 首次核验 ${diff('guard_start','guard_done')} · 连接 ${diff('guard_done','connection_ready')} · 上下文确认 ${diff('context_send','context_confirmed')} · 预算落盘 ${diff('budget_start','budget_reserved')} · 请求到参数首块 ${diff('request_sent','first_argument_delta')} · 首个完整工具 ${diff('request_sent','first_complete_arguments')} · 身体指令 ${diff('request_sent','first_body_arguments')} · 输入 tokens ${e.usage?.input_tokens??'服务端未报告'}`;
    }).join('\n'):'尚无本轮云端计时。本地画面对照不代表模型提速。';
  }
  $('timeline').replaceChildren(...center.events.filter(e=>['body_target','face_target','activity_state','cancel','stale_drop','execution_feedback','decision_followup'].includes(e.type)).slice(-10).reverse().map(e=>{
    const d=document.createElement('div');let text=e.reason??'';
    if(e.type==='body_target')text='模型选择：'+(e.command.actions.map(x=>actionName(x.action)).join(' → ')||'保持 / 清空待做动作');
    if(e.type==='face_target')text='表情决定：'+(attitudeNames[e.command.kind]??e.command.kind);
    if(e.type==='activity_state')text='后台：'+(e.activity.label??'暂无任务')+' · '+({planned:'等待开始',running:'进行中',paused:'暂停',done:'完成',failed:'失败',none:'空闲'}[e.activity.status]??e.activity.status);
    if(e.type==='cancel')text='已撤销旧动作，按当前姿势收稳';
    if(e.type==='stale_drop')text='迟到的旧决定已丢弃';
    if(e.type==='execution_feedback')text=`真实执行：${actionName(e.result.action)} · ${{completed:'完成',failed:'失败',rejected:'条件不符',expired:'错过时机',cancelled:'取消'}[e.result.status]??e.result.status} ${e.result.reason||''}`;
    if(e.type==='decision_followup')text=e.replanned?'已把执行结果交回模型，由它决定下一步':`结果已处理 ${e.reason??'，继续等待'}`;
    d.textContent=`${e.at.toFixed(1)}s ${text}`;return d;}));
  if($('debug').parentElement.open)$('debug').textContent=JSON.stringify(s,null,2);
  $('rows').replaceChildren(...client.trials.map(t=>{const tr=document.createElement('tr'),m=metrics(t);for(const value of [t.text,shown(m.lastSpeechToVoiceMs),shown(m.requestToVoiceMs),(t.revoked?'已打断 · ':t.settledAt!==undefined?'已播完并写入历史 · ':'进行中 · ')+(t.transcript||t.error||'')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;}));
}
async function sound(){await context.resume();const o=context.createOscillator(),g=context.createGain();g.gain.value=.08;o.connect(g);g.connect(mix);o.start();o.stop(context.currentTime+.15);}
function sample(id=$('sample').value){if(!component)throw Error('本地样本不能覆盖真实 WAI');const s=samples.find(x=>x.id===id),state={emotion:s,effectiveEnergy:s.effectiveEnergy,source:'handwritten_component_fixture'};face.setMathematical(state,++manualRevision);oldFace.setMathematical(state,manualRevision);return s;}
async function connect(){if(replayPage)throw Error('回放页不能连接云端');await context.resume();face=makeFace();center.face=face;bindActionFace();component=false;comparison=false;renderFault=null;await client.connect();await refresh();}
function stopMic(){microphone?.stop();microphone=null;}
async function close(){stopMic();await client.close();await save();await refresh();}
async function feed(id=$('fixture').value){
  if(feeding||!client.ready||client.blocked||inputRecords.some(r=>r.id===id&&r.sentPackets))throw Error('该题已发送或当前不可输入');
  const clip=manifest.clips.find(x=>x.id===id);if(!clip)throw Error('未知输入');feeding=true;
  const record={id,text:clip.text,at:now(),sentPackets:0};inputRecords.push(record);
  try{await context.resume();await client.ensureListener();if(clip.group==='emotion')record.initialCondition=await post('/api/character-center/initial-state',{fixtureId:id});
    const decoded=await context.decodeAudioData(await (await fetch(clip.url)).arrayBuffer()),pcm=resample16k(decoded.getChannelData(0),decoded.sampleRate);
    const padded=new Int16Array(pcm.length+16000*2);padded.set(pcm);const start=now();
    for(let p=0;p<padded.length;p+=1600){await sleep(Math.max(0,start+p/16-now()));
      if(!client.sendAudio(padded.slice(p,p+1600),{source:'local_synthesized_user_fixture'})){
        // The last admitted turn can exhaust listening while only test padding
        // remains. Preserve that boundary without mislabelling an admitted reply.
        if(p>=pcm.length&&client.inputExhausted&&client.trials.some(t=>t.startedAt>=record.at)){
          record.paddingStoppedAt=p;record.admittedInputComplete=true;break;
        }
        throw Error('input_stopped');
      }record.sentPackets++;}
    record.finishedAt=now();
  }finally{feeding=false;await save();}
}
async function save(mode=component?'component':replaying?'replay':'live'){
  const report={mode,experiment:'continuous-character-center-20261025',at:new Date().toISOString(),renderFault,
    inputRecords,events:rawEvents,diagnostics,client:client.snapshot(),center:center.snapshot(),actionFace:actionFace.snapshot(),frames:frameTimes,interruptions:client.interruptions,
    trials:client.trials.map(t=>({...t,driver:undefined,metrics:metrics(t)})),audio:session.audio.snapshot(),suite:window.characterCenter?.suiteState,
    manualContinuation:window.finalManualEvidence??null};
  return post('/api/parallel-duplex/report',compactReport(report));
}
async function refresh(){service=await json('/api/duplex/status');const selected=$('replay-choice').value;
  $('replay-choice').replaceChildren(...service.savedSessions.map(id=>{const o=document.createElement('option');o.value=id;o.textContent=id;return o;}));
  if(service.savedSessions.includes(selected))$('replay-choice').value=selected;
  const videos=service.savedVideos??[],videoSelected=$('recording-choice').value;
  $('recording-choice').replaceChildren(...videos.map(id=>{const o=document.createElement('option');o.value=id;o.textContent=id.replace('preview-','').replace('.webm','');return o;}));
  if(videos.includes(videoSelected))$('recording-choice').value=videoSelected;
  $('recording-open').disabled=!videos.length;return service;}
async function replay(id=$('replay-choice').value){
  if(client.ready||feeding||replaying)throw Error('先断开实时会话');
  if(!service.savedSessions.includes(id))throw Error('请选择已有记录');
  // Rebuild the entire private scene/ownership state on every event replay.
  // Never clear live revocation or command-dedup protections to permit a rerun.
  const target=new URL(location.href);target.search='';target.searchParams.set('replay',id);location.assign(target.href);
}
async function playSaved(id){
  if(!service.savedSessions.includes(id))throw Error('找不到这份真实记录');
  const data=await json('/duplex-data/'+id+'.json');
  await context.resume();component=false;replaying=true;face=makeFace();center.face=face;bindActionFace();
  client=new CharacterClient({session,director:center,onEvent:observed});client.localReplay=true;
  const connectionId='replay-'+Date.now();client.message({type:'ready',connectionId,variant:'qwen-direct',budget:{blocked:false,unknown:0}});
  const events=data.events.filter(e=>!['ready','delivery','settled','closed','blocked'].includes(e.type)),start=now(),origin=events[0]?.serverMs??0;
  try{for(const e of events){await sleep(Math.max(0,start+e.serverMs-origin-now()));client.message({...e,connectionId});}
    const deadline=now()+60000;while(now()<deadline&&(session.audio.snapshot().status==='playing'||center.hasWork()))await sleep(100);
    $('status').textContent=session.audio.snapshot().status==='playing'||center.hasWork()?'记录事件已播完，但动作或声音尚未结束；保留当前状态。':'记录回放结束。原速录像可核对当时的实际画面。';
    await save('replay');}
  finally{replaying=false;client.ready=false;}
}
async function activityStart(caseId=$('activity-case').value){return post('/api/character-center/activity',{operation:'start',caseId});}
async function activityRevoke(){return post('/api/character-center/activity',{operation:'revoke'});}
function recordStart(){const canvas=$('stage').querySelector('canvas'),stream=canvas.captureStream(30);mix.connect(recordDestination);stream.addTrack(recordDestination.stream.getAudioTracks()[0]);recordParts=[];record=new MediaRecorder(stream,{mimeType:'video/webm'});record.ondataavailable=e=>{if(e.data.size)recordParts.push(e.data);};record.start(1000);$('record-stop').disabled=false;}
let recordDestination;
async function recordStop(){if(!record||record.state==='inactive')return;await new Promise(r=>{record.onstop=r;record.stop();});const blob=new Blob(recordParts,{type:'video/webm'}),link=$('video');link.href=URL.createObjectURL(blob);link.download='character-center-original-speed.webm';link.hidden=false;link.textContent='下载原速录像';$('record-stop').disabled=true;return blob;}
async function boot(){
  [service,manifest,faceData,{samples}]=await Promise.all([json('/api/duplex/status'),json('/api/parallel-duplex/input-manifest'),json('/face-preparation-data/playback.json'),json('/early-action/emotion-samples.json')]);
  context=new AudioContext();mix=context.createGain();mix.gain.value=.15;mix.connect(context.destination);recordDestination=context.createMediaStreamDestination();
  const host={get state(){return context.state;},get currentTime(){return context.currentTime;},destination:mix,resume:()=>context.resume(),createBuffer:(...x)=>context.createBuffer(...x),createBufferSource:()=>context.createBufferSource(),createGain:()=>context.createGain()};
  scene=await createScene($('stage'),text=>$('loading').textContent=text,{isOwnerCurrent:owner=>center?.current(owner)===true});face=makeFace();oldFace=makeLegacyFace();
  session=new LiveAvatarSession({context:host,face:new FaceController(),motion:new MotionController({skeleton:skeletonFromMesh(scene.mesh)}),naturalConversation:false,audioOptions:CHARACTER_AUDIO_OPTIONS,
    onEvent:event=>{if(['fault','rejected','session_fault'].includes(event.type))diagnostics.push({...event,browserAt:now()});}});
  center=new CharacterCenter({face,body:scene.bodyDirector});bindActionFace();client=new CharacterClient({session,director:center,onEvent:observed});
  $('sample').replaceChildren(...samples.map(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.label;return o;}));
  $('fixture').replaceChildren(...manifest.clips.map(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.text;return o;}));
  const labels={attention:'注意',concern:'关切',serious:'认真',warm:'温和',curious:'好奇',playful:'俏皮',sad:'低落',excited:'兴奋'};
  for(const kind of ATTITUDE_KINDS){const button=document.createElement('button');button.textContent=labels[kind];button.onclick=()=>{const command={id:kind,kind,strength:.6,source:'local_component',revision:++manualRevision,evidenceId:'explicit_preview_'+manualRevision,renew:true};face.setAttitude(command);oldFace.setAttitude(command);};$('attitudes').append(button);}
  const action=fn=>()=>Promise.resolve().then(fn).catch(error);
  for(const [id,fn] of Object.entries({connect,disconnect:close,sound,feed,save,refresh,replay,'activity-start':activityStart,'activity-revoke':activityRevoke,mic:async()=>{await context.resume();await client.ensureListener();microphone=await captureMicrophone(context,pcm=>client.sendAudio(pcm));},'mic-stop':stopMic,record:recordStart,'record-stop':recordStop}))$(id).onclick=action(fn);
  $('send').onclick=()=>client.sendText($('text').value);$('cancel').onclick=()=>{client.cancel();center.cancel();};$('pause').onclick=()=>client.setManualPause(!client.manualPaused);
  $('recording-open').onclick=()=>{const video=$('recording-player');video.src='/duplex-data/'+encodeURIComponent($('recording-choice').value);video.hidden=false;video.play().catch(error);};
  $('sample').onchange=()=>sample();$('compare').textContent='查看上一版同一表情';$('compare').onclick=()=>{comparison=!comparison;$('compare').textContent=comparison?'查看本次修复':'查看上一版同一表情';};
  $('neutral').onclick=()=>{if(component){face=makeFace();oldFace=makeLegacyFace();center.face=face;bindActionFace();sample();}};
  $('volume').oninput=()=>mix.gain.value=+$('volume').value;for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>scene.setView(button.dataset.view);
  sample();ready=true;$('loading').remove();$('status').textContent='人物已加载。默认本地预览；真实活动必须先连接已授权批次。';last=now();requestAnimationFrame(frame);await refresh();
  window.characterCenter={ready:true,connect,feed,close,save,refresh,replay,activityStart,activityRevoke,sound,sample,recordStart,recordStop,
    state:()=>({ready:client.ready,blocked:client.blocked,feeding,component,replaying,comparison,renderFault,activity:center.activity,body:scene.bodyDirector.snapshot(),face:face.snapshot(),legacyFace:component?oldFace.snapshot():null,audio:session.audio.snapshot(),trials:client.trials.map(t=>({...t,driver:undefined,metrics:metrics(t)})),frames:frameTimes.slice(-600),inputs:inputRecords}),
    cancel:()=>client.cancel(),sendText:text=>client.sendText(text)};
  window.characterCenter.runFirstStage=options=>runFirstStage(window.characterCenter,options);
  window.characterCenter.finishFirstStage=()=>finishFirstStage(window.characterCenter);
  window.characterCenter.componentCommand=command=>{if(!component||client.ready)throw Error('component_preview_only');
    return center.message({type:'character_actions',sourceScope:'component',sourceKey:'component:body',sourceVersion:String(++manualRevision),
      semanticRevision:manualRevision,requestId:'component-'+manualRevision,command,mediaAnchor:{kind:'immediate'}});};
  $('local-wave').onclick=()=>window.characterCenter.componentCommand({operation:'replace',review:'wait',actions:[{action:'gesture:wave',anchor:'immediate'}]});
  if(replayPage){history.replaceState(null,'',location.pathname);playSaved(replayPage).catch(error);}
}
window.addEventListener('pagehide',()=>{stopMic();client?.close();session?.dispose();});boot().catch(error);
