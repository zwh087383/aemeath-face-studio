import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {MMDLoader,MMDAnimationHelper} from '@takahirox/three-mmd';
const $=id=>document.getElementById(id);
const presets=[
 {name:'自然',en:'AT EASE',desc:'放松的眉眼，轻微呼吸和自然眨眼。',m:{},tilt:0},
 {name:'浅笑',en:'SOFT SMILE',desc:'先提起嘴角，再让眼尾轻轻收拢。',m:{6:.24,41:.28,61:.48},tilt:-.018},
 {name:'开心',en:'DELIGHT',desc:'弯起的眼睛与放松张开的笑口。',m:{6:.65,24:1.25,52:.42,61:.55},tilt:-.035},
 {name:'疑惑',en:'CURIOUS',desc:'眉毛微微拢起，眼神停顿，侧头等你解释。',m:{10:.7,21:.25,42:.22,56:.20,87:.3},tilt:.11},
 {name:'认真',en:'FOCUSED',desc:'眉眼收紧、嘴角稍收，保持克制的情绪。',m:{0:.6,3:.22,34:.4,62:.45,87:.5},tilt:.012},
 {name:'惊讶',en:'SURPRISED',desc:'抬眉、睁眼和小幅圆口，避免过度拉伸。',m:{14:.7,42:.7,49:.15,56:.6},tilt:0},
 {name:'害羞',en:'SHY',desc:'浅笑、略垂的眼神，加一点自然的脸红。',m:{10:.35,36:.3,38:.17,61:.38,114:.85},tilt:-.06},
 {name:'俏皮',en:'WINK',desc:'单侧闭眼配合笑容，另一只眼睛保持明亮。',m:{6:.5,25:1.25,61:.65,52:.16},tilt:-.07}
];
let mesh,helper,renderer,camera,scene,selected=0,closeup=true,ready=false,forcedBlink=-100,manualMouth=-1,clock=0,prev=performance.now(),frameCount=0,lastStats=0,capturing=false,currentTilt=0;
const stage=$('stage'),target=new Float32Array(199),weights=new Float32Array(199);
const baseBones=new Map();
const pmxName='鸣潮_爱弥斯1.05.pmx';
for(const [i,p] of presets.entries()) {const b=document.createElement('button');b.className='preset';b.innerHTML=`${p.name}<span>${p.en}</span>`;b.setAttribute('aria-pressed',String(i===0));b.onclick=()=>select(i);$('presets').append(b);}
function select(i){selected=i;manualMouth=-1;$('current').textContent=presets[i].name;$('number').textContent=String(i+1).padStart(2,'0');$('description').textContent=presets[i].desc;[...$('presets').children].forEach((b,j)=>b.setAttribute('aria-pressed',String(i===j)));$('blush').value=String(Math.round((presets[i].m[114]||0)*100));$('blush-value').value=$('blush').value+'%';}
$('strength').oninput=()=>{$('strength-value').value=$('strength').value+'%';};
$('blush').oninput=()=>{$('blush-value').value=$('blush').value+'%';};
$('reset').onclick=()=>{select(0);$('talk').checked=false;};
$('blink-once').onclick=()=>{forcedBlink=clock;};
$('mouths').onclick=e=>{const b=e.target.closest('button');if(b){manualMouth=Number(b.dataset.mouth);$('talk').checked=false;}};
$('frame').onclick=()=>{closeup=!closeup;$('frame').textContent=closeup?'半身视角':'脸部特写';resize();};
$('close-gallery').onclick=()=>{$('gallery').classList.remove('open');};
function resize(){if(!renderer)return;const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h);const aspect=w/h,view=closeup?4.9:8.5;camera.left=-view*aspect/2;camera.right=view*aspect/2;camera.top=view/2;camera.bottom=-view/2;camera.position.set(0,closeup?18.15:16.65,30);camera.lookAt(0,closeup?18.15:16.65,0);camera.updateProjectionMatrix();}
function blinkValue(t){if(t<0||t>.28)return 0;return Math.pow(Math.sin(Math.PI*t/.28),1.5);}
function calculate(t,staticPose=false){
 target.fill(0);const p=presets[selected],strength=Number($('strength').value)/100;
 for(const [index,value] of Object.entries(p.m))target[index]=Math.min(1,value*strength);
 target[114]=Number($('blush').value)/100*strength;
 if(!staticPose){
  const b=Math.max(blinkValue(t-forcedBlink),$('blink').checked?blinkValue((t+1.3)%4.8):0);
  const closed=Math.max(target[24],target[25]);target[23]=b*(1-closed);
  for(const i of [34,36,38,41,42,49])target[i]*=1-target[23];
  if($('talk').checked){const phase=t*3.3,i=Math.floor(phase)%5;for(let k=52;k<=56;k++)target[k]=0;target[52+i]=.25*Math.pow(Math.sin((phase%1)*Math.PI),2);}
  if(manualMouth>=0){for(let k=52;k<=56;k++)target[k]=0;target[manualMouth]=.4;}
 }
}
function apply(dt,t,immediate=false){
 const factor=immediate?1:1-Math.exp(-dt*12);
 for(let i=0;i<weights.length;i++){weights[i]+=(target[i]-weights[i])*(i===23?1:factor);mesh.morphTargetInfluences[i]=weights[i];}
 for(const [bone,q] of baseBones)bone.quaternion.copy(q);
 const idle=$('idle').checked&&!immediate;
 const head=mesh.skeleton.bones.find(b=>b.name==='頭');
 const upper=mesh.skeleton.bones.find(b=>b.name==='上半身2');
 mesh.skeleton.bones.find(b=>b.name==='左腕').rotation.z=-.48;
 mesh.skeleton.bones.find(b=>b.name==='右腕').rotation.z=.48;
 currentTilt+=(presets[selected].tilt*Number($('strength').value)/100-currentTilt)*factor;
 if(head){head.rotation.z=currentTilt+(idle?.008*Math.sin(t*.78):0);head.rotation.y=idle?.018*Math.sin(t*.48):0;}
 if(upper&&idle)upper.rotation.x=.003*Math.sin(t*1.7);
 helper.update(dt);
 mesh.updateMatrixWorld(true);
}
function render(){renderer.render(scene,camera);}
function animate(now){requestAnimationFrame(animate);if(!ready||capturing||$('gallery').classList.contains('open')){prev=now;return;}const dt=Math.min((now-prev)/1000,.05);prev=now;clock+=dt;calculate(clock);apply(dt,clock);render();frameCount++;if(now-lastStats>1000){$('status').textContent=`模型已就绪 · ${Math.round(frameCount*1000/(now-lastStats))} 帧/秒 · 本地渲染`;$('debug').textContent=`PMX 2.0 / 199 个原生表情控制\n骨骼 915 / 材质 44 / 物理关闭\n当前：${presets[selected].name} / 强度 ${$('strength').value}%\n`+[...weights].map((v,i)=>v>.001?`${i} ${mesh.geometry.morphTargets[i]?.name||''}: ${v.toFixed(3)}`:'').filter(Boolean).join('\n');frameCount=0;lastStats=now;}}
$('compare').onclick=async()=>{
 if(!ready)return;capturing=true;const old=selected,oldClose=closeup,oldBlush=$('blush').value;const tiles=$('tiles');tiles.replaceChildren();
 closeup=true;resize();
 for(let i=0;i<presets.length;i++) {select(i);calculate(clock,true);apply(0,clock,true);render();await new Promise(requestAnimationFrame);render();const tile=document.createElement('div');tile.className='tile';const img=document.createElement('img');img.src=renderer.domElement.toDataURL('image/png');img.alt=presets[i].name+'表情实际渲染';tile.append(img);const label=document.createElement('div');label.className='label';label.innerHTML=`<b>${presets[i].name}</b><p>${presets[i].en} / 强度 ${$('strength').value}%</p>`;tile.append(label);tiles.append(tile);}
 await createContactSheet();select(old);$('blush').value=oldBlush;closeup=oldClose;resize();capturing=false;$('gallery').classList.add('open');
};
async function createContactSheet(){
 const sheet=document.createElement('canvas');sheet.width=1600;sheet.height=1120;const ctx=sheet.getContext('2d');
 ctx.fillStyle='#191522';ctx.fillRect(0,0,1600,1120);ctx.fillStyle='#eeeafa';ctx.font='500 34px Microsoft YaHei, sans-serif';ctx.fillText('爱弥斯 · 八种表情',48,65);ctx.fillStyle='#aa9fbd';ctx.font='15px Microsoft YaHei, sans-serif';ctx.fillText('真实 PMX 模型渲染  /  固定镜头  /  表情强度 '+$('strength').value+'%  /  2026.10.12',48,101);
 const imgs=[...$('tiles').querySelectorAll('img')];await Promise.all(imgs.map(img=>img.decode()));
 imgs.forEach((img,i)=>{const x=48+(i%4)*381,y=135+Math.floor(i/4)*456,w=361,h=435;ctx.fillStyle='#2a2237';ctx.beginPath();ctx.roundRect(x,y,w,h,16);ctx.fill();ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,370,[16,16,0,0]);ctx.clip();const sh=img.naturalHeight,sw=sh*w/370;ctx.drawImage(img,(img.naturalWidth-sw)/2,0,sw,sh,x,y,w,370);ctx.restore();ctx.fillStyle='#eeeafa';ctx.font='500 22px Microsoft YaHei, sans-serif';ctx.fillText(presets[i].name,x+18,y+400);ctx.fillStyle='#afa1bf';ctx.font='12px Microsoft YaHei, sans-serif';ctx.fillText(presets[i].en,x+18,y+420);});
 ctx.fillStyle='#a69ab5';ctx.font='14px Microsoft YaHei, sans-serif';ctx.fillText('本地表情试镜 · 未启用头发 / 衣服物理 · 实时预览支持眨眼、呼吸、表情渐变和基础口型',48,1090);
 let download=$('download-sheet');if(!download){download=document.createElement('a');download.id='download-sheet';download.textContent='保存表情对照图';download.style.cssText='font-size:13px;margin-right:20px';$('close-gallery').before(download);}download.href=sheet.toDataURL('image/png');download.download='Aemeath-expression-study.png';
 const png=await new Promise(resolve=>sheet.toBlob(resolve,'image/png'));const saved=await fetch('/export-sheet',{method:'POST',headers:{'Content-Type':'image/png'},body:png});if(saved.ok){download.textContent='对照图已保存到 outputs';}else{console.warn('Local sheet export failed: '+saved.status);}
}
try{
 scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,150);
 renderer=new WebGPURenderer({antialias:true,alpha:true,forceWebGL:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x000000,0);await renderer.init();stage.prepend(renderer.domElement);resize();new ResizeObserver(resize).observe(stage);
 renderer.toneMapping=THREE.NeutralToneMapping;
 scene.add(new THREE.AmbientLight(0xffffff,1.15));const key=new THREE.DirectionalLight(0xfff2ed,1.4);key.position.set(-3,8,10);scene.add(key);const fill=new THREE.DirectionalLight(0xd3d9ff,.25);fill.position.set(7,4,5);scene.add(fill);
 const manager=new THREE.LoadingManager();manager.onProgress=(url,loaded,total)=>{$('load-note').textContent=`正在读取贴图 ${loaded} / ${total}`;};manager.onError=url=>{$('status').textContent='资源加载失败：'+url;};
 const loader=new MMDLoader(manager);mesh=await loader.loadAsync('/model/'+encodeURIComponent(pmxName));
 helper=new MMDAnimationHelper();helper.add(mesh,{physics:false});helper.enable('ik',false);
 for(const bone of mesh.skeleton.bones)baseBones.set(bone,bone.quaternion.clone());
 mesh.frustumCulled=false;scene.add(mesh);$('load-note').textContent='正在编译材质与表情…';
 await renderer.compileAsync(scene,camera);ready=true;calculate(0,true);apply(0,0,true);render();$('loading').style.display='none';$('status').textContent='模型已就绪 · 本地渲染';lastStats=performance.now();requestAnimationFrame(animate);
}catch(e){console.error(e);$('load-note').textContent=e.message;$('status').textContent='渲染失败：'+e.message;}
