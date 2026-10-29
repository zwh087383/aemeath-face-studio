import { createScene } from '/character-center/scene.mjs';
import { createScene as createLegacyScene } from './legacy-scene.mjs';
const $ = id => document.getElementById(id);
const data = await (await fetch('./data.json')).json();
let selected, engines = [], frameIndex = 0, position = 0, playing = false, lastWall = 0, loading = false;
let error = null, timings = [], interruption = null;
const media = t => ({ audioStatus: interruption ? 'ended' : t < selected.audioStart ? 'idle' : t < selected.audioEnd ? 'playing' : 'ended',
  audioTime: Math.max(0, Math.min(selected.audioDuration, t-selected.audioStart)), mediaOwner: { turnId: selected.turnId },
  segmentEnded: t >= selected.audioEnd });
function face(t) {
  const samples = selected.faceSamples;
  let index = samples.findIndex(s => s.videoSeconds > t);
  if (index < 0) return samples.at(-1)?.weights ?? [];
  if (!index) return samples[0].weights;
  const left = samples[index-1], right = samples[index], f = (t-left.videoSeconds)/(right.videoSeconds-left.videoSeconds);
  return left.weights.map((v, i) => v+(right.weights[i]-v)*f);
}
function tick(frame, render) {
  const started = performance.now(), weights = face(frame.videoSeconds), playback = media(frame.videoSeconds);
  for (const engine of engines) {
    const d = engine.scene.bodyDirector;
    while (engine.command < selected.commands.length && selected.commands[engine.command].acceptedAt <= d.now+1e-7) {
      const row = selected.commands[engine.command++];
      engine.submissions.push({ videoSeconds: frame.videoSeconds, commandIndex: engine.command-1,
        result: d.submit(row.command, row.owner) });
    }
    while (engine.revoke < selected.revocations.length && selected.revocations[engine.revoke].videoSeconds <= frame.videoSeconds) {
      const event = selected.revocations[engine.revoke++];
      if (!event.sourceKey && event.turnId) engine.retiredTurns.add(event.turnId);
      const owners = d.rows.filter(row => event.sourceKey ? row.owner.sourceKey === event.sourceKey : row.owner.turnId === event.turnId).map(row => row.owner);
      for (const owner of owners) d.cancel(owner, event.reason);
    }
    engine.last = engine.scene.step(frame.time, frame.dt, { faceWeights: weights, ...playback, render });
    for (const event of d.events) {
      const key = `${event.type}:${event.id}:${event.at}:${event.replacementRequestId??''}`;
      if (!engine.seen.has(key)) { engine.seen.add(key); engine.events.push({ ...structuredClone(event), videoSeconds: frame.videoSeconds }); }
    }
  }
  if (render) timings.push(performance.now()-started);
}
function advance(target, render = true) {
  while (frameIndex < selected.frames.length && selected.frames[frameIndex].videoSeconds <= target) {
    const last = frameIndex+1 >= selected.frames.length || selected.frames[frameIndex+1].videoSeconds > target;
    tick(selected.frames[frameIndex++], render && last);
  }
  position = Math.min(target, selected.stop); update();
  if (position >= selected.stop) playing = false;
  return result();
}
function result() {
  const target = selected.commands[selected.targetCommandIndex].owner.requestId;
  return { id: selected.id, position, playing, error, interruption, baseline: data.baseline, cloudCalls: 0,
    engines: engines.map(engine => ({ name: engine.name, sourceSpeed: engine.last?.sourceSpeed,
      bodyAmplitude: engine.last?.bodyAmplitude, finite: engine.last?.finite, view: engine.last?.view,
      target: engine.scene.bodyDirector.rows.filter(row => row.owner.requestId === target && row.action === selected.originalTarget),
      rows: structuredClone(engine.scene.bodyDirector.rows), events: engine.events, submissions: engine.submissions,
      active: engine.scene.bodyDirector.active?.action ?? null,
      retained: engine.events.filter(e => e.type === 'action_retained').length,
      movingReplaced: engine.events.filter(e => e.type === 'action_cancelled' && e.reason === 'model_replace'
        && engine.events.some(s => s.type === 'action_started' && s.id === e.id)).length })),
    renderDriverMs: timings.length ? { samples: timings.length, max: Math.max(...timings),
      median: [...timings].sort((a,b)=>a-b)[Math.floor(timings.length/2)] } : null };
}
function update() {
  $('clock').textContent = `原录像 ${Math.max(0,position).toFixed(2)} 秒`;
  for (const engine of engines) {
    const d = engine.scene.bodyDirector;
    $(`${engine.name}-state`).textContent = `当前：${d.active?.action??'自然待机'} · 后续 ${d.pending.length} 项 · 保留 ${engine.events.filter(e=>e.type==='action_retained').length} 次`;
  }
  const r = result();
  $('result').textContent = r.engines.map(e => {
    const t=e.target[0]; return `${e.name==='old'?'旧版':'新版'}：目标 ${selected.originalTarget} ${t?.status??'未到达'}${t?.reason?'（'+t.reason+'）':''}；执行中被普通替换取消 ${e.movingReplaced} 次。`;
  }).join('\n') + (interruption ? '\n已发出本地插话撤销，两个执行器的旧指令都立即失效。' : '');
}
async function load(id = $('case').value, start = null) {
  if (loading) throw Error('comparison_loading'); loading = true; playing = false;
  $('play').disabled = $('pause').disabled = $('interrupt').disabled = true;
  selected = data.cases.find(c=>c.id===id); if (!selected) throw Error('unknown_case');
  $('case').value = id;
  for (const engine of engines) engine.scene.dispose();
  engines = []; frameIndex = 0; position = 0; timings = []; interruption = null; error = null;
  const configs = ['old','new'].map(name=>({name,retiredTurns:new Set(),command:0,revoke:0,submissions:[],events:[],seen:new Set()}));
  const scenes = await Promise.all(configs.map((config,index)=>(index?createScene:createLegacyScene)(
    $(`${config.name}-stage`), text=>{$('status').textContent=text;},
    {isOwnerCurrent:owner=>!config.retiredTurns.has(owner.turnId)})));
  engines = scenes.map((scene,index)=>({...configs[index],scene}));
  for(const engine of engines)engine.scene.setView($('view').value);
  $('utterance').textContent = `用户：${selected.text}　回复：${selected.reply}`;
  $('original').src = selected.originalVideo;
  advance(start??selected.focus);
  $('status').textContent = '准备完成。对照使用原始模型选择，点击后按原速播放。';
  $('play').disabled = $('pause').disabled = $('interrupt').disabled = false; loading = false;
  return result();
}
function interrupt() {
  const start = performance.now();
  interruption = { at: position, before: engines.map(e=>({name:e.name,active:e.scene.bodyDirector.active?.id??null})) };
  for(const engine of engines){
    // Match CharacterCenter.cancel's whole-turn fence, including sources which
    // currently have no active/queued step but still have a tool in flight.
    engine.retiredTurns.add(selected.turnId);
    engine.scene.bodyDirector.cancel(null,'explicit_user_interrupt');
  }
  interruption.commandCancelMs = performance.now()-start;
  interruption.after = engines.map(e=>({name:e.name,active:e.scene.bodyDirector.active?.id??null,pending:e.scene.bodyDirector.pending.length}));
  update();return result();
}
function play() { playing = true; lastWall = performance.now(); }
function animate(now) {
  requestAnimationFrame(animate);
  if (!playing || loading || error) return;
  try { const delta=(now-lastWall)/1000; lastWall=now; advance(position+delta); }
  catch(e){error=e.stack;playing=false;$('status').textContent=e.message;console.error(e);}
}
$('case').onchange=()=>load().catch(e=>{$('status').textContent=e.message;});
$('play').onclick=async()=>{await load();play();};
$('pause').onclick=()=>{if(playing)playing=false;else play();};
$('interrupt').onclick=interrupt;
$('view').onchange=()=>{for(const engine of engines)engine.scene.setView($('view').value);};
window.comparison={load,advance,result,interrupt,play,pause:()=>{playing=false;},setView(view){$('view').value=view;for(const engine of engines)engine.scene.setView(view);}};
requestAnimationFrame(animate);
await load(new URLSearchParams(location.search).get('case') || 'short-03');
window.comparison.ready=true;
