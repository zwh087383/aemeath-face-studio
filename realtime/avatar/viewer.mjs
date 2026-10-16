import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { MMDLoader, MMDAnimationHelper } from '@takahirox/three-mmd';
import { FaceController } from '/preview/core/controller.js';
import { LipTrack } from '/preview/core/lip-track.js';
import { ACTIONS, AEMEATH_BINDINGS, PRESETS, PRESET_BY_ID, VOWELS } from '/preview/core/profile.js';
import { MotionController } from '/preview/core/motion-controller.js';
import { GESTURES, GESTURE_IDS } from '/preview/core/motion-profile.js';
import { MotionRig, skeletonFromMesh } from '/preview/studio/motion-rig.js';
import { AvatarSession } from './session.mjs';

const $ = id => document.getElementById(id);
const wall = () => performance.now() / 1000;
const bounded = (a, value, limit = 4000) => { a.push(value); if (a.length > limit) a.splice(0, a.length - limit); };
const percentile = (a, p) => { if (!a.length) return 0; const sorted = [...a].sort((x, y) => x - y); return sorted[Math.floor((sorted.length - 1) * p)]; };
const face = new FaceController(); face.headSway = false;
const stage = $('stage');
const VIEWS = { face: { height: 5.1, y: 18.15, yaw: 0 }, body: { height: 12.4, y: 14.7, yaw: 0 }, angle: { height: 12.4, y: 14.7, yaw: .62 } };
const PHASES = { prepare: '准备', stroke: '重点', hold: '保持', recover: '收回', retract: '收势', done: '结束' };
let renderer, scene, camera, mesh, helper, motion, rig, session, sample, lips, context, baseBones;
let ready = false, error = null, view = 'body', lastFrame = 0, lastUI = 0, frames = 0, cueSerial = 0;
let subtitleTimer = null, subtitleToken = 0, displayedSubtitle = '', lastInterrupt = null, currentOptions = {};
let rendered = { frame: 0, mouthOpen: 0, morphWeights: [], bones: {}, missingBindings: [], finite: true };
let environment = {}, measurement = null;
const samples = [], interruptions = [], measurements = [];
const boundary = 'Experimental local PMX renderer with real controllers, Worker and Web Audio; independent test subtitles; lip track belongs only to chinese-probe.wav. No cloud, microphone, live lip inference, physical speaker latency or clothing/hair physics.';

function stopSubtitles() { ++subtitleToken; clearTimeout(subtitleTimer); subtitleTimer = null; }
function reportError(cause) {
  error = cause?.message || String(cause); $('message').textContent = `操作失败：${error}`;
  console.error(cause); stopSubtitles(); session?.cancel('avatar_error');
}
function optionsFromUI() { return { sidecar: $('sidecar').checked, profile: $('profile').value, starve: $('starve').checked, chunkMs: 20, autoSubtitles: true }; }
function pushSubtitle(text, options) {
  const result = session?.pushSubtitle(text, options) || { accepted: false, reason: 'not_ready' };
  if (result.accepted) displayedSubtitle = (displayedSubtitle + text).slice(-2048);
  return result;
}
function feedSubtitles(owner) {
  const token = ++subtitleToken, text = Array.from($('subtitle-input').value.slice(0, 1024)); let position = 0;
  const feed = () => {
    if (token !== subtitleToken || owner.epoch !== session.owner?.epoch) return;
    // This is a paced local transcript simulator. Keep its arrival cursor with
    // a user pause; otherwise several sentences acquire the same frozen anchor.
    if (session.audio.snapshot().status === 'paused') { subtitleTimer = setTimeout(feed, 300); return; }
    if (position >= text.length) { session.finishSubtitles(owner); return; }
    pushSubtitle(text.slice(position, position + 2).join(''), { owner }); position += 2;
    subtitleTimer = setTimeout(feed, 300);
  };
  subtitleTimer = setTimeout(feed, 250);
}
async function start(options = optionsFromUI()) {
  if (!ready) return false;
  stopSubtitles(); displayedSubtitle = ''; error = null;
  currentOptions = { ...options, autoSubtitles: !!options.autoSubtitles };
  const accepted = await session.start(sample, currentOptions);
  if (!accepted) { $('message').textContent = '回复未启动，请查看运行记录。'; return false; }
  if (currentOptions.autoSubtitles && currentOptions.sidecar !== false) feedSubtitles({ ...session.owner });
  $('message').textContent = `第 ${session.owner.epoch} 轮：语音、口型和动作共用播放时钟。`;
  return true;
}
function pause() { const result = session?.pause() || false; $('message').textContent = result ? '已暂停：语音动作和测试字幕进度冻结，嘴型收回。' : '当前没有可暂停的回复。'; return result; }
async function resume() { const result = await session?.resume(); $('message').textContent = result ? '恢复同一回复。' : '当前回复不能恢复，请开始新一轮。'; return !!result; }
function cancel(reason = 'barge_in') {
  stopSubtitles();
  if (!session) return false;
  const before = motion.snapshot(), epoch = session.owner?.epoch, time = wall(), audioTime = session.audio.snapshot().time;
  const result = session.cancel(reason);
  const after = session.snapshot();
  if (result) {
    lastInterrupt = { epoch, reason, atWall: time, audioTime, handlerMs: (wall() - time) * 1000,
      stageAtCancel: before.gestures.filter(g => !g.recovering).map(g => ({ id: g.id, gesture: g.gesture, phase: g.phase, age: g.age })),
      mouthBefore: rendered.mouthOpen, mouthClosedMs: null, retractStartedMs: null, retractCompleteMs: null,
      sourceCountAfter: after.audio.sourceCount, queuedAfter: after.scheduler.queued, bodyQueuedAfter: motion.snapshot().queued,
      boundary: 'Morph and gesture state after submitted renders; not measured acoustic silence or photographed pixel timing.' };
    bounded(interruptions, lastInterrupt, 24);
  }
  $('message').textContent = '已打断：停止音频，角色收口、收势并转为倾听。';
  return result;
}
function enqueue(cue, owner = session?.owner) {
  if (!session) return { accepted: false, reason: 'not_ready' };
  return session.enqueue({ ...cue, id: cue.id || `avatar:${++cueSerial}`, at: cue.at ?? session.audio.snapshot().time + .06 }, owner);
}
function manualCue(cue) {
  const result = enqueue(cue);
  $('message').textContent = result.accepted ? '已交给统一调度器，按播放进度执行。' : `提示未入队：${result.reason}。请先开始播放。`;
  return result;
}
async function scriptedTour() {
  if (!await start({ ...optionsFromUI(), sidecar: false, autoSubtitles: false })) return false;
  for (const [index, gesture] of ['wave', 'explain', 'shrug', 'chest'].entries()) {
    enqueue({ id: `tour:${session.owner.epoch}:${gesture}`, kind: 'gesture', gesture, strength: .75, at: .2 + index * 4.6 });
    enqueue({ id: `tour-face:${session.owner.epoch}:${index}`, kind: 'expression', preset: ['happy', 'focus', 'curious', 'shy'][index], strength: .7, at: .2 + index * 4.6 });
  }
  $('message').textContent = '四种手势依次进入同一调度器。最后的动作在语音结束后自然收尾。';
  return true;
}
function setView(next) { if (!Object.hasOwn(VIEWS, next)) return false; view = next; resize(); for (const b of $('views').children) b.setAttribute('aria-pressed', String(b.dataset.view === next)); return true; }
function setIdle(value) { $('idle').checked = !!value; }
function setNatural(value) { $('natural').checked = !!value; motion?.setOptions({ natural: !!value }); }
function resize() {
  if (!renderer) return;
  const w = stage.clientWidth, h = stage.clientHeight, v = VIEWS[view], aspect = w / h;
  renderer.setSize(w, h); camera.left = -v.height * aspect / 2; camera.right = v.height * aspect / 2; camera.top = v.height / 2; camera.bottom = -v.height / 2;
  camera.position.set(30 * Math.sin(v.yaw), v.y, 30 * Math.cos(v.yaw)); camera.lookAt(0, v.y, 0); camera.updateProjectionMatrix();
}
function performanceSummary(since = -Infinity) {
  const rows = samples.filter(row => row.at >= since), values = key => rows.map(row => row[key]);
  const frameMean = rows.length ? values('frame').reduce((a, b) => a + b, 0) / rows.length : 0;
  return { samples: rows.length, driverP95Ms: percentile(values('driver'), .95), motionP95Ms: percentile(values('motion'), .95),
    faceP95Ms: percentile(values('face'), .95), syncP95Ms: percentile(values('sync'), .95), rigP95Ms: percentile(values('rig'), .95),
    renderSubmitP95Ms: percentile(values('render'), .95), frameP95Ms: percentile(values('frame'), .95), fps: frameMean ? 1000 / frameMean : 0,
    longFrames: rows.filter(row => row.frame > 50).length, viewport: { width: stage.clientWidth, height: stage.clientHeight, dpr: renderer?.getPixelRatio(), view },
    naturalMotion: $('natural').checked, physics: false, automaticSpeechBeat: false,
    boundary: 'CPU driver includes sync, lip sampling, face, motion and rig writes; render submission excludes GPU completion; RAF cadence is not an acoustic measurement.' };
}
function snapshot() {
  return { ready, error, boundary, session: session?.snapshot(), face: face.snapshot(), motion: motion?.snapshot(), rendered,
    performance: performanceSummary(), environment, lastInterrupt, interruptions: interruptions.map(x => ({ ...x })), measurements: [...measurements], displayedSubtitle };
}
function measure(seconds = 30) {
  if (measurement) return Promise.reject(new Error('已有采样正在运行'));
  const duration = Math.max(1, Math.min(45, Number(seconds) || 30)), since = performance.now();
  return new Promise(resolve => { measurement = { since, until: since + duration * 1000, resolve }; $('message').textContent = `采样 ${duration} 秒，保持画面可见。`; });
}
function observe(command) { if (command.type === 'stop_audio') stopSubtitles(); }
function captureRendered() {
  const bones = {};
  for (const [key, name] of [['head', '頭'], ['neck', '首'], ['leftWrist', '左手首'], ['rightWrist', '右手首']]) {
    const b = mesh.skeleton.bones.find(bone => bone.name === name);
    if (!b) continue;
    bones[key] = { position: b.getWorldPosition(new THREE.Vector3()).toArray(), quaternion: b.getWorldQuaternion(new THREE.Quaternion()).toArray() };
  }
  const weights = Array.from(mesh.morphTargetInfluences);
  const mouthOpen = VOWELS.reduce((sum, i) => sum + weights[AEMEATH_BINDINGS[i][0]], 0);
  rendered = { frame: ++frames, mouthOpen, morphWeights: weights, bones, missingBindings: [...(rig.missing || [])],
    finite: weights.every(Number.isFinite) && Object.values(bones).every(b => [...b.position, ...b.quaternion].every(Number.isFinite)) };
  if (rendered.missingBindings.length) throw new Error(`骨骼绑定缺失：${rendered.missingBindings.join(',')}`);
  if (!rendered.finite) throw new Error('检测到无效骨骼或表情数值');
}
function updateUI() {
  const s = snapshot(), a = s.session?.audio, f = s.face, body = s.motion;
  if (!a || !body) return;
  const labels = { idle: '安静陪伴', playing: '正在说话', paused: '已暂停', buffering: '等待续包', cancelled: '倾听中', ended: '说完了' };
  $('state').textContent = labels[a.status] || a.status;
  $('expression-name').textContent = PRESET_BY_ID[f.preset]?.name || f.preset;
  $('gesture-name').textContent = body.gestures.length ? body.gestures.map(g => `${g.name} · ${PHASES[g.phase] || g.phase}`).join(' / ') : `${body.postureName} · ${$('natural').checked ? '呼吸' : '静止'}`;
  $('time').textContent = `${a.time.toFixed(2)} / ${(sample.samples.length / sample.sampleRate).toFixed(2)} s`;
  $('progress').value = a.time / (sample.samples.length / sample.sampleRate);
  $('fps').textContent = s.performance.fps.toFixed(1); $('driver').textContent = s.performance.driverP95Ms.toFixed(2);
  $('mouth').textContent = rendered.mouthOpen.toFixed(3); $('epoch').textContent = String(a.epoch);
  $('live-subtitle').textContent = displayedSubtitle || '等待测试字幕…';
  $('sidecar-state').textContent = `旁路 ${s.session.sidecar.status}`;
  $('motion-phase').textContent = body.gestures.map(g => `${g.gesture}:${g.phase}`).join(' / ') || '没有进行中的手势';
  $('diagnostics').textContent = JSON.stringify({ audio: { status: a.status, time: a.time, sources: a.sourceCount }, scheduler: { status: s.session.scheduler.status, queued: s.session.scheduler.queued, fault: s.session.scheduler.fault }, sidecar: s.session.sidecar, performance: s.performance, lastInterrupt, environment }, null, 2);
  const recent = (s.session.events || []).filter(e => e.type !== 'playback').slice(-8).reverse();
  $('events').replaceChildren(...recent.map(e => { const li = document.createElement('li'); li.textContent = `${e.type} ${e.cue?.gesture || e.cue?.action || e.cue?.preset || e.reason || e.status || ''}`; return li; }));
  if (lastInterrupt) $('interrupt-result').textContent = `最近打断：收口 ${lastInterrupt.mouthClosedMs === null ? '…' : lastInterrupt.mouthClosedMs.toFixed(0) + ' ms'} · 收势 ${lastInterrupt.retractCompleteMs === null ? '进行中' : lastInterrupt.retractCompleteMs.toFixed(0) + ' ms'}。状态测量不等于物理停声。`;
  for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.preset === f.preset));
}
function frame(now) {
  requestAnimationFrame(frame); if (!ready || error) return;
  const interval = lastFrame ? now - lastFrame : 16.67, dt = Math.min(interval / 1000, .1); lastFrame = now;
  try {
    const started = performance.now(), audio = session.sync(), synced = performance.now();
    if (audio.status === 'ended') stopSubtitles();
    const lip = audio.status === 'playing' ? lips.sample(audio.time) : null;
    const weights = face.update(now / 1000, dt, lip, $('idle').checked), faced = performance.now();
    // The semantic scheduler owns all large gestures. Keep breathing/micro-motion
    // but do not also generate the controller's independent energy-triggered beat.
    motion.update(now / 1000, dt, { face: face.head, actions: face.activeActions, speech: 0 });
    const moved = performance.now();
    mesh.morphTargetInfluences.fill(0);
    for (let i = 0; i < AEMEATH_BINDINGS.length; i++) mesh.morphTargetInfluences[AEMEATH_BINDINGS[i][0]] = weights[i];
    for (const [bone, rest] of baseBones) bone.quaternion.copy(rest);
    rig.apply(motion.locals); const assigned = performance.now();
    helper.update(dt); mesh.updateMatrixWorld(true); renderer.render(scene, camera); const submitted = performance.now();
    captureRendered();
    if (!document.hidden) bounded(samples, { at: now, frame: interval, sync: synced - started, face: faced - synced, motion: moved - faced, rig: assigned - moved, driver: assigned - started, render: submitted - assigned });
    if (lastInterrupt && lastInterrupt.epoch === session.owner?.epoch) {
      const elapsed = wall() * 1000 - lastInterrupt.atWall * 1000, body = motion.snapshot();
      if (lastInterrupt.mouthClosedMs === null && rendered.mouthOpen <= .01) lastInterrupt.mouthClosedMs = elapsed;
      if (lastInterrupt.retractStartedMs === null && (body.recovering || !lastInterrupt.stageAtCancel.length)) lastInterrupt.retractStartedMs = elapsed;
      if (lastInterrupt.retractCompleteMs === null && !body.recovering && !body.gestures.length) lastInterrupt.retractCompleteMs = elapsed;
    }
    if (measurement && now >= measurement.until) { const run = measurement; measurement = null; const result = { ...performanceSummary(run.since), seconds: (now - run.since) / 1000 }; bounded(measurements, result, 12); run.resolve(result); $('message').textContent = '测量完成，可导出记录。'; }
    if (now - lastUI > 160) { updateUI(); lastUI = now; }
  } catch (cause) { reportError(cause); }
}

for (const p of PRESETS) { const b = document.createElement('button'); b.textContent = p.name; b.dataset.preset = p.id; b.onclick = () => manualCue({ kind: 'expression', preset: p.id, strength: .85 }); $('presets').append(b); }
for (const [id, a] of Object.entries(ACTIONS)) { const b = document.createElement('button'); b.textContent = a.name; b.dataset.action = id; b.onclick = () => manualCue({ kind: 'action', action: id, strength: .7 }); $('actions').append(b); }
for (const id of GESTURE_IDS) { const b = document.createElement('button'); b.textContent = GESTURES[id].name; b.dataset.gesture = id; b.onclick = () => manualCue({ kind: 'gesture', gesture: id, strength: .75 }); $('gestures').append(b); }
for (const [id, name] of [['face', '脸部'], ['body', '上身'], ['angle', '侧前']]) { const b = document.createElement('button'); b.textContent = name; b.dataset.view = id; b.setAttribute('aria-pressed', String(id === view)); b.onclick = () => setView(id); $('views').append(b); }
const safe = fn => () => { Promise.resolve().then(fn).catch(reportError); };
$('start').onclick = () => start().catch(reportError); $('replace').onclick = () => start(currentOptions).catch(reportError);
$('pause').onclick = safe(pause); $('resume').onclick = () => resume().catch(reportError); $('cancel').onclick = safe(() => cancel());
$('scripted').onclick = () => scriptedTour().catch(reportError);
$('send').onclick = () => { const result = pushSubtitle($('subtitle-input').value); $('message').textContent = `字幕投递：${result.reason}`; };
$('volume').oninput = () => session?.audio.setVolume(Number($('volume').value));
$('natural').onchange = () => setNatural($('natural').checked);
$('measure').onclick = () => measure().catch(reportError);
$('export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `avatar-integration-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
document.addEventListener('visibilitychange', () => { if (document.hidden && ['playing', 'buffering', 'paused'].includes(session?.audio.snapshot().status)) cancel('page_hidden'); });
window.addEventListener('pagehide', () => { stopSubtitles(); session?.dispose(); });
window.avatarLab = { get ready() { return ready; }, start, pause, resume, cancel, replace: options => start(options || currentOptions), enqueue, pushSubtitle,
  finishSubtitles: owner => session?.finishSubtitles(owner), snapshot, setView, setIdle, setNatural, measure, scriptedTour };

const readJSON = async url => { const response = await fetch(url); if (!response.ok) throw new Error(`资源读取失败 ${url}: ${response.status}`); return response.json(); };
try {
  const [data, waveform, bytes] = await Promise.all([readJSON('/data/chinese-probe.json'), readJSON('/data/waveform.json'), fetch('/sample.wav').then(r => { if (!r.ok) throw new Error('本地音频不可用'); return r.arrayBuffer(); })]);
  context = new AudioContext({ latencyHint: 'interactive' }); const buffer = await context.decodeAudioData(bytes);
  if (Math.abs(buffer.duration - data.audio_seconds) > .03) throw new Error('音频和口型曲线时长不匹配');
  const pcm = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) { const source = buffer.getChannelData(ch); for (let i = 0; i < pcm.length; i++) pcm[i] += source[i] / buffer.numberOfChannels; }
  sample = { samples: pcm, sampleRate: buffer.sampleRate }; lips = new LipTrack(data, waveform);
  scene = new THREE.Scene(); camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 150);
  renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setClearColor(0, 0);
  await renderer.init(); renderer.toneMapping = THREE.NeutralToneMapping; stage.prepend(renderer.domElement); resize(); new ResizeObserver(resize).observe(stage);
  scene.add(new THREE.AmbientLight(0xffffff, 1.15)); const key = new THREE.DirectionalLight(0xfff2ed, 1.4); key.position.set(-3, 8, 10); scene.add(key);
  const fill = new THREE.DirectionalLight(0xd3d9ff, .25); fill.position.set(7, 4, 5); scene.add(fill);
  const manager = new THREE.LoadingManager(); manager.onProgress = (_url, done, total) => { $('load-note').textContent = `读取模型贴图 ${done} / ${total}`; };
  mesh = await new MMDLoader(manager).loadAsync('/model/' + encodeURIComponent('鸣潮_爱弥斯1.05.pmx'));
  for (const [index, name] of AEMEATH_BINDINGS) if (mesh.geometry.morphTargets[index]?.name !== name) throw new Error(`模型表情绑定不匹配：${name}`);
  motion = new MotionController({ skeleton: skeletonFromMesh(mesh) }); motion.setOptions({ natural: $('natural').checked, intensity: 1, speed: 1 });
  rig = new MotionRig(mesh);
  helper = new MMDAnimationHelper(); helper.add(mesh, { physics: false }); helper.enable('ik', false);
  baseBones = mesh.skeleton.bones.map(b => [b, b.quaternion.clone()]); mesh.frustumCulled = false; scene.add(mesh);
  session = new AvatarSession({ context, face, motion, clock: wall, onEvent: observe }); session.audio.setVolume(Number($('volume').value));
  $('load-note').textContent = '编译人物材质…'; await renderer.compileAsync(scene, camera);
  const gl = renderer.backend?.gl, debug = gl?.getExtension('WEBGL_debug_renderer_info');
  environment = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, sampleRate: buffer.sampleRate,
    webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable', renderer: 'WebGPURenderer forceWebGL', physics: false };
  ready = true; $('loading').style.display = 'none';
  for (const id of ['start', 'pause', 'resume', 'cancel', 'replace', 'send', 'scripted', 'measure']) $(id).disabled = false;
  $('message').textContent = '人物就绪。点击开始，让流式字幕选择她的表情和动作。'; requestAnimationFrame(frame);
} catch (cause) { $('load-note').textContent = cause.message; $('state').textContent = '加载失败'; reportError(cause); }
