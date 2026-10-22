import { createActivityScene } from './scene.mjs';
import { ActivityDirector } from './director.mjs';
import { ACTIVITY_LIBRARY, ACTIVITY_IDS, ACTIVITY_SEQUENCES } from '../../preview/core/activity-library.js';

const $=id=>document.getElementById(id);
const categories={locomotion:'行走与跑动',walking:'各向行走',turning:'转向',running:'跑动',jumping:'跳跃与落地',jump:'跳跃与落地',seated:'坐姿与起身',reading:'阅读',daily:'生活互动',exercise:'运动与锻炼',balance:'平衡',stretch:'舒展',interaction:'物品互动',sport:'运动',all:'全部'};
const supportNames={standing:'双脚站立',ground:'地面支撑',single:'单脚支撑',airborne:'腾空',seated:'座面支撑',kneeling:'跪姿',floor:'地面活动'};
const propNames={chair:'椅子',table:'桌子',book:'书',mug:'杯子',mat:'运动垫',platform:'阶梯',paper:'纸',pencil:'铅笔',laptop:'笔记本电脑',box:'纸箱'};
const phaseNames={idle:'等待开始',ready:'准备',prepare:'准备',stride:'迈步',gather:'收步',arrived:'到达',flight:'腾空',crouch:'蓄力',absorb:'缓冲落地',landed:'已落地',position_feet:'调整脚位',lower:'落座',seated:'坐定',lean_forward:'前倾',rise:'起身',standing:'站稳',read:'阅读',turn_page:'翻页',close_book:'合书',closed_book:'合书思考',exercise:'运动中',recover:'收稳',drink:'举杯',write:'写字',keyboard:'打字',settle:'收稳',hold:'保持',transition:'衔接','seated-hold':'坐姿保持'};
let scene,director,ready=false,error=null,tab='activities',category='all',selected=null,view='angle',rendered=null,last=null,lastUI=0,samples=[],recorder=null,recording=null,stopping=null;
let manualClock=false;
const pct=(values,k=.95)=>values.length?[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*k)]:0;
const entries=()=>Object.entries(tab==='activities'?ACTIVITY_LIBRARY:ACTIVITY_SEQUENCES).map(([id,d])=>({id,...d}));
function render(){
  for(const b of $('tabs').children)b.setAttribute('aria-pressed',String(b.dataset.tab===tab));
  const list=entries(),cats=['all',...new Set(list.map(d=>d.category??'sequence'))];
  if(!cats.includes(category))category='all';$('categories').replaceChildren();
  for(const id of cats){const b=document.createElement('button');b.textContent=categories[id]??(id==='sequence'?'连续生活':id);b.setAttribute('aria-pressed',String(category===id));b.onclick=()=>{category=id;render();};$('categories').append(b);}
  const query=$('search').value.trim().toLowerCase(),shown=list.filter(d=>(category==='all'||(d.category??'sequence')===category)&&(!query||`${d.id} ${d.name} ${d.description}`.toLowerCase().includes(query)));
  $('cards').replaceChildren();$('result-count').textContent=`${shown.length} 项`;$('empty').hidden=shown.length>0;
  for(const d of shown){const b=document.createElement('button');b.className='card';b.dataset.id=d.id;b.disabled=!ready;b.setAttribute('aria-pressed',String(selected?.id===d.id&&selected.tab===tab));const title=document.createElement('strong');title.textContent=d.name;const text=document.createElement('span');text.textContent=d.description;const meta=document.createElement('small');meta.textContent=tab==='activities'?`${d.duration.toFixed(1)} 秒 · ${d.requires?.length?d.requires.map(id=>propNames[id]??id).join(' / '):'无道具'}`:`${d.steps.length} 个活动 · 可暂停 / 停止`;b.append(title,text,meta);b.onclick=()=>choose(tab,d.id);$('cards').append(b);}
}
function choose(kind,id){
  if(!ready)return false;const sequence=kind==='sequences',definition=(sequence?ACTIVITY_SEQUENCES:ACTIVITY_LIBRARY)[id];if(!definition)return false;
  const ok=sequence?director.playSequence(id):director.play(id);
  if(ok){selected={tab:kind,id};$('kind').textContent=sequence?'连续生活片段':'全身活动';$('title').textContent=definition.name;$('description').textContent=definition.description;$('status').textContent='已接入全身时间线。可以切换视角观察支撑与道具。';render();}return ok;
}
function stop(){if(!ready)return;director.stop();$('status').textContent='后续活动已撤销。空中动作先落地，坐姿保持座面支撑，其余动作收稳。';}
function reset(){if(!ready)return;director.reset();scene.props.clear();selected=null;last=null;samples=[];$('title').textContent='舞台已回到起点';$('description').textContent='重新选择动作或连续生活片段。';$('status').textContent='人物、道具和活动队列已重置。';render();}
function setView(id){view=id;scene?.setView(id);for(const b of $('views').children)b.setAttribute('aria-pressed',String(b.dataset.view===id));}
function snapshot(){return{ready,error,selected,counts:{activities:ACTIVITY_IDS.length,sequences:Object.keys(ACTIVITY_SEQUENCES).length},environment:scene?.environment,director:director?.snapshot(),body:scene?.body.snapshot(),rendered,performance:{frames:samples.length,fps:samples.length?1000/(samples.reduce((s,r)=>s+r.interval,0)/samples.length):0,driverP95Ms:pct(samples.map(r=>r.driver)),frameP95Ms:pct(samples.map(r=>r.interval))}};}
function update(){const s=snapshot(),b=s.body,seq=s.director.sequence;$('support').textContent=supportNames[b.support]??b.support??'支撑';$('phase').textContent=s.director.paused?'已暂停':phaseNames[b.phase]??'活动中';$('pause').textContent=s.director.paused?'继续':'暂停';$('sequence').textContent=seq?`第 ${seq.step} / ${seq.total} 个活动`:'';$('position').textContent=b.root.position.map(v=>v.toFixed(2)).join(', ');for(const [key,side] of [['left-contact','L'],['right-contact','R']]){$(key).textContent=b.pose?.feet?.[side]?.contact?'支撑':'离地';}$('prop-count').textContent=Object.entries(s.rendered?.props?.props??{}).filter(([,v])=>v.visible).map(([k])=>propNames[k]??k).join(' / ')||'—';$('fps').textContent=manualClock?'定格检查':`${s.performance.fps.toFixed(0)} FPS · 驱动 ${s.performance.driverP95Ms.toFixed(2)} ms`;$('diagnostics').textContent=JSON.stringify({body:b,director:s.director,props:s.rendered?.props,performance:s.performance},null,2);}
function frame(wall){requestAnimationFrame(frame);if(!ready||error||manualClock)return;try{const clock=director.tick(wall/1000);rendered=scene.step(clock.now,clock.dt,{paused:clock.paused});if(last!==null&&!document.hidden){samples.push({interval:wall-last,driver:rendered.driverMs});if(samples.length>240)samples.shift();}last=wall;if(wall-lastUI>160){update();lastUI=wall;}}catch(e){fail(e);}}
function fail(e){error=e.stack??String(e);$('status').textContent=`预览异常：${e.message??e}`;if($('load-note'))$('load-note').textContent=e.message??String(e);console.error(e);}
function startRecording(){if(!ready||recorder||stopping)return false;const stream=$('stage').querySelector('canvas').captureStream(30),chunks=[],current=new MediaRecorder(stream,{mimeType:'video/webm'});recording=null;recorder=current;current.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};current.onstop=()=>{stream.getTracks().forEach(t=>t.stop());if(recorder===current){recording=new Blob(chunks,{type:'video/webm'});recorder=null;}};current.start();return true;}
async function stopRecording(){if(stopping)await stopping;else if(recorder){const current=recorder;stopping=new Promise(r=>{current.addEventListener('stop',r,{once:true});current.stop();});try{await stopping;}finally{stopping=null;}}return recording?.size??0;}
function downloadRecording(){if(!recording)return false;const a=document.createElement('a');a.href=URL.createObjectURL(recording);a.download='aemeath-activities.webm';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return true;}
for(const [id,name] of [['angle','侧前'],['front','正面'],['side','侧面'],['back','后方'],['wide','全景']]){const b=document.createElement('button');b.textContent=name;b.dataset.view=id;b.onclick=()=>setView(id);$('views').append(b);}
for(const b of $('tabs').children)b.onclick=()=>{tab=b.dataset.tab;category='all';render();};
$('search').oninput=render;$('pause').onclick=()=>director?.pause();$('stop').onclick=stop;$('follow').onchange=()=>scene?.setFollow($('follow').checked);$('speed').oninput=()=>{const value=+$('speed').value;$('speed-value').textContent=`${value.toFixed(2)}×`;if(director)director.speed=value;$('status').textContent='速度将在下一个活动开始时生效。';};
$('counts').textContent=`${ACTIVITY_IDS.length} 个全身活动 · ${Object.keys(ACTIVITY_SEQUENCES).length} 段连续生活`;
$('reset').onclick=reset;
window.activityLab={get ready(){return ready;},get scene(){return scene;},get director(){return director;},catalog:ACTIVITY_LIBRARY,sequences:ACTIVITY_SEQUENCES,choose,stop,reset,pause:()=>director?.pause(),setView,snapshot,startRecording,stopRecording,downloadRecording,resetMetrics(){samples=[];last=null;}};
// Offline capture owns only this viewer's clock. Three's renderer retains its
// own animation frame so skinning buffers continue to follow the actual bones.
Object.assign(window.activityLab,{setManualClock(value){manualClock=!!value;last=null;director.wall=null;},drawFrame(now,dt=0){if(!manualClock)throw Error('Manual clock required');rendered=scene.step(now,dt,{paused:director.paused});update();return rendered;}});
render();setView('angle');
(async()=>{scene=await createActivityScene($('stage'),m=>$('load-note').textContent=m);director=new ActivityDirector(scene.body);scene.setView(view);ready=true;$('loading').remove();$('pause').disabled=false;$('stop').disabled=false;$('reset').disabled=false;render();requestAnimationFrame(frame);const query=new URLSearchParams(location.hash.slice(1));if(query.has('sequence'))choose('sequences',query.get('sequence'));else if(query.has('activity'))choose('activities',query.get('activity'));})().catch(fail);
