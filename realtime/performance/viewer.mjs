import { createScene } from '../qwen/scene.mjs';
import { GESTURES, GESTURE_IDS } from '../../preview/core/motion-profile.js';
import { C, CHANNELS } from '../../preview/core/profile.js';
import { PerformanceDirector, STORIES } from './director.mjs';

const $ = id => document.getElementById(id);
const PHASES = { prepare: '准备 · 重心与目光先行', stroke: '表达 · 身体与表情展开', hold: '停留 · 保留呼吸', recover: '收回 · 自然接续', retract: '打断 · 从当前姿态收回', done: '安静陪伴' };
const NOTES = {
  bow_smile: ['靠近 · 抬眼 · 微笑', '腰背先靠近，头颈轻轻抬起，目光回到你，最后微笑。'],
  laugh: ['肩胸 · 笑眼 · 余韵', '身体和肩膀随笑意舒展，不把开心变成机械点头。'],
  curious: ['探身 · 歪头 · 注视', '先看向你，再带着疑问靠近一点。'],
  shy: ['避开 · 收肩 · 回望', '目光先移开，肩膀微收，再悄悄看回来。'],
  explain_firm: ['重心 · 手势 · 点明', '躯干和手一起引出重点，表情随解释变得认真。'],
  surprise: ['抬眼 · 后仰 · 回神', '先是一瞬惊讶，再把身体和目光慢慢收回来。'],
  think: ['转眸 · 收手 · 停顿', '目光寻找线索，双手收近胸前，留一点思考的停顿。'],
  greet: ['看见 · 挥手 · 笑意', '看到你之后才挥手，肩、头和笑意一起响应。'],
  listen: ['靠近 · 放松 · 倾听', '把注意力交给你，身体向前，手臂和眉眼放轻。'],
  comfort: ['靠近 · 伸手 · 安抚', '动作留有距离，慢慢伸出手，再温柔地收回。'],
  look_up: ['视线 · 仰头 · 舒展', '视线先向上，头颈和胸口随后舒展，带着笑意回望。'],
  agree: ['眼神 · 点头 · 微笑', '先用目光回应，再让头颈和上身一起轻轻认同。'],
  wave: ['手腕 · 肩颈 · 招呼', '手臂与肩颈共同完成招呼，手指稍后跟上。'],
  explain: ['掌心 · 转身 · 解释', '掌心打开，身体轻转，视线仍留在对话对象。'],
  shrug: ['肩膀 · 掌心 · 眉眼', '双肩与掌心错开一点，配合自然的疑惑表情。'],
  chest: ['手心 · 倾身 · 真诚', '手放在胸前时，上身、目光和表情也一起放柔。'],
};
let scene, director, ready = false, error = null, lastUI = 0, lastFrame = null;
let rendered, view = 'body', samples = [];
const percentile = (rows, k) => { const a = rows.slice().sort((x,y)=>x-y); return a[Math.floor((a.length-1)*k)] || 0; };
function fail(cause) {
  error = String(cause?.message || cause); $('status').textContent = `预览未完成：${error}`;
  $('load-note').textContent = error; console.error(cause);
}
function play(id) {
  if (!ready) return false;
  const result = director.play(id);
  $('status').textContent = result ? '正在从当前姿态接入新动作。可随时切视角或打断。' : '这个动作正在进行，稍后可以重播。';
  return result;
}
function playStory(id) {
  if (!ready) return false;
  const accepted = director.playStory(id, $('loop').checked);
  $('status').textContent = accepted ? STORIES[id].description : '当前无法开始连播。';
  return accepted;
}
function stop() {
  if (!ready) return false;
  const result = director.stop();
  $('status').textContent = '已打断，身体和表情从当前状态自然收回。';
  return result;
}
function setView(id) {
  if (!ready) return;
  view = id; scene.setView(id);
  for (const b of $('views').children) b.setAttribute('aria-pressed', String(b.dataset.view===id));
}
function snapshot() {
  return { ready, error, view, environment: scene?.environment, director: director?.snapshot(), motion: scene?.motion.snapshot(),
    rendered, performance: { frames: samples.length, fps: samples.length ? 1000/(samples.reduce((n,r)=>n+r.interval,0)/samples.length) : 0,
      driverP95Ms: percentile(samples.map(r=>r.driver),.95), renderP95Ms: percentile(samples.map(r=>r.render),.95),
      frameP95Ms: percentile(samples.map(r=>r.interval),.95) },
    boundary: 'Local PMX runtime, no cloud/microphone/audio. Synthetic mouth stress mode is not speech recognition. Clothing/hair physics disabled.' };
}
function updateUI() {
  const s = snapshot(), g = s.motion.gestures.find(g=>g.id===s.director.activeId) || s.motion.gestures.find(g=>!g.recovering) || s.motion.gestures[0];
  const id = g?.gesture || s.director.selected, note = NOTES[id];
  $('title').textContent = GESTURES[id]?.name || '安静陪伴';
  $('category').textContent = note?.[0] || '一个完整的表达';
  $('description').textContent = note?.[1] || '身体与表情自然配合。';
  $('phase').textContent = s.director.paused ? '已暂停' : g ? PHASES[g.phase] || g.phase : '安静陪伴 · 呼吸与微动';
  $('fps').textContent = `${s.performance.fps.toFixed(0)} FPS`;
  $('driver').textContent = `驱动 ${s.performance.driverP95Ms.toFixed(2)} ms`;
  $('pause').textContent = s.director.paused ? '继续' : '暂停';
  for (const b of $('gestures').children) b.setAttribute('aria-pressed', String(b.dataset.gesture===id && !!g));
  for (const b of $('stories').children) b.setAttribute('aria-pressed', String(b.dataset.story===s.director.story));
  $('diagnostics').textContent = JSON.stringify({ motion: { gestures:s.motion.gestures, body:s.motion.body, support:s.motion.support }, performance:s.performance, expression: rendered?.expression?.enabled }, null,2);
}
function frame(wallMs) {
  requestAnimationFrame(frame); if (!ready || error) return;
  try {
    const clock = director.tick(wallMs/1000);
    // A silent, deterministic mouth stress pattern proves expression composition
    // does not take ownership of speech vowels. It is never labelled real speech.
    let lip = null;
    if ($('speech').checked) {
      const phase = clock.now*4.2;
      const weights = new Float32Array(CHANNELS.length);
      weights[C.a] = .65*Math.max(0,Math.sin(phase));
      weights[C.i] = .25*Math.max(0,Math.sin(phase+1.7));
      weights[C.u] = .22*Math.max(0,Math.sin(phase+3.1));
      lip = { weights, closure: 0, level:.6 };
    }
    rendered = scene.step(clock.now*1000, clock.dt, lip, { paused:director.paused, idle:!director.paused, speechOwnsMouth:false });
    if (lastFrame !== null && !document.hidden) {
      samples.push({ interval:wallMs-lastFrame, driver:rendered.driverMs, render:rendered.renderMs });
      if (samples.length>900) samples.shift();
    }
    lastFrame = wallMs;
    if (wallMs-lastUI>120) { updateUI(); lastUI=wallMs; }
  } catch(cause) { fail(cause); }
}
for (const [id, name] of [['body','上身'],['angle','侧前'],['side','侧面'],['full','全身'],['face','面部']]) {
  const b=document.createElement('button'); b.textContent=name;b.dataset.view=id;b.setAttribute('aria-pressed',String(id===view));b.onclick=()=>setView(id);$('views').append(b);
}
for (const [id, story] of Object.entries(STORIES)) {
  const b=document.createElement('button');b.textContent=story.name;b.dataset.story=id;b.disabled=true;b.onclick=()=>playStory(id);$('stories').append(b);
}
for (const id of GESTURE_IDS) {
  const b=document.createElement('button');b.dataset.gesture=id;b.disabled=true;
  const title=document.createElement('strong'), note=document.createElement('span'); title.textContent=GESTURES[id].name;note.textContent=NOTES[id]?.[0] || '完整表达';b.append(title,note);
  b.onclick=()=>play(id);$('gestures').append(b);
}
$('count').textContent=`${GESTURE_IDS.length} 种`;
$('hero').onclick=()=>play('bow_smile');$('pause').onclick=()=>director.pause();$('stop').onclick=stop;
$('loop').onchange=()=>{if(director) director.repeat=$('loop').checked;};
$('intensity').oninput=()=>{scene?.motion.setOptions({intensity:+$('intensity').value});$('intensity-value').textContent=`${Math.round(+$('intensity').value*100)}%`;};
$('speed').oninput=()=>{scene?.motion.setOptions({speed:+$('speed').value});$('speed-value').textContent=`${(+$('speed').value).toFixed(2)}×`;};
$('expression').onchange=()=>scene?.setExpressionEnabled($('expression').checked);
$('natural').onchange=()=>scene?.motion.setOptions({natural:$('natural').checked});
window.performanceLab={get ready(){return ready;},play,playStory,stop,pause:()=>director?.pause(),setView,snapshot,
  resetMetrics(){ samples=[]; lastFrame=null; },
  setOptions(options){if(options.expression!==undefined){$('expression').checked=!!options.expression;scene?.setExpressionEnabled(options.expression);}if(options.speech!==undefined)$('speech').checked=!!options.speech;scene?.motion.setOptions(options);},
  get motion(){return scene?.motion;},get director(){return director;},get scene(){return scene;}};
(async()=>{
  scene=await createScene($('stage'),text=>$('load-note').textContent=text);
  director=new PerformanceDirector({motion:scene.motion,face:scene.face});ready=true;
  $('loading').remove();for(const b of document.querySelectorAll('button:disabled'))b.disabled=false;
  requestAnimationFrame(frame);
  playStory('wave_review');
})().catch(fail);
