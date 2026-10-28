import { createScene } from '../character-center/scene.mjs';
import { CHARACTER_ACTIONS, CHARACTER_CATALOG } from '../character-center/catalog.mjs';
import { ContinuousFaceController } from '/preview/core/continuous-face-controller.js';
import { ContinuousFaceController as LegacyFace } from '/preview/core/legacy-continuous-face-controller.js';
import { ActionFaceAdapter } from '../character-center/action-face.mjs';
import { LOCAL_MATH_SAMPLES, ATTITUDE_KINDS } from '../character-center/face-profiles.mjs';
import { AEMEATH_BINDINGS } from '/preview/core/profile.js';
import { LipTrack } from '/preview/core/lip-track.js';
import { PARTITIONED_DESK } from '/preview/core/activity-desk-layout.js';
import { pulledOutDeskEntryFixture } from '/preview/core/activity-seat-access.js';

const $=id=>document.getElementById(id), copy=x=>structuredClone(x), sleep=ms=>new Promise(r=>setTimeout(r,ms));
const json=async url=>{const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);return r.json();};
const labels={attention:'注意',concern:'关切',serious:'认真',warm:'温和',curious:'好奇',playful:'俏皮',sad:'低落',excited:'兴奋'};
let scene,face,oldFace,actionFace,faceData,ready=false,fault=null,paused=false,manual=false,baseline=false,recorder=null,recordParts=[];
let now=0,last=performance.now(),revision=0,generation=1,selected='',lastPlan=null,attentionToken=null,lipTrack=null;
const events=[],times=[],audio=new Audio('/library-data/sample.wav'); audio.volume=.16;
const source=()=>({sourceKey:`local-preview:${generation}`,sourceScope:'component',activityId:`preview-${generation}`,sourceVersion:generation,requestId:`manual-${++revision}`,catalogHash:CHARACTER_CATALOG.hash});
function report(text){$('status').textContent=text;}
function current(owner){return owner.sourceVersion===generation;}
function allSceneProps(){return {chair:true,...copy(PARTITIONED_DESK.setupProps),mat:{visible:true,attachment:'floor',position:[15,0,0]},box:{visible:true,attachment:'floor',position:[-12,0,4.1]},platform:{visible:true,attachment:'floor',position:[0,0,14]}};}
async function reset({sceneProps,initialRoot}={}) {
  ready=false;generation++;now=0;paused=false;attentionToken=null;
  if(!scene)scene=await createScene($('stage'),text=>$('loading').textContent=text,{allowInspectionReset:true,sceneProps:{},isOwnerCurrent:current,onEvent:e=>{events.push(e);if(events.length>3000)events.shift();}});
  if(!sceneProps){const fixture=pulledOutDeskEntryFixture(scene.body.context);sceneProps={...allSceneProps(),...fixture.sceneProps};initialRoot=fixture.initialRoot;}
  scene.resetInspection(sceneProps,initialRoot);
  face=new ContinuousFaceController({recipes:faceData.recipes,morphCount:faceData.model.morphCount,mouthIndices:faceData.mouthIndices});
  oldFace=new LegacyFace({recipes:faceData.recipes,morphCount:faceData.model.morphCount,mouthIndices:faceData.mouthIndices});
  const sample=LOCAL_MATH_SAMPLES.find(s=>s.id===$('emotion').value)??LOCAL_MATH_SAMPLES[0];
  face.setMathematical(sample,++revision);oldFace.setMathematical(sample,revision);
  actionFace=new ActionFaceAdapter({face,current,nextRevision:()=>++revision});ready=true;last=performance.now();$('loading').textContent='本地预览 · 不调用模型';return scene.snapshot();
}
function submit(actions,operation='append') {
  const value={operation,actions:actions.map(item=>typeof item==='string'?{action:item,anchor:'immediate'}:item)};
  const result=scene.bodyDirector.submit(value,source());if(!result.accepted)report(result.reason);return result;
}
function step(dt=1/60,render=true) {
  if(!ready)return null;
  const speaking=!audio.paused&&!audio.ended,lip=lipTrack?.sample(audio.currentTime)??{weights:[],closure:0},lipWeights={};
  AEMEATH_BINDINGS.forEach(([index],i)=>{if(i>=15&&i<=19)lipWeights[index]=lip.weights[i]??0;});
  actionFace.update({active:scene.bodyDirector.active,gestures:scene.motion.snapshot().gestures,activityFace:scene.body.pose.face,executor:scene.bodyDirector.executor,paused,snapshot:scene.snapshot()});
  if(!paused)now+=dt;
  const blinkAge=now%4.7,blink=blinkAge<.18?Math.sin(Math.PI*blinkAge/.18):0;
  const opts={speaking,lipWeights,closure:lip.closure,blink,paused,actionBlink:scene.actionLayer().blink};
  const weights=face.update(now,opts),old=oldFace.update(now,opts);
  const sample=LOCAL_MATH_SAMPLES.find(s=>s.id===$('emotion').value)??LOCAL_MATH_SAMPLES[0];
  const result=scene.step(now,dt,{faceWeights:baseline?old:weights,paused,render,audioTime:audio.currentTime,audioStatus:speaking?'playing':'idle',mathematicalState:sample});
  times.push(result.driverMs);if(times.length>6000)times.shift();return result;
}
function ui(){if(!ready)return;const snap=scene.snapshot(),a=snap.actorState,b=snap.body;
  const support={standing:'站立',seated:'坐姿','floor-seated':'席地坐姿',airborne:'腾空'}[a.support]??'核对支撑';
  $('caption').textContent=`${baseline?'原速单次对照':'扩展执行'} · ${support} · ${a.hands==='free'?'双手空闲':'保持持物'} · ${CHARACTER_ACTIONS[b.active?.action]?.label??'保持现场'} · ${a.phase}`;
  $('events').textContent=JSON.stringify(b.events.slice(-8),null,2);$('time').textContent=now.toFixed(1)+' 秒';$('seek').value=now;$('seek').max=Math.max(30,now+1);
  $('face-state').textContent=`数学情绪：${$('emotion').selectedOptions[0]?.textContent}；态度：${face.snapshot().attitude?.kind??'无'}；当前脸与身体分开控制。`;
}
function frame(t){const dt=Math.max(0,Math.min(.1,(t-last)/1000));last=t;if(ready&&!manual&&!fault)try{step(dt);if(Math.floor(t/200)!==Math.floor((t-dt*1000)/200))ui();}catch(e){fault=e.message;report('画面错误：'+fault);console.error(e);}requestAnimationFrame(frame);}
function choices(){const query=$('search').value.toLowerCase(),category=$('category').value;const rows=Object.values(CHARACTER_ACTIONS).filter(r=>(category==='all'||r.executor===category)&&(r.id+' '+r.label+' '+r.name).toLowerCase().includes(query));
  $('actions').replaceChildren(...rows.map(r=>new Option(`${r.label??r.name} · ${r.id}`,r.id)));if(rows.some(r=>r.id===selected))$('actions').value=selected;select();}
function select(){selected=$('actions').value;const r=CHARACTER_ACTIONS[selected];if(!r)return;$('description').textContent=r.note??r.label;$('contract').textContent=JSON.stringify(r,null,2);
  for(const [field,key] of [['variant','variant_set'],['micro','micro_set']])$(field).replaceChildren(new Option('不额外许可',''),...(r.performanceContract?.[key]??[]).map(v=>new Option(v,v)));
  $('duration').disabled=!r.performanceContract?.total_seconds;
}
function performanceFor(id){if(baseline)return undefined;const p={};const text=$('duration').value;if(text&&!$('duration').disabled)p.total_seconds=Number(text);if($('variant').value)p.variant_set=[$('variant').value];if($('micro').value)p.micro_set=[$('micro').value];return Object.keys(p).length?p:undefined;}
function prerequisites(id){const d=CHARACTER_ACTIONS[id],need=d.requires??{},steps=[];
  if(need.support==='seated'){
    steps.push('activity:sit_down');
    if(id!=='activity:approach_desk_seated'&&(need.held||need.existingSource||need.props?.includes('table')))steps.push('activity:approach_desk_seated');
  }
  if(need.held){const prop=need.held,seat=need.support==='seated'?'seated':'standing',take=prop==='box'?'pickup_box':`take_${prop}_${seat}`;if(CHARACTER_ACTIONS[`activity:${take}`])steps.push(`activity:${take}`);}
  return steps;
}
async function inspect(id,performanceOverride=undefined){
  const d=CHARACTER_ACTIONS[id];if(!d)throw Error('unknown_action');
  // Explicit fixture staging is only this local inspection button. The live
  // director never constructs a prerequisite sequence or manufactures props.
  let config=allSceneProps(),initialRoot;
  if(d.executor==='native'){
    // Native component acceptance uses exactly its declared props. Unrelated
    // furniture must not silently turn an open-floor route into a desk scene.
    for(const key of Object.keys(config))config[key]=false;
    for(const key of d.requires?.props??[])config[key]=true;
  }
  if(['activity','native','supported','conversation'].includes(d.executor)&&!d.requires?.held&&!d.requires?.existingSource&&!d.requires?.props?.includes('table')&&!d.requires?.props?.includes('chair')){
    for(const key of Object.keys(config))config[key]=false;
    for(const key of d.requires?.props??[])config[key]=true;
  }
  if(d.requires?.held==='box'||d.requires?.existingSource==='box')config.box={visible:true,attachment:'table',position:[0,8.9,3.8]};
  if(d.requires?.props?.includes('chair')||d.requires?.support==='seated'){
    const fixture=pulledOutDeskEntryFixture(scene.body.context,d.executor==='native'?{props:config}:{});config={...config,...fixture.sceneProps};initialRoot=fixture.initialRoot;
  }else if(config.table&&d.executor!=='native')config.chair=false;
  await reset({sceneProps:config,initialRoot});const perf=performanceOverride??performanceFor(id);
  const actions=[...prerequisites(id).map(action=>({action,anchor:'immediate'})),{action:id,anchor:'immediate',...(perf?{performance:perf}:{})}];
  lastPlan={id,performance:perf,sceneProps:config,initialRoot};report('独立单项预览'+(initialRoot?'（椅子起始已拉出，人物站在椅前；没有运行时挪动物品）':'')+'：前置步骤 '+(actions.length>1?actions.slice(0,-1).map(x=>x.action).join(' → '):'无'));
  return submit(actions);
}
async function seek(seconds){if(!lastPlan)return;manual=true;const plan=copy(lastPlan);await inspect(plan.id,plan.performance);for(let t=0;t<seconds;t+=1/60){
  step(1/60,false);const deadline=performance.now()+60000;
  while(scene.bodyDirector.pending.some(r=>r.preparation==='loading'||r.nativePreparation==='loading')){if(performance.now()>deadline)throw Error('资源准备尚未完成，请稍后重新拖动');await sleep(10);step(0,false);}
  if(Math.round(t*60)%120===0)await sleep(0);
}step(0,true);paused=true;ui();}
function cancel(){audio.pause();generation++;scene.bodyDirector.cancel(null,'user_interrupt');scene.body.releaseHold?.();scene.body.stop();attentionToken=null;report('撤销旧指令，身体从当前姿态收稳；语音立即停止。');}
function resumeDisplay(){paused=false;manual=false;last=performance.now();$('pause').textContent='暂停';}
function save(){const blob=new Blob([JSON.stringify(snapshot(),null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='motion-library-local-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function snapshot(){return {ready,fault,now,paused,manual,baseline,catalogHash:CHARACTER_CATALOG.hash,actionCount:Object.keys(CHARACTER_ACTIONS).length,scene:scene?.snapshot(),face:face?.snapshot(),events:copy(events),driverMs:times.slice(),cloudCalls:0,source:'explicit_local_component_commands'};}
window.motionLibrary={snapshot,reset,inspect,submit,step,seek,cancel,ui,setManual(value){manual=!!value;last=performance.now();},setPaused(value){paused=!!value;},get scene(){return scene;},get catalog(){return CHARACTER_ACTIONS;},get face(){return face;}};
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>scene?.setView(b.dataset.view);
$('search').oninput=choices;$('category').onchange=choices;$('actions').onchange=select;
$('play').onclick=()=>{resumeDisplay();const performance=performanceFor(selected);submit([{action:selected,anchor:'immediate',...(performance?{performance}:{}),...(selected.startsWith('control:')?{activity_token:scene.snapshot().actorState.activityToken}:{})}]);};
$('inspect').onclick=()=>{resumeDisplay();inspect(selected).catch(e=>report(e.message));};$('seek').onchange=()=>seek(Number($('seek').value)).catch(e=>report(e.message));
$('pause').onclick=()=>{paused=!paused;manual=false;$('pause').textContent=paused?'继续':'暂停';};$('interrupt').onclick=()=>{cancel();resumeDisplay();};
function control(name){const token=scene.snapshot().actorState.activityToken;if(!token)return report('当前没有可控制的活动');return submit([{action:`control:${name}_activity`,anchor:'immediate',activity_token:token}]);}
$('attention').onclick=()=>report(JSON.stringify(scene.bodyDirector.pauseForAttention({reason:'user_speech_started'})));
$('resume').onclick=()=>control('resume');
$('release').onclick=()=>control('finish');
$('baseline').onclick=()=>{baseline=!baseline;$('baseline').textContent=baseline?'切回新增表现':'对照原速单次与原表情';report(baseline?'对照：同一播放器使用原速单次、原持续表情；不是旧版整个程序。':'扩展执行：启用明确许可的持续中段与表情组合。');};
$('audio').onclick=async()=>{try{if(!lipTrack)lipTrack=new LipTrack(await json('/data/chinese-probe.json'),await json('/data/waveform.json'));audio.currentTime=0;await audio.play();}catch(e){report(e.message);}};
$('export').onclick=save;
$('record').onclick=()=>{
  if(recorder?.state==='recording'){recorder.stop();return;}
  recordParts=[];const stream=$('stage').querySelector('canvas').captureStream(30);
  recorder=new MediaRecorder(stream,{mimeType:MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm'});
  recorder.ondataavailable=e=>{if(e.data.size)recordParts.push(e.data);};
  recorder.onstop=()=>{const link=$('recording');link.href=URL.createObjectURL(new Blob(recordParts,{type:'video/webm'}));link.download='aemeath-library-local-review.webm';link.hidden=false;stream.getTracks().forEach(t=>t.stop());$('record').textContent='录制动作画面';};
  recorder.start(250);$('record').textContent='停止录像';report('正在按页面实际播放速度录制画面；录像不含麦克风。');
};
$('emotion').replaceChildren(...LOCAL_MATH_SAMPLES.map(s=>new Option(s.label,s.id)));
for(const id of ['attitude','secondary'])$(id).replaceChildren(new Option('不指定',''),...ATTITUDE_KINDS.map(k=>new Option(labels[k],k)));
$('emotion').onchange=()=>{const s=LOCAL_MATH_SAMPLES.find(s=>s.id===$('emotion').value);face?.setMathematical(s,++revision);oldFace?.setMathematical(s,revision);};
$('set-face').onclick=()=>{const kind=$('attitude').value;if(!kind){if(face.attitude)face.clearAttitude({...face.attitude,revision:++revision});return;}const c={id:`local-${revision}`,kind,strength:.6,source:'local-review',revision:++revision,evidenceId:`manual-${revision}`,...($('secondary').value?{secondary:{kind:$('secondary').value,strength:.35}}:{})};face.setAttitude(c);oldFace.setAttitude({...c,secondary:undefined});};
try{faceData=await json('/face-preparation-data/playback.json');choices();$('summary').textContent=`统一目录 ${Object.keys(CHARACTER_ACTIONS).length} 项 · 真实条件与回执 · 原速身体与衣发`;
  await reset();const mod=await import('../character-center/catalog.mjs'),inventory=mod.NATIVE_INVENTORY??[];const rows=Array.isArray(inventory)?inventory:inventory.groups??[];
  $('inventory').textContent=`原生来源审查 ${rows.length} 组；生活活动 ${Object.values(CHARACTER_ACTIONS).filter(r=>r.executor==='activity').length} 项。`;
  $('excluded').textContent=JSON.stringify(rows.filter(r=>r.policy?.scope!=='single-character').map(r=>({groupId:r.groupId,source:r.sourceFamily,reason:r.policy.reason,scope:r.policy.scope})),null,2);report('页面已准备好。请选一个动作；不会自动调用云端。');
}catch(e){fault=e.message;report(fault);console.error(e);}requestAnimationFrame(frame);
