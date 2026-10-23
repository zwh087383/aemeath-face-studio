import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MMDLoader} from '@takahirox/three-mmd';
import {NativeClip, NativeRetarget} from '/preview/core/native-motion.js';
import {NativeResourceLayer} from '/preview/core/native-resource-layer.js';
import {NativeExpression, NativeExpressionBinding} from '/preview/core/native-expression.js';
import {findNativeRibbonCompanion} from '/preview/core/native-companion.js';

const $ = id => document.getElementById(id);
const base = '/native-resources-data';
const kinds = [
  ['body','身体动作'],['expression','表情'],['look','注视'],['ribbon','衣发伴随'],
  ['prop','道具'],['mouth','台词口型'],['default-face','默认面部'],['material','材质'],
];
const pageSize = 40, cache = new Map(), resourceCache = new Map(), stages = [];
let entries = [], clips = [], resources = [], filtered = [], kind = 'body', query = '', category = '', page = 0;
let source, mesh, sourceRest, targetRest, current = null, selected = null, selectedData = null;
let layers = new Map(), faceLayers = new Map(), faceBinding = null, faceResult = null, prop = null, propGroup = null, propDescriptor = null, propAnimation = null;
let ready = false, modelsReady = false, loading = false, playing = true, error = null;
let pendingId = null, requestSequence = 0, controller, time = 0, cycleOffset = 0, speed = 1, view = 'front', last = performance.now();
let frame = 0, lastStepMs = 0, environment = null, inspection = null, manifest = null;

function message(text, css = '') {$('status').textContent = text;$('status').className = css;}
const resourceKind = entry => entry.resourceKind || entry.kind || 'body';
const tabKind = entry => /^(prop-model|prop-animation)$/.test(resourceKind(entry)) ? 'prop' : resourceKind(entry) === 'look-config' ? 'look' : resourceKind(entry);
const isClip = entry => entry._clip;
function nameOf(entry) {return entry?.name || entry?.id || '未选择';}
const stateLabel = entry => ({ready:'可预览',decoded:'已解析',archived:'仅归档',failed:'提取失败'}[entry?.status] || entry?.status || '待核实');
function capturePose(root) {
  const rows = [];root.updateMatrixWorld(true);
  root.traverse(node => {if (node.isBone) rows.push({node,p:node.position.clone(),q:node.quaternion.clone(),s:node.scale.clone(),wq:node.getWorldQuaternion(new THREE.Quaternion())});});
  return rows;
}
function restorePose(rows, root) {
  for (const {node,p,q,s} of rows) {node.position.copy(p);node.quaternion.copy(q);node.scale.copy(s);}
  root.updateMatrixWorld(true);root.traverse(node => {if (node.isSkinnedMesh) node.skeleton.update();});
}
function duration() {
  if(prop)return Number(propAnimation?.data.duration||0);
  const type=selected&&resourceKind(selected);
  if(type&&faceLayers.get(type)?.descriptor.id===selected.id)return faceLayers.get(type).expression.duration;
  if(selected&&isClip(selected)&&type!=='body'&&layers.get(type)?.descriptor.id===selected.id)return Number(layers.get(type).clip.data.duration||0);
  return Number(current?.clip.data.duration||0);
}
function clipTime(clip,descriptor) {const length=Number(clip.data.duration||0),clock=time+cycleOffset;return descriptor.loop&&length>0?clock%length:Math.min(clock,length);}

async function stage(id) {
  const host = $(id), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35,1,.1,150);
  scene.background = new THREE.Color('#e6e8e0');
  const renderer = new WebGPURenderer({antialias:true,forceWebGL:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.35));await renderer.init();
  renderer.outputColorSpace = THREE.SRGBColorSpace;renderer.toneMapping = THREE.NeutralToneMapping;host.append(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff,1.35));
  for (const [color,intensity,position] of [[0xfff5e5,2,[-12,28,20]],[0xc7e0fa,1,[15,15,-8]]]) {const light = new THREE.DirectionalLight(color,intensity);light.position.set(...position);scene.add(light);}
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400,400),new THREE.MeshStandardMaterial({color:'#d8dfd0',roughness:1}));
  floor.rotation.x = -Math.PI/2;floor.position.y = -.05;scene.add(floor);
  const grid = new THREE.GridHelper(400,200,'#a7b3a3','#c5cebd');grid.position.y = -.02;scene.add(grid);
  const row = {id,scene,camera,renderer,focus:new THREE.Vector3(0,9,0)};stages.push(row);
  let drag=null;
  renderer.domElement.addEventListener('pointerdown',event=>{if(!prop||id!=='source-stage')return;drag={x:event.clientX,yaw:propGroup.rotation.y};renderer.domElement.setPointerCapture(event.pointerId);});
  renderer.domElement.addEventListener('pointermove',event=>{if(!drag||!prop)return;propGroup.rotation.y=drag.yaw+(event.clientX-drag.x)*.01;render();});
  renderer.domElement.addEventListener('pointerup',()=>{drag=null;});renderer.domElement.addEventListener('pointercancel',()=>{drag=null;});
  new ResizeObserver(() => {const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();cameraView();if (modelsReady) render();}).observe(host);
  return row;
}
function cameraView() {
  const yaw = {front:0,angle:.65,side:Math.PI/2,back:Math.PI,face:0}[view];
  for (const row of stages) {
    const {camera,focus} = row;focus.set(0,9,0);
    if (!prop && current && $('follow').checked) {
      const {clip,retarget} = current, pelvis = clip.world[retarget.pelvis], restPelvis=clip.restWorld[retarget.pelvis];
      const headIndex=clip.indices.get('Bip001Head');let heightDelta=0;
      if (row.id==='source-stage') {focus.x=(pelvis.p.x-restPelvis.p.x)*retarget.scale;focus.z=(pelvis.p.z-restPelvis.p.z)*retarget.scale;heightDelta=((pelvis.p.y+clip.world[headIndex].p.y)-(restPelvis.p.y+clip.restWorld[headIndex].p.y))*retarget.scale/2;}
      else {const waist=retarget.bones.get('腰').getWorldPosition(new THREE.Vector3()),head=retarget.bones.get('頭').getWorldPosition(new THREE.Vector3());const restWaist=retarget.rest.get('腰').wp,restHead=retarget.rest.get('頭').wp;focus.x=waist.x-restWaist.x;focus.z=waist.z-restWaist.z;heightDelta=((waist.y+head.y)-(restWaist.y+restHead.y))/2;}
      focus.y+=Math.max(-7,Math.min(0,heightDelta*.55));
    }
    if(view==='face'&&!prop&&current) {
      if(row.id==='source-stage')focus.copy(current.clip.world[current.clip.indices.get('Bip001Head')].p).multiplyScalar(current.retarget.scale);
      else current.retarget.bones.get('頭').getWorldPosition(focus);
      focus.y+=.5;
    }
    const distance=(prop?28:view==='face'?9:36)*Math.max(1,.8/camera.aspect),angle=prop&&view==='front'?.45:yaw;camera.position.set(focus.x+Math.sin(angle)*distance,focus.y+(prop?18:view==='face'?.4:4.2),focus.z+Math.cos(angle)*distance);camera.lookAt(focus);
  }
}
function render() {
  const begin=performance.now();
  if (prop && propAnimation) {propAnimation.sample(time);propAnimation.applyToGLTF(prop);}
  else if (!prop) {
    if (current) {current.clip.sample(clipTime(current.clip,current.descriptor));current.clip.applyToGLTF(source);current.retarget.apply();}
    else if (source && mesh) {restorePose(sourceRest,source);restorePose(targetRest,mesh);}
    for (const row of layers.values()) {const at=clipTime(row.clip,row.descriptor);row.native.apply(at);row.target.apply(at);}
    if(faceBinding && faceLayers.size) {
      const weights={};
      for(const type of ['default-face','expression','mouth']) {const row=faceLayers.get(type);if(row)Object.assign(weights,row.expression.sample(time+cycleOffset,{loop:Boolean(row.descriptor.loop)}));}
      faceResult=faceBinding.apply(mesh,weights);
    }else if(faceBinding){faceBinding.clear(mesh);faceResult=null;}
  }
  cameraView();for (const row of stages) {if (prop && row.id==='target-stage') continue;row.renderer.render(row.scene,row.camera);}
  lastStepMs=performance.now()-begin;frame++;$('timeline').max=String(Math.max(.001,duration()));$('timeline').value=String(time);$('time').textContent=`${time.toFixed(2)} / ${duration().toFixed(2)} s`;
}
function updateLayers() {
  $('body-layer').textContent='身体：'+nameOf(current?.descriptor);
  for (const name of ['look','ribbon']) $(''+name+'-layer').textContent=(name==='look'?'注视：':'衣发：')+(layers.has(name)?nameOf(layers.get(name).descriptor)+(layers.get(name).automatic?'（自动配套）':''):'关闭');
  $('face-layer').textContent='面部：'+([...faceLayers.values()].map(row=>nameOf(row.descriptor)).join(' + ')||'关闭');
}
function updateControls() {
  const playable=modelsReady && duration()>0;
  for (const id of ['play','restart','timeline']) $(id).disabled=!playable || loading;
  $('next').disabled=loading || !modelsReady || filtered.length<2;
  $('page-prev').disabled=page===0;$('page-next').disabled=(page+1)*pageSize>=filtered.length;
  $('prop-spin-label').hidden=!prop;
}
function setView(value) {if (!['front','angle','side','back','face'].includes(value)) throw Error('Unknown view');view=value;for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed',String(button.dataset.view===value));cameraView();if(modelsReady)render();return snapshot();}
function setFollow(value) {$('follow').checked=Boolean(value);if(modelsReady)render();return snapshot();}
function pause(value=true) {playing=!value;$('play').textContent=playing?'暂停':'播放';last=performance.now();return snapshot();}
function seek(value) {const number=Number(value);if(!Number.isFinite(number))throw Error('Invalid playback time');time=Math.max(0,Math.min(duration(),number));cycleOffset=0;if(modelsReady)render();last=performance.now();return snapshot();}
function snapshot() {
  return {ready,modelsReady,loading,playing,time,cycleOffset,playbackClock:time+cycleOffset,duration:duration(),frame,lastStepMs,view,speed,environment,pendingId,error,selectedId:selected?.id??null,currentId:current?.descriptor.id??null,resourceKind:selected?resourceKind(selected):null,kind,query,category,page,pageSize,total:entries.length,filteredCount:filtered.length,pageIds:filtered.slice(page*pageSize,(page+1)*pageSize).map(row=>row.id),filteredIds:filtered.map(row=>row.id),cacheIds:[...cache.keys()],resourceCacheIds:[...resourceCache.keys()],clips:clips.map(({id,name,resourceKind,category,duration,loop,status})=>({id,name,resourceKind,category,duration,loop,status})),resources:resources.map(({id,name,kind,status})=>({id,name,kind,status})),layers:[...layers].map(([kind,row])=>({kind,id:row.descriptor.id,automatic:Boolean(row.automatic),native:row.native.snapshot(),target:row.target.snapshot()})),faceLayers:[...faceLayers].map(([kind,row])=>({kind,id:row.descriptor.id,duration:row.expression.duration,curves:row.expression.data.curves.length})),faceResult,inspection,prop:prop?{id:propDescriptor.id,rotation:propGroup.rotation.y,bounds:new THREE.Box3().setFromObject(prop).getSize(new THREE.Vector3()).toArray()}:null,target:current?.retarget.snapshot()??null};
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const [value,label] of kinds) {const count=entries.filter(row=>tabKind(row)===value).length;const button=document.createElement('button');button.textContent=`${label} · ${count}`;button.dataset.kind=value;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(kind===value));button.onclick=()=>setKind(value);$('tabs').append(button);}
}
function renderCategories() {
  const rows=entries.filter(row=>tabKind(row)===kind), values=[...new Set(rows.map(row=>row.category).filter(Boolean))];$('categories').replaceChildren();
  if(values.length<2)return;
  for(const value of ['',...values]) {const button=document.createElement('button');button.textContent=value||'全部';button.setAttribute('aria-pressed',String(value===category));button.onclick=()=>{category=value;page=0;renderCategories();renderList();};$('categories').append(button);}
}
function renderList() {
  const normalized=query.trim().toLocaleLowerCase();
  filtered=entries.filter(row=>tabKind(row)===kind && (!category||row.category===category) && (!normalized||[row.name,row.id,row.category,row.sourceAsset,row.status].some(value=>String(value??'').toLocaleLowerCase().includes(normalized))));
  page=Math.min(page,Math.max(0,Math.ceil(filtered.length/pageSize)-1));
  $('list-summary').textContent=`${filtered.length} 项 · 每页 ${pageSize} 项 · 详情按需读取`;
  $('page-label').textContent=`${page+1} / ${Math.max(1,Math.ceil(filtered.length/pageSize))}`;
  const list=$('resource-list');list.replaceChildren();
  if (!filtered.length) {const empty=document.createElement('span');empty.className='empty';empty.textContent='没有匹配的资源。';list.append(empty);}
  for (const entry of filtered.slice(page*pageSize,(page+1)*pageSize)) {
    const button=document.createElement('button');button.className='resource-entry';button.dataset.resourceId=entry.id;button.dataset.status=entry.status||'unknown';button.setAttribute('aria-pressed',String(selected?.id===entry.id));if(pendingId===entry.id)button.classList.add('pending');
    const title=document.createElement('span');title.className='resource-title';title.textContent=nameOf(entry);
    const meta=document.createElement('span');meta.className='resource-meta';meta.textContent=isClip(entry)?`${entry.category||resourceKind(entry)} · ${Number(entry.duration||0).toFixed(2)} s · ${entry.loop?'循环':'单次'} · ${stateLabel(entry)}`:`${entry.category||resourceKind(entry)} · ${stateLabel(entry)}`;
    button.append(title,meta);button.onclick=()=>void select(entry.id);list.append(button);
  }
  updateControls();
}
function setKind(value) {if(!kinds.some(([id])=>id===value))throw Error('Unknown resource tab');kind=value;category='';query='';page=0;$('search').value='';renderTabs();renderCategories();renderList();return snapshot();}
async function fetchData(url,signal,store,key) {
  if(store.has(key)){const value=store.get(key);store.delete(key);store.set(key,value);return value;}
  const response=await fetch(url,{signal});if(!response.ok)throw Error(`资源读取失败（HTTP ${response.status}）`);const value=await response.json();if(signal.aborted)throw new DOMException('Superseded resource','AbortError');store.set(key,value);while(store.size>3)store.delete(store.keys().next().value);return value;
}
function safeURL(candidate, fallback) {
  if(!candidate)return fallback;const url=new URL(candidate,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith(base+'/'))throw Error('Resource URL is outside the reviewed aliases');return url.pathname+url.search;
}
function hideProp() {if(!prop)return;stages[0].scene.remove(propGroup);disposeObject(prop);propGroup=null;prop=null;propDescriptor=null;propAnimation=null;source.visible=true;mesh.visible=true;$('target-section').hidden=false;$('comparison').classList.remove('prop');$('source-label').textContent='01 / 游戏资源原骨架';$('source-subtitle').textContent='原生数据重放，非游戏录屏';updateControls();}
function disposeObject(object) {const textures=new Set();object.traverse(node=>{if(!node.isMesh)return;node.geometry?.dispose();for(const material of Array.isArray(node.material)?node.material:[node.material]){for(const value of Object.values(material||{}))if(value?.isTexture)textures.add(value);material?.dispose();}});for(const texture of textures)texture.dispose();}
async function displayProp(descriptor,signal) {
  const url=safeURL(descriptor.modelUrl,`${base}/models/${encodeURIComponent(descriptor.id)}.glb`);
  const response=await fetch(url,{signal});if(!response.ok)throw Error(`道具模型尚未导出（HTTP ${response.status}）`);
  const bytes=await response.arrayBuffer();if(signal.aborted)throw new DOMException('Superseded resource','AbortError');
  const result=await new GLTFLoader().parseAsync(bytes,new URL('.',location.origin+url).href);if(signal.aborted){disposeObject(result.scene);throw new DOMException('Superseded resource','AbortError');}
  hideProp();prop=result.scene;propDescriptor=descriptor;propGroup=new THREE.Group();propGroup.add(prop);stages[0].scene.add(propGroup);
  prop.traverse(node=>{if(node.isMesh){node.frustumCulled=false;for(const material of Array.isArray(node.material)?node.material:[node.material])material?.dispose();node.material=new THREE.MeshStandardMaterial({color:'#879d91',roughness:.7,side:THREE.DoubleSide});}});
  const box=new THREE.Box3().setFromObject(prop),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());const maximum=Math.max(size.x,size.y,size.z);
  if(!(maximum>0)||!Number.isFinite(maximum)){disposeObject(prop);hideProp();throw Error('道具包围盒为空或无效');}
  const scale=14/maximum;prop.scale.multiplyScalar(scale);prop.position.sub(center.multiplyScalar(scale));prop.position.y+=9;prop.updateMatrixWorld(true);
  source.visible=false;mesh.visible=false;$('target-section').hidden=true;$('comparison').classList.add('prop');$('source-label').textContent='道具 / 原生网格';$('source-subtitle').textContent='独立灰模 · 自动取景 · 原生单位已记录';time=0;cycleOffset=0;cameraView();updateControls();
  return {modelUrl:url,originalSize:size.toArray(),displayScale:scale,note:'独立道具预览，尚未恢复游戏中的挂接点、材质或物理。'};
}

function analyzeData(data) {
  let objects=0,numbers=0,strings=0,arrays=0,depthLimit=false;const curves=[];
  function walk(value,path='',depth=0) {
    if(depth>12){depthLimit=true;return;}
    if(typeof value==='number'){numbers++;return;}if(typeof value==='string'){strings++;return;}if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){arrays++;if(value.length>20000){depthLimit=true;return;}for(let i=0;i<value.length;i++)walk(value[i],path+'['+i+']',depth+1);return;}
    objects++;
    if(Array.isArray(value.keys)&&value.keys.length>0&&value.keys.some(key=>Number.isFinite(Number(key?.time??key?.Time))&&Number.isFinite(Number(key?.value??key?.Value)))) {
      const keys=value.keys.map(key=>({time:Number(key.time??key.Time),value:Number(key.value??key.Value)})).filter(key=>Number.isFinite(key.time)&&Number.isFinite(key.value));
      curves.push({name:String(value.name??value.Name??path),count:keys.length,min:Math.min(...keys.map(key=>key.value)),max:Math.max(...keys.map(key=>key.value)),keys});
    }
    for(const [key,val] of Object.entries(value))walk(val,path?path+'.'+key:key,depth+1);
  }
  walk(data);return {objects,numbers,strings,arrays,depthLimit,curves};
}
function displayInspection(descriptor,data) {
  const result=analyzeData(data);inspection={id:descriptor.id,kind:resourceKind(descriptor),status:descriptor.status??data.status??'已提取',numericValues:result.numbers,curves:result.curves.map(({name,count,min,max})=>({name,count,min,max})),limited:result.depthLimit};
  $('resource-inspector').hidden=false;$('data-overview').replaceChildren();
  const notes=data.error??descriptor.error??data.notes??descriptor.notes??data.note??'';
  for(const [label,value] of [['状态',inspection.status],['实际数据',`${result.numbers} 个数值 / ${result.arrays} 个数组`],['已识别曲线',`${result.curves.length} 条`]]) {const cell=document.createElement('div'),title=document.createElement('b');title.textContent=label;cell.append(title,document.createTextNode(String(value)));$('data-overview').append(cell);}
  $('inspector-notes').textContent=(Array.isArray(notes)?notes.join('；'):String(notes))+(result.depthLimit?' · 概览扫描限制深度；原始数据仍可查看。':'');
  $('curve-view').replaceChildren();
  const visible=result.curves.slice(0,12),colors=['#315e4d','#bc7659','#5973b1','#9e849c','#9c992b','#508b99'];
  if(visible.length) {
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 800 140');svg.setAttribute('role','img');svg.setAttribute('aria-label','原生曲线采样概览');
    const all=visible.flatMap(curve=>curve.keys),minT=Math.min(...all.map(key=>key.time)),maxT=Math.max(...all.map(key=>key.time)),minV=Math.min(...all.map(key=>key.value)),maxV=Math.max(...all.map(key=>key.value));
    for(const [index,curve] of visible.entries()) {const poly=document.createElementNS(ns,'polyline');poly.setAttribute('fill','none');poly.setAttribute('stroke',colors[index%colors.length]);poly.setAttribute('stroke-width','1.4');const step=Math.max(1,Math.ceil(curve.keys.length/500));poly.setAttribute('points',curve.keys.filter((_,i)=>i%step===0).map(key=>`${12+(key.time-minT)/Math.max(.001,maxT-minT)*776},${126-(key.value-minV)/Math.max(.001,maxV-minV)*112}`).join(' '));svg.append(poly);}
    $('curve-view').append(svg);const label=document.createElement('div');label.className='curve-label';label.textContent=`${minT.toFixed(3)}–${maxT.toFixed(3)} s；数值 ${minV.toFixed(3)}–${maxV.toFixed(3)}。前 ${visible.length} 条：`+visible.map(curve=>curve.name).join('、');$('curve-view').append(label);
  }else {const label=document.createElement('p');label.textContent='此数据中未发现 time/value 关键帧曲线。可展开下方数据查看已解析的实际参数。';$('curve-view').append(label);}
  const files=descriptor.convertedFiles??[];$('converted-files').replaceChildren();
  for(const [index,file] of files.entries()) {const path=typeof file==='string'?file:(file.path??file.name??''),url=`${base}/converted/${encodeURIComponent(descriptor.id)}/${index}`,link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.textContent=String(path).split(/[\\/]/).at(-1)||`导出文件 ${index+1}`;if(/\.(png|jpe?g|webp)$/i.test(path)){const img=document.createElement('img');img.loading='lazy';img.src=url;img.alt=link.textContent;link.prepend(img);}else link.className='converted-link';$('converted-files').append(link);}
  const json=JSON.stringify(data,null,2),limit=150000;$('diagnostics').textContent=json.length>limit?json.slice(0,limit)+'\n…显示已截断；完整数据保留在本地资源文件。':json;
  return inspection;
}

function makeLayer(clip,descriptor,automatic=false){
  const kind=resourceKind(descriptor),composition=kind==='ribbon'?'replace':'additive';
  return {descriptor,clip,automatic,
    native:new NativeResourceLayer(clip,source,{kind,native:true,bindPose:sourceRest,composition}),
    target:new NativeResourceLayer(clip,mesh,{kind,native:false,bindPose:targetRest,composition})};
}
async function select(id) {
  if(!modelsReady)throw Error('两套模型尚未准备好');
  const descriptor=entries.find(entry=>entry.id===id);if(!descriptor)throw Error('Unknown resource '+id);
  const sequence=++requestSequence;controller?.abort();controller=new AbortController();const signal=controller.signal;
  const previousPlaying=playing;loading=true;pendingId=id;error=null;renderList();message('正在按需载入 '+nameOf(descriptor)+'…','loading');
  try {
    let summary;
    if((isClip(descriptor)&&descriptor.status!=='ready')||(!isClip(descriptor)&&!descriptor.file&&!descriptor.fileUrl&&!descriptor.url)) {
      selected=descriptor;selectedData={...descriptor,note:'此项当前只有归档或失败记录；下面展示实际记录，继续保留已加载的表演。'};displayInspection(descriptor,selectedData);message(`${nameOf(descriptor)} · ${stateLabel(descriptor)} · ${descriptor.error||'当前没有可播放的数据。'}`,descriptor.status==='failed'?'error':'');
    }else if(isClip(descriptor)) {
      const type=resourceKind(descriptor),companion=type==='body'?findNativeRibbonCompanion(descriptor,clips):null;
      const [data,paired]=await Promise.all([
        fetchData(safeURL(descriptor.fileUrl??descriptor.url,`${base}/clips/${encodeURIComponent(id)}.json`),signal,cache,id),
        companion?fetchData(`${base}/clips/${encodeURIComponent(companion.id)}.json`,signal,cache,companion.id)
          .then(data=>({data})).catch(problem=>{if(signal.aborted)throw problem;return {error:problem.message};}):null,
      ]);
      if(sequence!==requestSequence)return snapshot();
      const clip=new NativeClip(data);
      if(type==='prop-animation'&&(descriptor.modelUrl||descriptor.propModelId)) {
        const modelId=descriptor.propModelId,model=modelId?entries.find(row=>row.id===modelId):null;
        await displayProp({...descriptor,modelUrl:descriptor.modelUrl??model?.modelUrl??`${base}/models/${encodeURIComponent(modelId)}.glb`},signal);
        if(sequence!==requestSequence)return snapshot();propAnimation=clip;
        summary={...descriptor,sourceAsset:data.sourceAsset,frames:data.frameCount,matchedPropBones:data.bones.filter(bone=>prop.getObjectByName(bone.name)?.isBone).length,comparison:'Original prop clip; independent mesh preview; character attachment not restored'};
      } else if(type==='body') {
        hideProp();
        restorePose(targetRest,mesh);restorePose(sourceRest,source);const retarget=new NativeRetarget(clip,mesh);source.scale.setScalar(retarget.scale*100);current={descriptor,clip,retarget};
        layers.delete('ribbon');
        if(paired?.data){try{layers.set('ribbon',makeLayer(new NativeClip(paired.data),companion,true));}catch(problem){paired.error=problem.message;cache.delete(companion.id);}}
        summary={...descriptor,sourceName:data.name,sourceAsset:data.sourceAsset,sourceArchive:data.sourceArchive,sourceSkeleton:data.sourceSkeleton,frames:data.frameCount,sourceBones:data.bones.length,mappedBones:retarget.mapping.length,nativeLongHairMapped:retarget.snapshot().nativeLongHairMapped,companion:companion?.id??null,companionError:paired?.error??null,comparison:'Native data replay; not an in-game recording'};
      } else {
        hideProp();
        const row=makeLayer(clip,descriptor),{native,target}=row;
        if(!native.rows.length&&!target.rows.length)throw Error('此资源没有可与角色骨架匹配的局部骨骼，请查看资源数据或道具挂接信息');
        layers.set(type,row);summary={...descriptor,sourceAsset:data.sourceAsset,frames:data.frameCount,nativeLayer:native.snapshot(),targetLayer:target.snapshot(),mapping:'Local-only review; unmatched bones are left untouched',notes:target.rows.length?'局部旋转适配为实验性，需要逐动作观察穿插。':'当前 PMX 没有同名骨骼；仅左侧原生骨架播放此层。'};
      }
      selectedData=data;selected=descriptor;inspection=null;$('resource-inspector').hidden=true;$('diagnostics').textContent=JSON.stringify(summary,null,2);time=0;cycleOffset=0;ready=true;pause(false);
      message(propAnimation?`已加载 ${nameOf(descriptor)} · ${data.frameCount} 帧 · 独立道具动画预览。`:type==='body'?`已加载 ${nameOf(descriptor)} · ${data.frameCount} 帧 · 两侧共用时间轴${layers.get('ribbon')?.automatic?' · 已自动配套原生衣发':''}${paired?.error?' · 配套衣发读取失败，可稍后重试':''}。`:`已叠加 ${nameOf(descriptor)} · 保留身体动作 · 原骨架 ${layers.get(type).native.rows.length} / PMX ${layers.get(type).target.rows.length} 个匹配骨骼。`);
    } else {
      const data=await fetchData(safeURL(descriptor.fileUrl??descriptor.url,`${base}/resources/${encodeURIComponent(id)}.json`),signal,resourceCache,id);
      if(sequence!==requestSequence)return snapshot();
      selected=descriptor;selectedData=data;displayInspection(descriptor,data);
      const modelUrl=descriptor.modelUrl??data.modelUrl;
      if(resourceKind(descriptor)==='prop-model'&&(modelUrl||descriptor.modelFile||data.modelFile)) {
        const result=await displayProp({...descriptor,modelUrl},signal);if(sequence!==requestSequence)return snapshot();
        $('inspector-notes').textContent+=' '+result.note;$('diagnostics').textContent=JSON.stringify({...data,display:result},null,2);pause(true);
      }else {
        hideProp();
        if(['expression','mouth','default-face'].includes(resourceKind(descriptor))) {
          const expression=new NativeExpression(data);
          faceLayers.delete(resourceKind(descriptor));
          if(expression.data.curves.length) {
            const weights=expression.sample(0),known=Object.keys(weights).filter(name=>faceBinding.resolve(name)),unknown=Object.keys(weights).filter(name=>!faceBinding.resolve(name));
            if(known.length){faceLayers.set(resourceKind(descriptor),{descriptor,expression});time=0;cycleOffset=0;pause(false);}
            const normalized=analyzeData(data).curves.length?data:{...data,playbackCurves:expression.data.curves};displayInspection(descriptor,normalized);inspection.morphs={mapped:known,unknown};
            $('inspector-notes').textContent+=` PMX 可映射 ${known.length} 个通道，未映射 ${unknown.length} 个通道；左侧灰模未导出面部 morph。`;
            if(!known.length)$('inspector-notes').textContent+=' 当前模型没有对应 morph，此项仅数据查看，同类旧表情已清除。';
            if(resourceKind(descriptor)==='mouth')$('inspector-notes').textContent+=' 此项是游戏静态台词口型，没有配套语音，不代表实时语音驱动。';
            if(known.length)setView('face');
          }else $('inspector-notes').textContent+=' 未解出可播放的浮点曲线；此项仅展示已解析参数，同类旧表情已清除。';
        }
      }
      message(`${nameOf(descriptor)} · ${stateLabel(descriptor)}${inspection?.morphs?` · 已映射 ${inspection.morphs.mapped.length} / ${inspection.morphs.mapped.length+inspection.morphs.unknown.length} 个通道${!inspection.morphs.mapped.length?'，仅数据查看':''}`:''} · 详情与曲线见下方。`);
    }
    if(sequence!==requestSequence)return snapshot();
    $('current-name').textContent=nameOf(descriptor);$('current-category').textContent=descriptor.category||resourceKind(descriptor);$('resource-status').textContent=isClip(descriptor)&&descriptor.status==='ready'?descriptor.loop?'循环片段':'单次片段':stateLabel(descriptor);
    const notes=descriptor.notes??'';$('resource-notes').textContent=Array.isArray(notes)?notes.join('；'):notes;
    loading=false;pendingId=null;updateLayers();renderList();render();return snapshot();
  }catch(problem) {
    if(sequence!==requestSequence)return snapshot();loading=false;pendingId=null;error=problem.message;pause(!previousPlaying);renderList();if(modelsReady)render();message(`读取失败：${problem.message}。保留已加载身体与局部层。`,'error');console.error(problem);return snapshot();
  }
}
async function next() {if(!filtered.length||loading)return snapshot();const rows=filtered.slice(page*pageSize,(page+1)*pageSize),index=rows.findIndex(row=>row.id===selected?.id);return select(rows[(index+1)%rows.length].id);}
function clearLayers() {const clock=time+cycleOffset;layers.clear();faceLayers.clear();faceBinding?.clear(mesh);faceResult=null;if(!prop&&current){const length=current.clip.data.duration;time=current.descriptor.loop&&length>0?clock%length:Math.min(clock,length);cycleOffset=0;}updateLayers();if(modelsReady)render();return snapshot();}
window.nativeResources={snapshot,pause,seek,select,setView,setFollow,setKind,next,clearLayers,get mesh(){return mesh;},get source(){return source;},get clip(){return current?.clip;},get retarget(){return current?.retarget;},get selectedData(){return selectedData;}};
$('search').oninput=()=>{query=$('search').value;page=0;renderList();};
$('page-prev').onclick=()=>{page=Math.max(0,page-1);renderList();};$('page-next').onclick=()=>{page++;renderList();};
$('play').onclick=()=>{if(!playing&&time>=duration()){time=0;cycleOffset=0;}pause(playing);render();};$('restart').onclick=()=>{time=0;cycleOffset=0;pause(false);render();};$('timeline').oninput=()=>{pause(true);seek($('timeline').value);};$('speed').onchange=()=>{speed=Number($('speed').value);last=performance.now();};$('next').onclick=()=>void next();$('follow').onchange=()=>setFollow($('follow').checked);$('clear-layers').onclick=clearLayers;
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>setView(button.dataset.view);
function loop(now) {
  const dt=Math.max(0,Math.min(.1,(now-last)/1000));last=now;
  if(modelsReady&&!loading) {
    if(prop&&$('prop-spin').checked)propGroup.rotation.y+=dt*.3;
    if(ready&&playing&&duration()>0){const total=duration(),advanced=time+dt*speed;const active=selected&&isClip(selected)?selected:current?.descriptor;
      if(advanced>=total){if($('sequence').checked&&filtered.length>1){time=total;render();void next();}else if(active?.loop){time=advanced%total;cycleOffset+=advanced-time;render();}else{time=total;pause(true);render();}}else{time=advanced;render();}
    }else if(prop&&$('prop-spin').checked)render();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
try {
  const response=await fetch(base+'/manifest.json');if(!response.ok)throw Error(`资源目录未准备好（HTTP ${response.status}）`);manifest=await response.json();if(manifest.schema!==1||!Array.isArray(manifest.clips))throw Error('不支持的目录格式');
  clips=manifest.clips.map(row=>({...row,resourceKind:row.resourceKind||'body',_clip:true}));resources=(manifest.resources??[]).map(row=>({...row,_clip:false}));entries=[...clips,...resources];
  if(new Set(entries.map(row=>row.id)).size!==entries.length)throw Error('资源目录存在重复 ID');
  $('library-summary').textContent=`${clips.filter(row=>row.status==='ready').length} / ${clips.length} 段动画可预览 · ${resources.length} 项配套资源 · 不含攻击动作 · 详情按需读取${manifest.complete===false?' · 批量提取进行中':''}`;
  renderTabs();renderCategories();renderList();message('目录已读取，正在准备两侧渲染器…','loading');
  const [left,right]=await Promise.all([stage('source-stage'),stage('target-stage')]);cameraView();message('正在读取原生网格、当前 PMX 与贴图…','loading');
  const [gltf,target]=await Promise.all([new GLTFLoader().loadAsync(base+'/source.glb'),new MMDLoader().loadAsync('/model/'+encodeURIComponent('鸣潮_爱弥斯1.05.pmx'))]);source=gltf.scene;mesh=target;mesh.frustumCulled=false;faceBinding=new NativeExpressionBinding(mesh);sourceRest=capturePose(source);targetRest=capturePose(mesh);left.scene.add(source);right.scene.add(mesh);
  source.traverse(node=>{if(node.isMesh){node.frustumCulled=false;node.material=new THREE.MeshStandardMaterial({color:'#889c8e',roughness:.72,metalness:0,side:THREE.DoubleSide});}});
  message('模型已读取，正在准备材质和着色器…','loading');await Promise.all(stages.map(row=>row.renderer.compileAsync(row.scene,row.camera)));
  const gl=right.renderer.backend.gl,debug=gl.getExtension('WEBGL_debug_renderer_info');environment={renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'unknown'};modelsReady=true;updateControls();
  const bodies=clips.filter(row=>resourceKind(row)==='body'&&row.status==='ready'),first=bodies.find(row=>/\/Stand2\.uasset$/i.test(row.sourceAsset))??bodies.find(row=>row.id==='aimisi-breath01')??bodies[0];if(first)await select(first.id);else{ready=true;message('模型已准备好，请选择资源。');render();}
}catch(problem){error=problem.message;message('页面准备失败：'+problem.message,'error');window.nativeResourcesError=problem.message;console.error(problem);}
