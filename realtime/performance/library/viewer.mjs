import { createScene } from '../../qwen/scene.mjs';
import { GESTURES, GESTURE_IDS } from '../../../preview/core/motion-profile.js';
import { PRESETS, ACTIONS, C, CHANNELS, EXPRESSION_CATEGORIES, MICRO_ACTION_CATEGORIES } from '../../../preview/core/profile.js';
import { PerformanceDirector, STORIES } from '../director.mjs';

const $=id=>document.getElementById(id);
const legacyBody=new Set(['explain','wave','shrug','chest','bow_smile','laugh','curious','shy','explain_firm','surprise','think','greet','listen','comfort','look_up','agree']);
const legacyFaces=new Set(['neutral','smile','happy','curious','focus','surprise','shy','playful']);
const legacyActions=new Set(['nod','shake','tilt','glance','blink']);
const categories={micro:'细微反应',conversation:'日常交流',emotion:'情绪回应',large:'身体展开',legacy:'原有动作',positive:'温暖与愉快',negative:'低落与担心',social:'交流态度',attention:'注意与思考',rest:'放松休息',playful:'俏皮',warm:'温柔',uncertain:'迟疑',focused:'专注',subtle:'细微变化',head:'头部回应',gaze:'转头看向',original:'原有内容'};
for (const entry of [...EXPRESSION_CATEGORIES, ...MICRO_ACTION_CATEGORIES]) categories[entry.id]=entry.name;
const phases={prepare:'准备 · 目光先行',stroke:'表达 · 身体与表情展开',hold:'停留 · 保留呼吸',recover:'收回 · 自然接续',retract:'打断 · 平滑收势',delay:'停顿 · 等待回应',rest:'留白 · 安静陪伴',complete:'片段完成'};
const tabs={stories:'连续片段',body:'身体动作',faces:'面部表情',micro:'头部小动作'};
const items={
  stories:Object.entries(STORIES).map(([id,s])=>({id,name:s.name,note:s.description,category:s.steps?(s.category||'expanded'):'original',fresh:!!s.steps,meta:s.durationHint?`约 ${s.durationHint} 秒 · 可打断`:`${s.gestures?.length??s.steps?.length??0} 个步骤 · 可打断`})).sort((a,b)=>Number(b.fresh)-Number(a.fresh)),
  body:GESTURE_IDS.map(id=>({id,name:GESTURES[id].name,note:GESTURES[id].description||GESTURES[id].note||'目光、躯干与手势共同表达。',category:GESTURES[id].category||'legacy',fresh:!legacyBody.has(id),meta:`${GESTURES[id].duration.toFixed(1)} 秒编排 · 身体与表情联动`})),
  faces:PRESETS.map(p=>({id:p.id,name:p.name,note:p.note,category:p.category||'original',fresh:!legacyFaces.has(p.id),meta:p.microAction?`建议搭配：${ACTIONS[p.microAction]?.name||p.microAction}`:'眉眼与口角 · 可叠加口型'})),
  micro:Object.entries(ACTIONS).map(([id,a])=>({id,name:a.name,note:a.note||'短促回应，完成后自然回到原位。',category:a.category||'original',fresh:!legacyActions.has(id),meta:`${a.duration.toFixed(2)} 秒 · 轻量反应`}))
};
categories.expanded='本轮连续编排';
let scene,director,ready=false,error=null,tab='stories',category='all',selection=null,view='body',rendered=null;
let lastFrame=null,lastUI=0,samples=[],recording=null,recorder=null,recordingStopPromise=null,mouthSuppressed=false;
const percentile=(a,k)=>{a=a.slice().sort((x,y)=>x-y);return a[Math.floor((a.length-1)*k)]||0;};
function setView(id){view=id;scene?.setView(id);for(const b of $('views').children)b.setAttribute('aria-pressed',String(b.dataset.view===id));}
function selectTab(next){if(!items[next])return false;tab=next;category='all';renderCategories();renderCards();for(const b of $('tabs').children)b.setAttribute('aria-pressed',String(b.dataset.tab===tab));return true;}
function renderCategories(){
  $('categories').replaceChildren();
  for(const id of ['all',...new Set(items[tab].map(x=>x.category))]){
    const b=document.createElement('button');b.textContent=id==='all'?'全部':categories[id]||id;b.dataset.category=id;b.setAttribute('aria-pressed',String(id===category));
    b.onclick=()=>{category=id;renderCategories();renderCards();};$('categories').append(b);
  }
}
function renderCards(){
  const query=$('search').value.trim().toLocaleLowerCase(),fresh=$('new-only').checked;
  const rows=items[tab].filter(x=>(category==='all'||x.category===category)&&(!fresh||x.fresh)&&(!query||`${x.name} ${x.note} ${x.id} ${categories[x.category]||x.category}`.toLocaleLowerCase().includes(query)));
  $('cards').replaceChildren();$('empty').hidden=!!rows.length;$('result-count').textContent=`${rows.length} 项${fresh?' · 本轮新增':''}`;
  for(const row of rows){
    const b=document.createElement('button');b.className='card';b.dataset.id=row.id;b.dataset.kind=tab;b.disabled=!ready;b.setAttribute('aria-pressed',String(selection?.kind===tab&&selection.id===row.id));
    const title=document.createElement('strong');title.textContent=row.name;
    if(row.fresh){const badge=document.createElement('span');badge.className='badge';badge.textContent='NEW';title.append(badge);}
    const note=document.createElement('span');note.className='note';note.textContent=row.note;
    const meta=document.createElement('span');meta.className='meta';meta.textContent=row.meta;b.append(title,note,meta);b.onclick=()=>choose(tab,row.id);$('cards').append(b);
  }
}
function choose(kind,id){
  if(!ready||!items[kind]?.some(x=>x.id===id))return false;
  scene.motion.inspect(null);
  let result=false;
  if(kind==='stories')result=director.playStory(id,$('loop').checked);
  else if(kind==='body')result=director.play(id);
  else if(kind==='faces')result=director.playExpression(id,+$('face-strength').value);
  else result=director.playAction(id,{intensity:+$('face-strength').value});
  if(result){mouthSuppressed=false;selection={kind,id};const row=items[kind].find(x=>x.id===id);$('title').textContent=row.name;$('description').textContent=row.note;$('kind').textContent=tabs[kind];
    $('status').textContent=kind==='stories'?'片段包含表达、停顿与收势。新增片段开启循环时最多连播两轮。':'已从当前状态接入。可切换侧前或面部视角观察。';
  }else $('status').textContent='这个动作尚在冷却，稍后可以再试。';
  renderCards();return result;
}
function stop(){if(!ready)return false;scene.motion.inspect(null);const result=director.stop();selection=null;mouthSuppressed=true;$('mouth').checked=false;renderCards();$('title').textContent='慢慢收回，继续陪你。';$('description').textContent='后续片段已撤销，身体与表情从当前状态收回。';$('status').textContent='已打断；不会自行接回刚才的连续片段。';return result;}
function snapshot(){return{ready,error,view,selection,environment:scene?.environment,counts:Object.fromEntries(Object.entries(items).map(([k,v])=>[k,v.length])),director:director?.snapshot(),motion:scene?.motion.snapshot(),rendered,performance:{frames:samples.length,fps:samples.length?1000/(samples.reduce((n,r)=>n+r.interval,0)/samples.length):0,driverP95Ms:percentile(samples.map(r=>r.driver),.95),renderP95Ms:percentile(samples.map(r=>r.render),.95),frameP95Ms:percentile(samples.map(r=>r.interval),.95)},boundary:'Local authored procedural motions. No cloud or microphone. Silent mouth test only. Hair and clothing physics disabled.'};}
function setOptions(o){if(o.expression!==undefined){$('expression').checked=!!o.expression;scene?.setExpressionEnabled(!!o.expression);}if(o.mouth!==undefined){$('mouth').checked=!!o.mouth;if(o.mouth)mouthSuppressed=false;}scene?.motion.setOptions(o);}
function updateUI(){
  const s=snapshot(),d=s.director,g=s.motion.gestures.find(g=>g.id===d.activeId)||s.motion.gestures.find(g=>!g.recovering)||s.motion.gestures[0];
  $('phase').textContent=d.paused?'已暂停':phases[d.sequence?.phase]||phases[g?.phase]||'安静陪伴 · 呼吸与微动';
  $('fps').textContent=`${s.performance.fps.toFixed(0)} FPS`;$('driver').textContent=`驱动 ${s.performance.driverP95Ms.toFixed(2)} ms`;$('pause').textContent=d.paused?'继续':'暂停';
  const seq=d.sequence;$('sequence').hidden=!d.story||!seq;
  if(seq){$('sequence-step').textContent=`第 ${Math.min(seq.total,seq.step??1)} / ${seq.total} 步 · 第 ${seq.cycle??1} 轮`;$('sequence-time').textContent=seq.remaining>0?`当前步骤 ${seq.remaining.toFixed(1)} 秒`:'动作进行中';$('sequence-progress').value=Math.max(0,((seq.step??1)-1)/Math.max(1,seq.total));}
  $('diagnostics').textContent=JSON.stringify({director:d,motion:s.motion.gestures,counts:s.counts,performance:s.performance},null,2);
}
function frame(wall){
  requestAnimationFrame(frame);if(!ready||error)return;
  try{
    const clock=director.tick(wall/1000);let lip=null;
    if($('mouth').checked){const w=new Float32Array(CHANNELS.length),p=clock.now*4.2;w[C.a]=.55*Math.max(0,Math.sin(p));w[C.i]=.25*Math.max(0,Math.sin(p+1.7));w[C.u]=.2*Math.max(0,Math.sin(p+3.1));lip={weights:w,closure:0,level:.6};}
    rendered=scene.step(clock.now*1000,clock.dt,lip,{paused:director.paused,idle:!director.paused,mouthMode:mouthSuppressed||(director.paused&&lip)?'closed':lip?'speech':'expression'});
    if(lastFrame!==null&&!document.hidden){samples.push({interval:wall-lastFrame,driver:rendered.driverMs,render:rendered.renderMs});if(samples.length>900)samples.shift();}lastFrame=wall;
    if(wall-lastUI>150){updateUI();lastUI=wall;}
  }catch(e){fail(e);}
}
function fail(e){error=String(e?.message||e);$('status').textContent=`预览失败：${error}`;const note=$('load-note');if(note)note.textContent=error;console.error(e);}
function startRecording(){
  if(!ready||recorder||recordingStopPromise)return false;
  const stream=$('stage').querySelector('canvas').captureStream(30),chunks=[],current=new MediaRecorder(stream,{mimeType:'video/webm'});recording=null;recorder=current;
  current.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};current.onstop=()=>{stream.getTracks().forEach(t=>t.stop());if(recorder===current){recording=new Blob(chunks,{type:'video/webm'});recorder=null;}};current.start();return true;
}
async function stopRecording(){if(recordingStopPromise)await recordingStopPromise;else if(recorder){const current=recorder;recordingStopPromise=new Promise(resolve=>{current.addEventListener('stop',resolve,{once:true});current.stop();});try{await recordingStopPromise;}finally{recordingStopPromise=null;}}return recording?.size||0;}
async function downloadRecording(){if(!recording)return false;const a=document.createElement('a');a.href=URL.createObjectURL(recording);a.download='expanded-library.webm';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return true;}
for(const [id,name] of [['body','上身'],['angle','侧前'],['side','侧面'],['full','全身'],['face','面部']]){const b=document.createElement('button');b.textContent=name;b.dataset.view=id;b.onclick=()=>setView(id);$('views').append(b);}
for(const [id,label] of Object.entries(tabs)){const b=document.createElement('button');b.dataset.tab=id;b.textContent=`${label} ${items[id].length}`;b.onclick=()=>selectTab(id);$('tabs').append(b);}
$('counts').textContent=`${items.body.length} 个身体动作 · ${items.faces.length} 种表情 · ${items.micro.length} 个头部小动作 · ${items.stories.length} 段连续编排`;
$('search').oninput=renderCards;$('new-only').onchange=renderCards;$('pause').onclick=()=>director?.pause();$('stop').onclick=stop;$('loop').onchange=()=>{if(director)director.repeat=$('loop').checked;};
$('play-feature').onclick=()=>choose('stories',items.stories.find(x=>x.fresh)?.id||'coordination');
$('intensity').oninput=()=>{scene?.motion.setOptions({intensity:+$('intensity').value});$('intensity-value').textContent=`${Math.round(+$('intensity').value*100)}%`;};
$('speed').oninput=()=>{scene?.motion.setOptions({speed:+$('speed').value});$('speed-value').textContent=`${(+$('speed').value).toFixed(2)}×`;};
$('face-strength').oninput=()=>{const value=+$('face-strength').value;$('face-value').textContent=`${Math.round(value*100)}%`;if(selection?.kind==='faces')director.playExpression(selection.id,value);};
$('expression').onchange=()=>setOptions({expression:$('expression').checked});$('natural').onchange=()=>setOptions({natural:$('natural').checked});
$('mouth').onchange=()=>{if($('mouth').checked)mouthSuppressed=false;};
window.motionLibrary={get ready(){return ready;},catalog:items,choose,stop,pause:()=>director?.pause(),setView,selectTab,setOptions,snapshot,startRecording,stopRecording,downloadRecording,
  get scene(){return scene;},get director(){return director;},resetMetrics(){samples=[];lastFrame=null;}};
selectTab('stories');setView('body');
(async()=>{scene=await createScene($('stage'),message=>$('load-note').textContent=message);director=new PerformanceDirector({motion:scene.motion,face:scene.face});setView(view);ready=true;$('loading').remove();for(const id of ['play-feature','pause','stop'])$(id).disabled=false;renderCards();requestAnimationFrame(frame);})().catch(fail);
