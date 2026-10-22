import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MMDLoader} from '@takahirox/three-mmd';
import {NativeClip,NativeRetarget} from '/preview/core/native-motion.js';

const $=id=>document.getElementById(id), status=$('status'),loadStarted=performance.now();
let ready=false,playing=true,time=0,speed=1,view='front',last=performance.now(),frame=0,lastStepMs=0;
const stages=[];
async function stage(id) {
  const host=$(id),scene=new THREE.Scene();scene.background=new THREE.Color('#e6e8e0');
  const camera=new THREE.PerspectiveCamera(35,1,.1,150);
  const renderer=new WebGPURenderer({antialias:true,forceWebGL:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.4));await renderer.init();
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;host.append(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff,1.35));
  for(const [c,n,p] of [[0xfff5e5,2,[-12,28,20]],[0xc7e0fa,1,[15,15,-8]]]) {const l=new THREE.DirectionalLight(c,n);l.position.set(...p);scene.add(l);}
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:'#d8dfd0',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.05;scene.add(floor);
  const grid=new THREE.GridHelper(40,20,'#a7b3a3','#c5cebd');grid.position.y=-.02;scene.add(grid);
  const resize=()=>{
    renderer.setSize(host.clientWidth,host.clientHeight);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();
    if(window.nativeMotion){cameraView();window.nativeMotion.seek(window.nativeMotion.snapshot().time);}
  };new ResizeObserver(resize).observe(host);resize();
  const row={scene,camera,renderer};stages.push(row);return row;
}
function cameraView() {
  const yaw={front:0,angle:.65,side:Math.PI/2,back:Math.PI}[view];
  for(const {camera} of stages){const d=36*Math.max(1,.8/camera.aspect);camera.position.set(Math.sin(yaw)*d,13.2,Math.cos(yaw)*d);camera.lookAt(0,9,0);}
}
try {
  const response=await fetch('/native-data/clip.json');if(!response.ok)throw Error('本地原生动作数据未准备好');
  const data=await response.json(),clip=new NativeClip(data);
  status.textContent='原生动画已解码，正在准备两侧渲染器…';
  const [left,right]=await Promise.all([stage('source-stage'),stage('target-stage')]);cameraView();
  status.textContent='正在读取原生网格、现有 PMX 与贴图…';
  const [gltf,mesh]=await Promise.all([new GLTFLoader().loadAsync('/native-data/source.glb'),new MMDLoader().loadAsync('/model/'+encodeURIComponent('鸣潮_爱弥斯1.05.pmx'))]);
  right.scene.add(mesh);mesh.frustumCulled=false;
  const retarget=new NativeRetarget(clip,mesh),source=gltf.scene;
  source.scale.setScalar(retarget.scale*100);left.scene.add(source);
  source.traverse(o=>{if(o.isMesh){o.frustumCulled=false;o.material=new THREE.MeshStandardMaterial({color:'#889c8e',roughness:.72,metalness:0,side:THREE.DoubleSide});}});
  status.textContent='模型已载入，正在准备材质与着色器…';
  await Promise.all(stages.map(s=>s.renderer.compileAsync(s.scene,s.camera)));
  const gl=right.renderer.backend.gl,debug=gl.getExtension('WEBGL_debug_renderer_info');
  const environment={renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'unknown',loadMs:performance.now()-loadStarted};
  const duration=data.duration;$('timeline').max=duration;
  function render() {
    const start=performance.now();clip.sample(time);clip.applyToGLTF(source);retarget.apply();
    for(const s of stages)s.renderer.render(s.scene,s.camera);
    lastStepMs=performance.now()-start;frame++;
    $('timeline').value=time;$('time').textContent=`${time.toFixed(2)} / ${duration.toFixed(2)} s`;
  }
  function snapshot() {return {ready,playing,time,duration,frame,lastStepMs,view,environment,sourceName:data.name,sourceFrames:data.frameCount,sourceBones:data.bones.length,target:retarget.snapshot()};}
  function pause(value){playing=!value;$('play').textContent=playing?'暂停':'播放';last=performance.now();}
  function seek(t){time=Math.max(0,Math.min(duration,Number(t)));render();return snapshot();}
  function setView(v){
    if(!['front','angle','side','back'].includes(v))throw Error('Unknown view');
    view=v;for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===v));
    cameraView();render();
  }
  $('play').onclick=()=>pause(playing);$('restart').onclick=()=>{time=0;pause(false);};
  $('timeline').oninput=()=>{pause(true);seek($('timeline').value);};$('speed').onchange=()=>{speed=Number($('speed').value);};
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>setView(button.dataset.view);
  ready=true;for(const id of ['play','restart','timeline'])$(id).disabled=false;
  status.textContent=`已加载 ${data.name} · ${data.frameCount} 帧 · ${data.bones.length} 原骨骼 → ${retarget.mapping.length} 映射骨骼。两侧共用时间轴。`;
  $('diagnostics').textContent=JSON.stringify({clip:data.name,sourceAsset:data.sourceAsset,sourceArchive:data.sourceArchive,duration,frames:data.frameCount,sourceBoneCount:data.bones.length,mappedBoneCount:retarget.mapping.length,scale:retarget.scale,ik:false,physics:false,comparison:'Native skeletal replay; not an in-game recording'},null,2);
  window.nativeMotion={snapshot,pause,seek,setView,source,mesh,clip,retarget};
  render();last=performance.now();
  function loop(now){const dt=Math.max(0,Math.min(.1,(now-last)/1000));last=now;if(playing){time=(time+dt*speed)%duration;render();}requestAnimationFrame(loop);}
  requestAnimationFrame(loop);
}catch(error){status.textContent='加载失败：'+error.message;status.style.color='#a34436';console.error(error);window.nativeMotionError=error.message;}
