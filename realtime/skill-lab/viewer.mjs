import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MMDLoader,MMDAnimationHelper} from '@takahirox/three-mmd';
import {NativeClip,NativeRetarget} from '/preview/core/native-motion.js';
import {NativeResourceLayer} from '/preview/core/native-resource-layer.js';
import {NativeClothBinding} from '/preview/core/native-cloth-binding.js';
import {NativeExpressionBinding} from '/preview/core/native-expression.js';
import {findNativeRibbonCompanion} from '/preview/core/native-companion.js';
import {skeletonFromMesh} from '/preview/studio/motion-rig.js';
import {buildRig,handRelative,solveArm} from '/preview/core/motion-skeleton.js';
import {AEMEATH_MOTION_BINDING} from '/preview/core/motion-profile.js';
import {SkillReaction,reviewAt,reactionFace,REACTION_META} from '/preview/core/skill-reaction.js';

const $=id=>document.getElementById(id),base='/native-resources-data';
const phaseNames={idle:'已回到原生待机',prepare:'想要回应',arrest:'察觉更正 · 收住',wait:'安静等你改完',confirm:'已经理解 · 确认',recover:'放松收手',cancelled:'中断 · 平滑返回'};
let controller=reviewAt(0),demo=true,playing=true,enabled=true,ready=false,error=null,time=0,view='front';
let mesh,source,clip,retarget,cloth,ribbon,faceBinding,rig,rest,grantSolver,armGrants,baseDescriptor,ribbonDescriptor;
let faceResult=null,armDiagnostic={},frame=0,last=performance.now(),lastStepMs=0,environment=null;
let pendingControllerMs=0,lastTimings={};const timingSamples=[];
const loadDiagnostics={stage:'renderer-init',startedAt:performance.now(),assets:{},textureProgress:null};
const stage=value=>{loadDiagnostics.stage=value;$('status').textContent='载入进度：'+value;};
const tracked=(name,promise)=>{const start=performance.now();loadDiagnostics.assets[name]={status:'loading',startedAt:start};return promise.then(value=>{loadDiagnostics.assets[name]={status:'fulfilled',elapsedMs:performance.now()-start};return value;},problem=>{loadDiagnostics.assets[name]={status:'rejected',elapsedMs:performance.now()-start,error:problem.message};throw problem;});};
const durations=[],scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(34,1,.1,200);
scene.background=new THREE.Color('#e6e8e0');
const renderer=new WebGPURenderer({antialias:true,forceWebGL:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));await renderer.init();
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;
$('stage').append(renderer.domElement);
scene.add(new THREE.AmbientLight(0xffffff,1.35));
for(const [color,intensity,p] of [[0xfff5e5,2,[-12,28,20]],[0xc7e0fa,1,[15,15,-8]]]){const light=new THREE.DirectionalLight(color,intensity);light.position.set(...p);scene.add(light);}
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#d8dfd0',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.05;scene.add(floor);
const grid=new THREE.GridHelper(200,100,'#a7b3a3','#c5cebd');grid.position.y=-.02;scene.add(grid);
const v=new THREE.Vector3(),q=new THREE.Quaternion(),e=new THREE.Euler();

function setCamera(){
  const face=view==='face',focus=face&&mesh?mesh.skeleton.bones.find(b=>b.name==='頭').getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0,.5,0)):new THREE.Vector3(0,10,0);
  const yaw={front:0,side:Math.PI/2,angle:.65,face:0}[view],dist=(face?8.4:36)*Math.max(1,.8/camera.aspect);
  camera.position.set(focus.x+Math.sin(yaw)*dist,focus.y+(face?.3:2.6),focus.z+Math.cos(yaw)*dist);camera.lookAt(focus);
}
new ResizeObserver(()=>{const host=$('stage');renderer.setSize(host.clientWidth,host.clientHeight);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();setCamera();if(ready)render();}).observe($('stage'));
function delta(name,x,y=0,z=0){const bone=retarget.bones.get(name);if(bone)bone.quaternion.multiply(q.setFromEuler(e.set(x,y,z))).normalize();}
function applyOriginal(p){
  // Native playback restores every local transform before this layer. Torso writes
  // are right-multiplied local deltas; arm writes are explicit full local poses.
  delta('上半身',p.lean*.56,p.twist*.4,0);
  delta('上半身2',p.lean*.29,p.twist*.35,0);
  delta('上半身1',p.lean*.15,p.twist*.25,0);
  delta('首',p.pitch*.32-p.lean*.12,0,p.roll*.3);
  delta('頭',p.pitch*.68-p.lean*.2,-p.twist*.3,p.roll*.7);
  mesh.updateMatrixWorld(true);
  armDiagnostic={};
  if(p.arm>1e-8){
    const side='R',sign=rig.sides.R.sign;
    const mirrored=a=>[sign*a[0],a[1],a[2]];
    const palm=[-.82+( -.08+.82)*p.palm,1*p.palm,-.56+(.25+.56)*p.palm];
    const point=[.18,.07+(-.07+.14)*p.palm,1];
    const pose={hand:mirrored([2.92+p.out,11.26+p.lift,-.26+p.forward]),pole:mirrored([.55,-.65,-.65]),
      palm:mirrored(palm),point:mirrored(point),shrug:-.012,protract:.025,curl:.23+p.curl,thumb:.16,spread:.18};
    const oriented=handRelative(rig,side,pose);pose.palm=oriented.palm;pose.point=oriented.point;
    const chest=retarget.bones.get(rig.torso.upperChest.name),rot=chest.getWorldQuaternion(new THREE.Quaternion()).toArray(),pos=chest.getWorldPosition(new THREE.Vector3()).toArray();
    const locals=new Map();solveArm(rig,side,pose,rot,pos,locals,armDiagnostic);
    const w=Math.max(0,Math.min(1,p.arm));
    for(const [name,rotation]of locals){const bone=retarget.bones.get(name),bind=rest.get(name);if(!bone||!bind)continue;const full=bind.q.clone().multiply(new THREE.Quaternion(...rotation));bone.quaternion.slerp(full,w).normalize();}
    // Reuse the model's actual PMX append coefficients/axes, not guessed 1/4 shares.
    // Only right-arm twist helpers are in this layer's grant mask. NativeRetarget
    // restores ALL locals (including these helpers) before the next frame.
    for(const grant of armGrants){const helper=mesh.skeleton.bones[grant.index],native=helper.quaternion.clone();
      helper.quaternion.copy(rest.get(helper.name).q);grantSolver.updateOne(grant);
      helper.quaternion.copy(native.slerp(helper.quaternion,w));
    }
  }
  mesh.updateMatrixWorld(true);mesh.skeleton.update();
}
function render(){
  if(!ready)return;const begin=performance.now(),at=time%clip.data.duration;
  clip.sample(at);clip.applyToGLTF(source);retarget.apply();
  if(ribbon){ribbon.native.apply(time%ribbon.clip.data.duration);ribbon.target.apply(time%ribbon.clip.data.duration);}
  cloth.apply({availableSourceNames:new Set([...clip.indices.keys(),...(ribbon?.clip.indices.keys()??[])])});
  const nativeDone=performance.now();
  const p=controller.pose();if(enabled)applyOriginal(p);else armDiagnostic={};
  const reactionDone=performance.now();
  // Only this binding's previous brow/eye/corner channels are cleared. Speech is untouched.
  faceResult=faceBinding.apply(mesh,enabled?reactionFace(p):{});
  const faceDone=performance.now();
  setCamera();renderer.render(scene,camera);const renderDone=performance.now();lastStepMs=renderDone-begin;
  lastTimings={controllerMs:pendingControllerMs,nativeMs:nativeDone-begin,reactionMs:reactionDone-nativeDone,faceMs:faceDone-reactionDone,renderMs:renderDone-faceDone,totalMs:lastStepMs};pendingControllerMs=0;
  timingSamples.push({...lastTimings});if(timingSamples.length>300)timingSamples.shift();
  durations.push(lastStepMs);if(durations.length>300)durations.shift();frame++;
  $('phase').textContent=(enabled?'':'原生底层 · ')+phaseNames[controller.phase];$('time').textContent=time.toFixed(2)+' s';
  $('timeline').value=String(Math.min(4.5,time));$('play').textContent=playing?'暂停':'播放';
}
function pause(value=true){playing=!value;controller.pause(value);last=performance.now();render();return snapshot();}
function play(){return pause(false);}
function seek(value){const t=Number(value);if(!Number.isFinite(t)||t<0)throw Error('Invalid seek');time=Math.min(t,18);demo=true;const start=performance.now();controller=reviewAt(time);controller.pause(!playing);pendingControllerMs=performance.now()-start;render();last=performance.now();return snapshot();}
function restart(){time=0;demo=true;controller=reviewAt(0);playing=true;last=performance.now();render();return snapshot();}
function manual(){time=0;demo=false;controller=new SkillReaction();controller.start({dedupeKey:'manual-'+frame});playing=true;last=performance.now();render();return snapshot();}
function correction(command){demo=false;const receipt=controller.correction(command??controller.command());render();return {receipt,...snapshot()};}
function confirm(command){demo=false;const receipt=controller.confirm(command??controller.command({understood:true,speakerCompleted:true,partnerVoicing:false}));render();return {receipt,...snapshot()};}
function interrupt(command){demo=false;const receipt=controller.interrupt(command??{});render();return {receipt,...snapshot()};}
function setEnabled(value){enabled=Boolean(value);$('layer').checked=enabled;render();return snapshot();}
function setView(value){if(!['front','side','angle','face'].includes(value))throw Error('Unknown view');view=value;for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));setCamera();render();return snapshot();}
function setSpeech(value){const index=mesh.morphTargetDictionary['あ'];mesh.morphTargetInfluences[index]=value;$('vowel').checked=value!==0;render();return snapshot();}
function boneSample(){if(!mesh)return null;mesh.updateMatrixWorld(true);return Object.fromEntries(mesh.skeleton.bones.map(b=>[b.name,{p:b.position.toArray(),q:b.quaternion.toArray(),s:b.scale.toArray(),world:b.getWorldPosition(new THREE.Vector3()).toArray()}]));}
function snapshot(){const sorted=[...durations].sort((a,b)=>a-b),segments=Object.fromEntries(Object.keys(lastTimings).map(key=>{const values=timingSamples.map(row=>row[key]).sort((a,b)=>a-b);return [key,{medianMs:values[Math.floor(values.length*.5)]??0,p95Ms:values[Math.floor(values.length*.95)]??0}];}));return {ready,error,time,playing,demo,enabled,view,frame,lastStepMs,loadDiagnostics:structuredClone(loadDiagnostics),performance:{samples:durations.length,medianMs:sorted[Math.floor(sorted.length*.5)]??0,p95Ms:sorted[Math.floor(sorted.length*.95)]??0,lastSegments:{...lastTimings},segments,note:'CPU wall time for sampling/composition/render submission; not GPU completion time or a 60 FPS guarantee.'},environment,controller:controller.snapshot(),faceResult,
  speechA:mesh?.morphTargetInfluences[mesh?.morphTargetDictionary['あ']]??null,arm:armDiagnostic,
  base:{id:baseDescriptor?.id,ribbonId:ribbonDescriptor?.id,time:clip?.time},cloth:cloth?.snapshot(),meta:REACTION_META,
  target:retarget?.snapshot()};}
window.skillLab={snapshot,play,pause,seek,restart,manual,correction,confirm,interrupt,setEnabled,setLayer:setEnabled,setView,setSpeech,boneSample,
  get mesh(){return mesh;},get source(){return source;},get controller(){return controller;},get renderer(){return renderer;},get camera(){return camera;}};
$('restart').onclick=restart;$('play').onclick=()=>pause(playing);$('timeline').oninput=()=>{pause(true);seek($('timeline').value);};
$('manual').onclick=manual;$('correction').onclick=()=>correction();$('confirm').onclick=()=>confirm();$('interrupt').onclick=()=>interrupt();
$('layer').onchange=()=>setEnabled($('layer').checked);$('vowel').onchange=()=>setSpeech($('vowel').checked?.32:0);
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>setView(b.dataset.view);
function loop(now){const dt=Math.min(.1,Math.max(0,(now-last)/1000));last=now;if(ready&&playing){time+=dt;const start=performance.now();if(demo){if(time>=4.5){time=4.5;playing=false;}controller=reviewAt(time);controller.pause(!playing);}else controller.advance(dt);pendingControllerMs=performance.now()-start;render();}requestAnimationFrame(loop);}
requestAnimationFrame(loop);
try{
  stage('manifest-loading');const manifest=await tracked('manifest',fetch(base+'/manifest.json').then(r=>r.json()));
  baseDescriptor=manifest.clips.find(c=>c.resourceKind==='body'&&/\/Stand2\.uasset$/.test(c.sourceAsset));
  ribbonDescriptor=findNativeRibbonCompanion(baseDescriptor,manifest.clips);if(!baseDescriptor||!ribbonDescriptor)throw Error('Reviewed Stand2 and exact ribbon companion are required');
  stage('four-resources-loading');const manager=new THREE.LoadingManager();manager.onProgress=(url,loaded,total)=>{loadDiagnostics.textureProgress={url,loaded,total};};manager.onError=url=>{loadDiagnostics.textureError=url;};
  const [gltf,target,data,ribbonData]=await Promise.all([tracked('sourceGLTF',new GLTFLoader(manager).loadAsync(base+'/source.glb')),tracked('targetPMX',new MMDLoader(manager).loadAsync('/model/'+encodeURIComponent('鸣潮_爱弥斯1.05.pmx'))),
    tracked('bodyClip',fetch(base+'/clips/'+baseDescriptor.id+'.json').then(r=>r.json())),tracked('ribbonClip',fetch(base+'/clips/'+ribbonDescriptor.id+'.json').then(r=>r.json()))]);
  stage('rig-binding');
  source=gltf.scene;mesh=target;mesh.frustumCulled=false;scene.add(mesh);
  rig=buildRig(skeletonFromMesh(mesh),AEMEATH_MOTION_BINDING);rest=new Map(mesh.skeleton.bones.map(b=>[b.name,{p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}]));
  grantSolver=new MMDAnimationHelper().createGrantSolver(mesh);
  armGrants=grantSolver.grants.filter(g=>/^右(?:腕捩|手捩)[123]$/.test(mesh.skeleton.bones[g.index].name));
  const capture=root=>{const a=[];root.updateMatrixWorld(true);root.traverse(node=>{if(node.isBone)a.push({node,p:node.position.clone(),q:node.quaternion.clone(),s:node.scale.clone(),wq:node.getWorldQuaternion(new THREE.Quaternion())});});return a;};
  const sourceRest=capture(source),targetRest=capture(mesh);faceBinding=new NativeExpressionBinding(mesh);stage('cloth-binding');cloth=new NativeClothBinding(source,mesh);
  stage('native-retarget');
  clip=new NativeClip(data);retarget=new NativeRetarget(clip,mesh);source.scale.setScalar(retarget.scale*100);
  const rc=new NativeClip(ribbonData);ribbon={clip:rc,native:new NativeResourceLayer(rc,source,{kind:'ribbon',native:true,bindPose:sourceRest,composition:'replace'}),target:new NativeResourceLayer(rc,mesh,{kind:'ribbon',native:false,bindPose:targetRest,composition:'replace'})};
  stage('shader-compile');await renderer.compileAsync(scene,camera);const gl=renderer.backend.gl,ext=gl.getExtension('WEBGL_debug_renderer_info');environment={renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown',pixelRatio:renderer.getPixelRatio(),width:$('stage').clientWidth,height:$('stage').clientHeight};
  stage('ready');
  ready=true;setView('front');restart();$('status').textContent='真实模型已就绪 · 原生底层与新作层共用时间轴';
}catch(problem){error=problem.message;$('status').textContent='载入失败：'+error;console.error(problem);}
