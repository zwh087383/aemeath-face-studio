import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {MMDLoader,MMDAnimationHelper} from '@takahirox/three-mmd';
const $=id=>document.getElementById(id), audio=$('audio'), stage=$('stage');
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
let mesh,helper,renderer,camera,scene,data,waveform,ready=false,mode='a2f',mood='neutral',closeup=false,capturing=false;
let previous=performance.now(),elapsed=0,frameCounter=0,statsAt=0;
const boneBases=new Map(), morphs=new Float32Array(199), channelIndex=new Map();
const metrics=[['jawOpen','张口'],['mouthClose','合唇'],['mouthFunnel','圆口'],['mouthPucker','噘嘴'],['mouthStretchLeft','横向拉伸']];
for(const [name,label] of metrics){const row=document.createElement('div');row.className='metric';row.innerHTML=`<span>${label}</span><span class="track"><i id="bar-${name}"></i></span><output id="val-${name}">0.00</output>`;$('metrics').append(row);}
function select(group,attribute,value){for(const b of $(group).querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset[attribute]===value));}
$('modes').onclick=e=>{const b=e.target.closest('button');if(b){mode=b.dataset.mode;select('modes','mode',mode);$('mode-label').textContent=mode==='a2f'?'让声音，成为表情。':'先听，再看嘴唇。';}};
$('moods').onclick=e=>{const b=e.target.closest('button');if(b){mood=b.dataset.mood;select('moods','mood',mood);}};
$('gain').oninput=()=>{$('gain-value').value=$('gain').value+'%';};
$('offset').oninput=()=>{$('offset-value').value=$('offset').value+' ms';};
$('play').onclick=async()=>{if(audio.paused){try{await audio.play();}catch(e){$('status').textContent=e.message;}}else audio.pause();};
$('restart').onclick=async()=>{audio.currentTime=0;await audio.play();};
audio.onplay=()=>{$('play').textContent='暂停播放';};
audio.onpause=()=>{$('play').textContent='播放中文语音';};
$('seek').oninput=()=>{audio.currentTime=Number($('seek').value);};
$('view').onclick=()=>{closeup=!closeup;$('view').textContent=closeup?'半身视角':'脸部特写';resize();};
function resize(){if(!renderer)return;const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h);const span=closeup?4.8:7.2,aspect=w/h;camera.left=-span*aspect/2;camera.right=span*aspect/2;camera.top=span/2;camera.bottom=-span/2;const y=closeup?17.9:17.4;camera.position.set(0,y,30);camera.lookAt(0,y,0);camera.updateProjectionMatrix();}
function valuesAt(time){
  const f=clamp(time*data.fps,0,data.frames.length-1),left=Math.floor(f),right=Math.min(left+1,data.frames.length-1),ratio=f-left;
  return data.frames[left].weights.map((v,i)=>v+(data.frames[right].weights[i]-v)*ratio);
}
function rmsAt(time){return waveform.rms[Math.min(waveform.rms.length-1,Math.max(0,Math.floor(time/waveform.step_seconds)))]||0;}
function retarget(time){
  const values=valuesAt(time),get=name=>clamp(values[channelIndex.get(name)]||0),gain=Number($('gain').value)/100;
  morphs.fill(0);
  const energy=rmsAt(time),speechGate=clamp((energy-.001)/.006);
  if(time>=0 && time<data.audio_seconds){
    if(mode==='volume'){morphs[52]=clamp(Math.sqrt(energy)*1.7*gain,0,.72);}
    else {
      const opening=clamp(get('jawOpen')-.75*get('mouthClose'))*gain*1.55*speechGate;
      const round=clamp(get('mouthFunnel')*1.8+get('mouthPucker')*1.3);
      const stretch=(get('mouthStretchLeft')+get('mouthStretchRight'))*.5;
      const seal=1-.9*clamp((get('mouthClose')-get('jawOpen'))*2);
      morphs[52]=opening*(1-round)*.88;
      morphs[53]=opening*stretch*.42;
      morphs[54]=get('mouthPucker')*.60*gain*speechGate*seal;
      morphs[55]=opening*stretch*.22;
      morphs[56]=(opening*round*.6+get('mouthFunnel')*.46*gain*speechGate)*seal;
      const sum=[52,53,54,55,56].reduce((s,i)=>s+morphs[i],0);
      if(sum>.72)for(const i of [52,53,54,55,56])morphs[i]*=.72/sum;
      morphs[63]=stretch*.13*gain*speechGate;
      morphs[70]=get('mouthPucker')*.12*gain*speechGate;
      morphs[61]=(get('mouthSmileLeft')+get('mouthSmileRight'))*.10*gain;
      morphs[62]=(get('mouthFrownLeft')+get('mouthFrownRight'))*.09*gain;
    }
  }
  if(mood==='smile'){morphs[6]=.16;morphs[41]=.12;morphs[61]+=.24;}
  if(mood==='focus'){morphs[0]=.3;morphs[3]=.09;morphs[34]=.13;}
  return values;
}
function pose(time,dt,still=false){
  const values=retarget(time),idle=$('idle').checked&&!still;
  if(idle){const phase=(elapsed+1.3)%4.8;morphs[23]=phase<.23?Math.pow(Math.sin(Math.PI*phase/.23),1.5):0;}
  for(let i=0;i<morphs.length;i++)mesh.morphTargetInfluences[i]=morphs[i];
  for(const [bone,base] of boneBases)bone.quaternion.copy(base);
  const bone=name=>mesh.skeleton.bones.find(b=>b.name===name);
  const left=bone('左腕'),right=bone('右腕'),head=bone('頭'),body=bone('上半身2');
  if(left)left.rotation.z=-.48;if(right)right.rotation.z=.48;
  if(head){head.rotation.z=(mood==='smile'?-.018:0)+(idle?.006*Math.sin(elapsed*.8):0);head.rotation.y=idle?.012*Math.sin(elapsed*.5):0;}
  if(body&&idle)body.rotation.x=.003*Math.sin(elapsed*1.7);
  helper.update(dt);mesh.updateMatrixWorld(true);return values;
}
function drawWave(time){const canvas=$('wave'),w=canvas.clientWidth,h=35;canvas.width=w*devicePixelRatio;canvas.height=h*devicePixelRatio;const ctx=canvas.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);const n=Math.floor(w/3);for(let i=0;i<n;i++){const sample=waveform.rms[Math.floor(i/n*waveform.rms.length)],bar=Math.max(2,Math.sqrt(sample)*h*1.6);ctx.fillStyle=i/n<time/data.audio_seconds?'#dcc0f4':'#756580';ctx.fillRect(i*3,(h-bar)/2,1.5,bar);}ctx.fillStyle='#f5e5ff';ctx.fillRect(clamp(time/data.audio_seconds)*w,0,1,h);}
function animate(now){requestAnimationFrame(animate);const dt=Math.min((now-previous)/1000,.05);previous=now;if(!ready||capturing)return;elapsed+=dt;const t=clamp(audio.currentTime+Number($('offset').value)/1000,0,data.audio_seconds);const values=pose(t,dt);renderer.render(scene,camera);$('seek').value=audio.currentTime;$('time').textContent=`${audio.currentTime.toFixed(2)} / ${data.audio_seconds.toFixed(2)} s`;drawWave(audio.currentTime);for(const [name]of metrics){const value=values[channelIndex.get(name)];$('bar-'+name).style.width=(value*100)+'%';$('val-'+name).value=value.toFixed(2);}frameCounter++;if(now-statsAt>500){$('status').textContent=`${audio.paused?'已暂停，可拖动检查':'语音与口型同步播放'} · ${Math.round(frameCounter*1000/(now-statsAt))} 帧/秒`;$('debug').textContent=`播放时间 ${audio.currentTime.toFixed(3)} s\n口型采样 ${t.toFixed(3)} s\n来源 ${mode} / 情绪 ${mood}\n`+[52,53,54,55,56,61,62,63,70].map(i=>`${i} ${mesh.geometry.morphTargets[i]?.name}: ${morphs[i].toFixed(4)}`).join('\n');statsAt=now;frameCounter=0;}}
$('sheet').onclick=async()=>{
  if(!ready)return;capturing=true;audio.pause();$('sheet').disabled=true;
  const oldClose=closeup;closeup=true;resize();
  try{
    const candidates=[['起始静止',0],['张口','jawOpen'],['圆口','mouthFunnel'],['噘嘴','mouthPucker'],['合唇','mouthClose'],['横向展开','mouthStretchLeft']];
    renderer.setSize(554,435,false);
    const span=3.65,aspect=554/435;
    camera.left=-span*aspect/2;camera.right=span*aspect/2;camera.top=span/2;camera.bottom=-span/2;
    camera.position.set(0,18.25,30);camera.lookAt(0,18.25,0);camera.updateProjectionMatrix();
    const sheet=document.createElement('canvas');sheet.width=1800;sheet.height=1200;const ctx=sheet.getContext('2d');
    ctx.fillStyle='#191421';ctx.fillRect(0,0,1800,1200);ctx.fillStyle='#f0e7f8';ctx.font='500 33px Microsoft YaHei';ctx.fillText('爱弥斯 · 中文语音口型试验',45,58);ctx.font='15px Microsoft YaHei';ctx.fillStyle='#ae9cbe';ctx.fillText('真实 Audio2Face 推理 → PMX 口型映射 / 同一段 14.935 秒中文语音 / 时间为音频播放位置',45,92);
    for(let index=0;index<candidates.length;index++){
      const [label,key]=candidates[index];const t=typeof key==='number'?key:data.frames.reduce((best,f)=>f.weights[channelIndex.get(key)]>best.weights[channelIndex.get(key)]?f:best).time;
      pose(t,0,true);renderer.render(scene,camera);await new Promise(requestAnimationFrame);renderer.render(scene,camera);
      const x=45+index%3*578,y=120+Math.floor(index/3)*500,w=554,h=435,source=renderer.domElement;
      ctx.fillStyle='#45374e';ctx.fillRect(x,y,w,h);const sw=source.height*w/h;ctx.drawImage(source,(source.width-sw)/2,0,sw,source.height,x,y,w,h);
      ctx.fillStyle='#eee2f6';ctx.font='22px Microsoft YaHei';ctx.fillText(label,x+10,y+h+31);ctx.fillStyle='#b69fc8';ctx.font='14px Microsoft YaHei';ctx.fillText(t.toFixed(3)+' s',x+w-87,y+h+29);
    }
    ctx.fillStyle='#a995bc';ctx.font='14px Microsoft YaHei';ctx.fillText('角色映射为初步调校；表情与口型可单独调整。此图验证实际模型渲染，动态同步请打开本地预览。',45,1165);
    const blob=await new Promise(resolve=>sheet.toBlob(resolve,'image/png'));
    const response=await fetch('/save-contact-sheet',{method:'POST',headers:{'Content-Type':'image/png'},body:blob});if(!response.ok)throw new Error('保存失败 '+response.status);
    $('sheet-note').textContent='已保存到 face / outputs / preview-contact-sheet.png';
  }catch(error){$('sheet-note').textContent=error.message;console.error(error);}finally{closeup=oldClose;resize();capturing=false;$('sheet').disabled=false;}
};
try{
  [data,waveform]=await Promise.all([fetch('/data/chinese-probe.json').then(r=>r.json()),fetch('/data/waveform.json').then(r=>r.json())]);
  data.blendshape_names.forEach((name,i)=>channelIndex.set(name,i));$('seek').max=data.audio_seconds;$('inference').textContent=data.inference_seconds.toFixed(2)+' s';
  scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,150);
  renderer=new WebGPURenderer({antialias:true,alpha:true,forceWebGL:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x000000,0);await renderer.init();stage.prepend(renderer.domElement);renderer.toneMapping=THREE.NeutralToneMapping;resize();new ResizeObserver(resize).observe(stage);
  scene.add(new THREE.AmbientLight(0xffffff,1.15));const key=new THREE.DirectionalLight(0xfff2ed,1.4);key.position.set(-3,8,10);scene.add(key);const fill=new THREE.DirectionalLight(0xd3d9ff,.25);fill.position.set(7,4,5);scene.add(fill);
  const manager=new THREE.LoadingManager();manager.onProgress=(url,loaded,total)=>{$('load-note').textContent=`读取贴图 ${loaded} / ${total}`;};manager.onError=url=>{$('status').textContent='资源加载失败：'+url;};
  mesh=await new MMDLoader(manager).loadAsync('/model/'+encodeURIComponent('鸣潮_爱弥斯1.05.pmx'));
  helper=new MMDAnimationHelper();helper.add(mesh,{physics:false});helper.enable('ik',false);
  for(const bone of mesh.skeleton.bones)boneBases.set(bone,bone.quaternion.clone());mesh.frustumCulled=false;scene.add(mesh);$('load-note').textContent='正在准备材质…';await renderer.compileAsync(scene,camera);
  ready=true;pose(0,0,true);renderer.render(scene,camera);$('loading').style.display='none';for(const id of ['play','restart','sheet'])$(id).disabled=false;statsAt=performance.now();requestAnimationFrame(animate);
}catch(error){console.error(error);$('load-note').textContent=error.message;$('status').textContent='加载失败：'+error.message;}
