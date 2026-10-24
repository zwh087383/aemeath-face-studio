import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MMDLoader} from '@takahirox/three-mmd';
import {NativeClothBinding} from '/preview/core/native-cloth-binding.js';
import {NativeBehaviorAdapter} from '/preview/core/native-behavior-adapter.js';
import {PreparedFaceController} from '/preview/core/prepared-face-controller.js';
import {IdleMotion} from './motion.mjs';
import {IdleScheduler} from './scheduler.mjs';
import {VoiceGate} from './voice-gate.mjs';
const $=id=>document.getElementById(id);
const api='/idle-activity-demo/';
let renderer,scene,camera,mesh,source,adapter,motion,scheduler,face,faceOwner,state;
let ready=false,view='front',last=performance.now(),clock=0,manual=false,frame=0,faceSerial=0,lastMode='idle',lastPoll=0,polling=false;
let micStream,micContext,analyser,micData,voiceGate,commandChain=Promise.resolve(),autoAbort=0;
const timings={startup:{},samples:[]},errors=[],history=[];
const json=async url=>{const r=await fetch(url);if(!r.ok)throw Error(await r.text());return r.json();};
function notice(text){$('load').textContent=text;}
const eventNames={started:'后台开始活动',paused:'后台保存进度',pause:'暂停活动',resumed:'后台恢复活动',completed:'后台确认完成','artifact-ready':'真实产物已保存','speech-start':'用户开口，转向倾听','speech-end':'用户暂时停声','conversation-end':'交谈结束，等待后台恢复',resume:'请求继续活动',cancelled:'活动已取消','section-processed':'处理一个资料段落',failed:'活动失败'};
function applyState(next){if(!scheduler.accept(next))return;state=next;updateUI();}
async function refresh(){if(polling)return;polling=true;try{applyState(await json(api+'state'));}catch(e){scheduler.connectionLost();notice('后台状态暂不可用：'+e.message);}finally{polling=false;}}
function command(action,{source='button',automatic=false}={}){
  if(!automatic){autoAbort++;$('auto-state').textContent='手动控制中';}
  if(action==='speech-start')scheduler.attention();
  const work=async()=>{
    if(!state)throw Error('后台尚未准备好');
    const r=await fetch(api+'command',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action,source,sessionId:state.sessionId,generation:state.generation,commandId:crypto.randomUUID()})});
    const data=await r.json();if(!r.ok)throw Error(data.error);
    applyState(data);return data;
  };
  const result=commandChain.then(work);
  commandChain=result.catch(e=>{notice(e.message);if(action==='speech-start')scheduler.localAttention=false;});
  return result;
}
function updateUI(){
  if(!state)return;
  const status=state.task?.status??'idle';
  $('backend-state').textContent=({idle:'尚未开始',running:state.provider==='artifact-ready'?'成果已就绪 · 等待收束':'进行中',paused:'已暂停',done:'已完成',failed:state.provider==='cancelled'?'已取消':'失败'}[status]??status);
  $('progress').max=state.total;$('progress').value=state.progress;
  $('progress-text').textContent=state.task?'已实际处理 '+state.progress+' / '+state.total+' 段；'+(state.artifact?'产物已由 WAI 保存。':'完成后会保存一份段落索引。'):'开始后，将实际提取本地资料的段落标题和字数。';
  $('remaining').textContent=status==='running'?'当前活动约剩 '+state.remainingSeconds.toFixed(1)+' 秒（演示时间）':status==='paused'?(state.engaged?'交谈期间保持暂停，点击“交谈结束”再继续。':state.manualPause?'暂停中，进度保留。':'等待原后台恢复窗口：'+state.resumeWaitSeconds.toFixed(1)+' 秒'):'';
  $('interaction').textContent=state.engaged?'正在倾听 · 交谈中':'安静陪伴';
  const active=['running','paused','planned'].includes(status);
  $('start').disabled=!ready||active||state.engaged;$('pause').disabled=!ready||status!=='running';
  $('resume').disabled=!ready||!state.manualPause||state.engaged;$('cancel').disabled=!ready||!active;
  $('speak').disabled=!ready||state.engaged;$('end').disabled=!ready||!state.engaged;
  $('artifact').disabled=!state.artifact;
  if(status==='done')$('auto-state').textContent='本轮已完成，可以再次演示。';
  $('events').replaceChildren(...state.events.filter(e=>e.event!=='section-processed').slice(-10).reverse().map(e=>{const li=document.createElement('li');li.textContent=(eventNames[e.event]??e.event)+' · #'+e.revision;return li;}));
}
function resize(){const host=$('stage');renderer.setSize(host.clientWidth,host.clientHeight);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();}
function placeCamera(){
  const head=mesh.skeleton.bones.find(b=>b.name==='頭'),hip=mesh.skeleton.bones.find(b=>b.name==='腰');
  const target=hip.getWorldPosition(new THREE.Vector3()).lerp(head.getWorldPosition(new THREE.Vector3()),.4);target.y-=3;
  const yaw={front:0,angle:.6,side:Math.PI/2}[view],d=34*Math.max(1,.77/camera.aspect);
  camera.position.set(target.x+Math.sin(yaw)*d,target.y+2,target.z+Math.cos(yaw)*d);camera.lookAt(target);
}
function faceState(){
  const mode=scheduler.mode;if(mode===lastMode)return;lastMode=mode;
  if(faceOwner)face.retire(faceOwner);faceOwner=null;
  if(mode==='working'){faceOwner={source:'idle-demo',generation:++faceSerial};face.start('authored-expression:focus',faceOwner,{hold:55,intensity:.38,attack:.5,release:.6});}
}
function renderStep(dt){
  if(!ready)return;
  const start=performance.now();clock+=dt;motion.advance(dt);faceState();
  const blinkPhase=clock%5.7,blink=blinkPhase<.18?Math.sin(blinkPhase/.18*Math.PI):0;
  const weights=face.update(clock,{blink});for(let i=0;i<mesh.morphTargetInfluences.length;i++)mesh.morphTargetInfluences[i]=weights[i]??0;
  const driverMs=performance.now()-start;placeCamera();renderer.render(scene,camera);
  timings.samples.push({driverMs,submitMs:performance.now()-start,dt});if(timings.samples.length>600)timings.samples.shift();frame++;
  $('motion-state').textContent=motion.exitPending?'正在自然收势…':({idle:'安静陪伴',working:'专注整理资料',paused:'活动已暂停 · 放松保持',listening:'面向你，准备交谈',complete:'活动完成 · 回到陪伴'}[motion.mode]??motion.mode);
  $('native-label').textContent=motion.mode==='working'||motion.exitPending?'原生 Thinking01':'原生 Stand2';
  if(frame%40===0)$('diagnostics').textContent=JSON.stringify(snapshot(),null,2);
}
function snapshot(){return {ready,frame,view,errors,backend:state,scheduler:scheduler?.snapshot(),motion:motion?.snapshot(),
  micEnabled:Boolean(micStream),face:face?{active:face.snapshot().active}:null,
  timings:{startup:timings.startup,samples:timings.samples.slice(-240)},sourceSpeed:1,cloudCalls:0};}
function sampleMic(dt){
  if(!analyser)return;
  analyser.getFloatTimeDomainData(micData);
  const rms=Math.sqrt(micData.reduce((n,v)=>n+v*v,0)/micData.length);
  $('meter-fill').style.width=Math.min(100,rms*1500)+'%';
  const event=voiceGate.update(rms,dt);
  if(event)void command(event,{source:'microphone'}).catch(()=>{});
}
async function toggleMic(){
  if(micStream){micStream.getTracks().forEach(t=>t.stop());await micContext.close();micStream=analyser=null;$('mic').textContent='启用麦克风';return;}
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    micContext=new AudioContext();await micContext.resume();analyser=micContext.createAnalyser();analyser.fftSize=1024;
    micContext.createMediaStreamSource(micStream).connect(analyser);micData=new Float32Array(analyser.fftSize);voiceGate=new VoiceGate();
    $('mic').textContent='关闭麦克风';$('mic-note').textContent='正在本地监听。持续声音触发注意；停声后仍保持交谈，点击“交谈结束”再恢复。环境噪声也可能触发。';
    micStream.getTracks()[0].onended=()=>{analyser=null;micStream=null;$('mic').textContent='启用麦克风';};
  }catch(e){notice('麦克风未启用：'+e.message+'。可以使用“模拟我开口”。');}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function autoDemo(){
  const token=++autoAbort;$('auto-state').textContent='自动演示中…';
  const check=()=>{if(token!==autoAbort)throw Error('演示已被手动接管');};
  try{
    if(['running','paused'].includes(state.task?.status))await command('cancel',{automatic:true});
    if(state.engaged)await command('conversation-end',{automatic:true});
    await command('start',{automatic:true});check();
    await sleep(2300);check();await command('pause',{automatic:true});
    await sleep(1800);check();await command('resume',{automatic:true});
    await sleep(5100);check();await command('speech-start',{automatic:true,source:'scripted-demo'});
    await sleep(2400);check();await command('speech-end',{automatic:true});
    await sleep(900);check();await command('conversation-end',{automatic:true});
    $('auto-state').textContent='等待活动恢复并完成；可随时开口。';
  }catch(e){$('auto-state').textContent=e.message;}
}
$('start').onclick=()=>void command('start').catch(()=>{});
$('pause').onclick=()=>void command('pause').catch(()=>{});
$('resume').onclick=()=>void command('resume').catch(()=>{});
$('cancel').onclick=()=>void command('cancel').catch(()=>{});
$('speak').onclick=()=>void command('speech-start').catch(()=>{});
$('end').onclick=()=>void command('conversation-end').catch(()=>{});
$('mic').onclick=()=>void toggleMic();$('auto').onclick=()=>void autoDemo();
$('artifact').onclick=()=>{$('result-text').textContent=state.artifact?.content??'';$('result').showModal();};
$('close-result').onclick=()=>$('result').close();
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{view=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b===button));};
window.idleActivityDemo={snapshot,command,refresh,autoDemo,setManualClock:value=>{manual=Boolean(value);},
  step:dt=>{renderStep(dt);return snapshot();},setView:value=>{view=value;renderStep(0);},
  get mesh(){return mesh;},get adapter(){return adapter;},get motion(){return motion;},get scheduler(){return scheduler;},
  voiceSample:(rms,dt)=>{voiceGate??=new VoiceGate();const event=voiceGate.update(rms,dt);if(event)return command(event,{source:'synthetic-energy-test'});return null;}};
function frameLoop(now){
  const dt=Math.max(0,Math.min(.06,(now-last)/1000));last=now;
  try{if(ready){sampleMic(dt);if(!manual)renderStep(dt);if(now-lastPoll>350){lastPoll=now;void refresh();}}}
  catch(e){errors.push(e.message);notice('显示异常：'+e.message);ready=false;console.error(e);}
  requestAnimationFrame(frameLoop);
}requestAnimationFrame(frameLoop);
try{
  const started=performance.now();notice('读取原生动作与表情目录…');
  const [manifest,queue,faces]=await Promise.all([json('/native-resources-data/manifest.json'),json('/native-behavior-data/queue.json'),json('/face-preparation-data/playback.json')]);
  timings.startup.catalogMs=performance.now()-started;
  scene=new THREE.Scene();scene.background=new THREE.Color('#e3e8dd');camera=new THREE.PerspectiveCamera(35,1,.1,200);
  renderer=new WebGPURenderer({antialias:true,forceWebGL:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));await renderer.init();renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;
  $('stage').append(renderer.domElement);scene.add(new THREE.AmbientLight(0xffffff,1.5));
  for(const [p,v] of [[[12,25,22],2],[[-15,18,-8],1]]){const light=new THREE.DirectionalLight(0xfff5e6,v);light.position.set(...p);scene.add(light);}
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#dce3d3',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.05;scene.add(floor);
  new ResizeObserver(resize).observe($('stage'));resize();
  notice('载入角色、贴图与原生衣发绑定…');const modelAt=performance.now();
  const [gltf,target]=await Promise.all([new GLTFLoader().loadAsync('/native-resources-data/source.glb'),new MMDLoader().loadAsync('/model/'+encodeURIComponent('鸣潮_爱弥斯1.05.pmx'))]);
  source=gltf.scene;mesh=target;mesh.frustumCulled=false;source.visible=false;scene.add(source,mesh);
  source.traverse(n=>{if(n.isMesh)n.frustumCulled=false;});timings.startup.modelMs=performance.now()-modelAt;
  adapter=new NativeBehaviorAdapter({source,mesh,cloth:new NativeClothBinding(source,mesh),manifest});
  motion=new IdleMotion({adapter,manifest,groups:queue.groups});const nativeAt=performance.now();
  await motion.load(id=>json('/native-resources-data/clips/'+encodeURIComponent(id)+'.json'));timings.startup.nativeMs=performance.now()-nativeAt;
  scheduler=new IdleScheduler(motion);
  face=new PreparedFaceController({recipes:faces.recipes,morphCount:faces.model.morphCount,mouthIndices:faces.mouthIndices});face.setBase({},0);face.resumeClock(0);
  placeCamera();const compileAt=performance.now();await renderer.compileAsync(scene,camera);timings.startup.compileMs=performance.now()-compileAt;
  ready=true;await refresh();$('mic').disabled=false;$('auto').disabled=false;updateUI();renderStep(0);
  timings.startup.totalMs=performance.now()-started;notice('准备完成 · 原生动作原速 · 本地后台活动');
}catch(e){errors.push(e.message);notice('准备失败：'+e.message);console.error(e);}
window.addEventListener('pagehide',()=>{micStream?.getTracks().forEach(t=>t.stop());void micContext?.close();});
