import { RealtimeScheduler } from '../scheduler.mjs';
import { StreamingAudioTransport } from '../stream-audio.mjs';
import { SubtitleSidecar } from '../subtitle-sidecar.mjs';

const $ = id => document.getElementById(id);
const wall = () => performance.now() / 1000;
const evidenceBoundary = '实验性：本地 WAV 分块 + 独立测试字幕（不代表此音频转写）；真实 Web Audio 与 Worker；动作执行为命令记录，未接角色、麦克风或云端。';
let context, transport, samplePromise, identity = null, oldIdentity = null;
let epoch = 0, requestToken = 0, feedTimer = null, packetCount = 0, providerFinished = false;
let duration = 0, currentOptions = {}, starvationInjected = false, lastAudioStatus = '', error = null;
let frameCount = 0, maxSources = 0, lastFrame = 0, lastUi = 0, lastRenderedEvent = 0;
let benchmark = null, lastBenchmark = null, lastInterrupt = null;
let sidecar = null, subtitleTimer = null, subtitleSequence = 0, subtitleText = '', lastCue = null;
let appendCount = 0, subtitlePushCount = 0, firstPlayingWall = null;
const appendCosts = [], subtitlePushCosts = [], subtitleEvents = [];
const events = [], costs = [], intervals = [], statusHistory = [];
let eventSerial = 0;
const boundedPush = (array, item, max = 4096) => { array.push(item); if (array.length > max) array.splice(0, array.length - max); };
const percentile = (values, p) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]; };
const message = text => { $('message').textContent = text; };
function log(type, detail = {}) {
  boundedPush(events, { n: ++eventSerial, wall: wall(), type, ...detail }, 180);
}
function stopFeed() { if (feedTimer !== null) clearTimeout(feedTimer); feedTimer = null; }
function stopSubtitles() { clearTimeout(subtitleTimer); subtitleTimer = null; }
function acceptCommand(command) {
  if (command.type === 'stop_audio') {
    stopFeed(); stopSubtitles(); sidecar?.cancel(command.identity);
    const result = transport?.cancel();
    if (result === false) return false;
  }
  if (command.type === 'cue') lastCue = command.cue;
  if (command.type === 'retract') lastCue = null;
  if (command.type !== 'playback' || command.status !== lastAudioStatus) {
    log(command.type, { identity: command.identity, cue: command.cue, posture: command.posture, status: command.status, reason: command.reason });
  }
  return true;
}
const scheduler = new RealtimeScheduler({ clock: wall, emit: acceptCommand });

function reportError(value) {
  const nextError = value?.message || String(value);
  if (error === nextError) return;
  error = nextError;
  message(`操作失败：${error}`);
  log('lab_error', { error });
}
function safe(action) { return Promise.resolve().then(action).catch(reportError); }
async function prepareAudio() {
  if (!context) {
    context = new AudioContext({ latencyHint: 'interactive' });
    transport = new StreamingAudioTransport(context, { volume: Number($('volume').value), maxBufferedSeconds: 20 });
  }
  // Call resume in the originating button event before network/decode awaits.
  const resumed = context.resume();
  samplePromise ||= fetch('/sample.wav').then(response => {
    if (!response.ok) throw new Error(`本地音频不可用 (${response.status})`);
    return response.arrayBuffer();
  }).then(bytes => context.decodeAudioData(bytes)).then(buffer => {
    const samples = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const input = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] += input[i] / buffer.numberOfChannels;
    }
    return { samples, sampleRate: buffer.sampleRate, duration: buffer.duration };
  }).catch(cause => { samplePromise = null; throw cause; });
  await resumed;
  return samplePromise;
}
function readOptions() { return { chunkMs: Number($('chunk').value), providerFast: $('fast').checked, starve: $('starve').checked,
  sidecar: $('sidecar-enabled').checked, autoSubtitles: true, profile: $('profile').value, workerMode: $('worker-mode').value }; }
// Fault injection is confined to the lab. The real rule Worker still runs off-thread.
// Dropped replies simulate a hung worker, without blocking or delaying the PCM path.
function labWorkerFactory(mode) {
  const worker = new Worker(new URL('../subtitle-worker.mjs', import.meta.url), { type: 'module' });
  if (mode === 'normal') return worker;
  const timers = new Set();
  const proxy = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: data => worker.postMessage(data),
    terminate() { for (const timer of timers) clearTimeout(timer); timers.clear(); worker.terminate(); }
  };
  worker.onmessage = event => {
    if (mode === 'stalled') return;
    const timer = setTimeout(() => { timers.delete(timer); proxy.onmessage?.(event); }, 800);
    timers.add(timer);
  };
  worker.onerror = event => proxy.onerror?.(event);
  worker.onmessageerror = event => proxy.onmessageerror?.(event);
  return proxy;
}
function pushSubtitle(text, options = {}) {
  const before = performance.now();
  const owner = options.owner || identity;
  const sequence = options.sequence ?? subtitleSequence++;
  const input = { ...owner, itemId: options.itemId || 'lab-transcript', sequence, text };
  let result;
  try { result = currentOptions.sidecar && sidecar ? sidecar.push(input) : { accepted: false, reason: 'sidecar_off' }; }
  catch { result = { accepted: false, reason: 'sidecar_exception' }; sidecar?.dispose(); sidecar = null; }
  boundedPush(subtitlePushCosts, performance.now() - before); subtitlePushCount++;
  if (result.accepted) subtitleText = (subtitleText + text).slice(-2048);
  return result;
}
function finishSubtitles(owner = identity) { return currentOptions.sidecar ? sidecar?.finish(owner) ?? false : false; }
function feedSubtitles(token, target) {
  const chunks = Array.from($('subtitle-input').value.slice(0, 1024));
  let offset = 0;
  function feed() {
    subtitleTimer = null;
    if (token !== requestToken || identity?.epoch !== target.epoch) return;
    if (offset >= chunks.length) { finishSubtitles(target); return; }
    pushSubtitle(chunks.slice(offset, offset + 3).join(''), { owner: target }); offset += 3;
    subtitleTimer = setTimeout(feed, 320);
  }
  subtitleTimer = setTimeout(feed, 250);
}
function enqueue(cue, target = identity) {
  if (!target) return { accepted: false, reason: 'no_response' };
  const result = scheduler.enqueue({ ...target, ...cue });
  log('enqueue', { id: cue.id, result });
  return result;
}
function feedSample(sample, token, target, options) {
  const frameSize = Math.round(sample.sampleRate * options.chunkMs / 1000);
  let offset = 0, sequence = 0;
  const jitter = [-6, 4, -3, 2, 0];
  function feed() {
    feedTimer = null;
    if (token !== requestToken || identity?.epoch !== target.epoch) return;
    const batches = options.providerFast ? 24 : 1;
    for (let n = 0; n < batches && offset < sample.samples.length; n++) {
      const end = Math.min(sample.samples.length, offset + frameSize);
      const pcm = sample.samples.slice(offset, end);
      const appendStarted = performance.now();
      const accepted = transport.append({ epoch: target.epoch, sequence, samples: pcm });
      boundedPush(appendCosts, performance.now() - appendStarted); appendCount++;
      if (!accepted) {
        reportError(new Error('PCM 分块未被播放器接收；停止本次输入'));
        cancel('append_rejected');
        return;
      }
      offset = end; sequence++; packetCount++;
    }
    if (offset === sample.samples.length) {
      providerFinished = true;
      scheduler.providerDone(target);
      if (!transport.finish(target.epoch)) reportError(new Error('无法标记音频输入结束'));
      log('input_finished', { epoch: target.epoch, receivedDuration: sample.duration });
      return;
    }
    let delay = options.providerFast ? 0 : Math.max(1, options.chunkMs + jitter[sequence % jitter.length]);
    if (options.starve && !starvationInjected && offset / sample.sampleRate >= 1.0) {
      starvationInjected = true; delay += 1200;
      log('network_gap', { durationMs: 1200, epoch: target.epoch });
    }
    feedTimer = setTimeout(feed, delay);
  }
  feed();
}

async function start(options = readOptions()) {
  const token = ++requestToken;
  stopFeed(); stopSubtitles(); error = null;
  // Natural audio end does not emit scheduler stop_audio on the next begin.
  // Explicitly retire the old observer even when the next reply has it off.
  if (identity) sidecar?.cancel(identity);
  const sample = await prepareAudio();
  if (token !== requestToken) return false;
  oldIdentity = identity;
  const next = { connectionId: 'local-wav-stream', responseId: `local-response-${epoch + 1}`, epoch: ++epoch };
  // Replacement must cancel the OLD transport before the new transport is created.
  if (!scheduler.begin(next)) throw new Error('调度器未接受新回复；检查故障状态');
  if (!transport.begin(next.epoch, { sampleRate: sample.sampleRate })) throw new Error('播放器未接受新代次');
  identity = next;
  providerFinished = false; packetCount = 0; starvationInjected = false; duration = sample.duration;
  currentOptions = { chunkMs: options.chunkMs === 20 ? 20 : 40, starve: !!options.starve, providerFast: !!options.providerFast && !options.starve,
    sidecar: options.sidecar !== false, autoSubtitles: !!options.autoSubtitles, scriptedCues: options.scriptedCues !== false,
    profile: ['gentle', 'balanced', 'lively'].includes(options.profile) ? options.profile : 'balanced',
    workerMode: ['normal', 'slow', 'stalled'].includes(options.workerMode) ? options.workerMode : 'normal' };
  subtitleSequence = 0; subtitleText = ''; lastCue = null; subtitleEvents.length = 0;
  appendCount = 0; subtitlePushCount = 0; firstPlayingWall = null; appendCosts.length = 0; subtitlePushCosts.length = 0;
  if (currentOptions.sidecar) {
    // Retain session cooldowns across reply replacement and optional off/on trials.
    sidecar ||= new SubtitleSidecar({ scheduler, clock: wall, workerFactory: () => labWorkerFactory(currentOptions.workerMode),
      onDecision: event => { boundedPush(subtitleEvents, { wall: wall(), ...event }, 100); log('subtitle_decision', { status: event.status, reason: event.reason }); } });
    // Failure only disables this optional observer; audio startup remains independent.
    sidecar.begin(next, { profile: currentOptions.profile });
  }
  lastAudioStatus = '';
  if (!currentOptions.sidecar && currentOptions.scriptedCues) {
  enqueue({ id: `${epoch}:smile`, kind: 'expression', preset: 'smile', at: 0.08 });
  enqueue({ id: `${epoch}:wave`, kind: 'gesture', gesture: 'wave', at: 0.3, strength: 0.65 });
  enqueue({ id: `${epoch}:nod`, kind: 'action', action: 'nod', at: 1.1, strength: 0.45 });
  enqueue({ id: `${epoch}:explain`, kind: 'gesture', gesture: 'explain', at: 3.6, strength: 0.55 });
  enqueue({ id: `${epoch}:chest`, kind: 'gesture', gesture: 'chest', at: 7.0, strength: 0.4 });
  }
  if (!await transport.play()) throw new Error('浏览器未启动音频，请点击“开始本地流”');
  if (token !== requestToken || identity?.epoch !== next.epoch) return false;
  feedSample(sample, token, next, currentOptions);
  if (currentOptions.sidecar && currentOptions.autoSubtitles) feedSubtitles(token, next);
  message(`回复 ${next.epoch} 已开始 · ${currentOptions.chunkMs} ms 分块${currentOptions.starve ? '，将在约 1 秒输入后断流' : currentOptions.providerFast ? '，快速收完但继续播放' : '，带少量到达抖动'}。`);
  return true;
}
function synchronize() {
  if (!transport) return;
  const audio = transport.snapshot();
  if (audio.status === 'playing' && firstPlayingWall === null) firstPlayingWall = wall();
  if (identity && audio.epoch === identity.epoch && ['buffering', 'playing', 'paused', 'ended'].includes(audio.status)) {
    const previous = scheduler.snapshot();
    const alreadyDrained = audio.status === 'ended' && previous.status === 'ended' && audio.time === previous.time;
    if (!alreadyDrained && !scheduler.playback({ ...identity, status: audio.status, time: audio.time })) {
      // A rejected player clock is a failed integration, never an invisible success.
      stopFeed(); ++requestToken;
      scheduler.interrupt({ ...identity, reason: 'playback_snapshot_rejected' });
      reportError(new Error(`播放器快照被调度器拒绝：${previous.status}@${previous.time} → ${audio.status}@${audio.time}`));
      return;
    }
  }
  if (audio.status !== lastAudioStatus) {
    boundedPush(statusHistory, { status: audio.status, epoch: audio.epoch, time: audio.time, wall: wall() }, 100);
    log('audio_status', { status: audio.status, time: audio.time, epoch: audio.epoch });
    lastAudioStatus = audio.status;
  }
  scheduler.tick();
  const fault = scheduler.snapshot().fault || audio.fault;
  if (fault) reportError(new Error(`驱动故障：${fault}`));
  maxSources = Math.max(maxSources, audio.sourceCount || 0);
}
function pause() {
  if (!transport) return false;
  const result = transport.pause();
  synchronize(); message('已暂停：媒体时钟与语义进度冻结，已排程音频节点停止。');
  return result !== false;
}
async function resume() {
  if (!transport) return false;
  const token = requestToken;
  const result = await transport.resume();
  if (token !== requestToken) return false;
  synchronize(); message(result ? '恢复同一回复，继续剩余音频与动作时间线。' : '当前回复不能恢复；请开始新回复。');
  return result;
}
function cancel(reason = 'barge_in') {
  ++requestToken; stopFeed(); stopSubtitles();
  if (!identity) { transport?.cancel(); return false; }
  oldIdentity = { ...identity };
  const before = performance.now();
  const result = scheduler.interrupt({ ...identity, reason });
  const elapsed = performance.now() - before;
  const after = transport?.snapshot();
  lastInterrupt = { epoch: identity.epoch, reason, handlerMs: elapsed, accepted: result, status: after?.status, sourceCountAfter: after?.sourceCount, sourceActiveAfter: after?.sourceActive, queueAfter: scheduler.snapshot().queued };
  log('interrupt_measurement', lastInterrupt);
  synchronize(); message('已打断：旧队列作废，音频停止，收势与倾听命令已送入测试替身。');
  return result;
}
function injectStale() {
  const stale = oldIdentity || { connectionId: 'local-wav-stream', responseId: 'old-missing-response', epoch: Math.max(1, epoch - 1) };
  const result = enqueue({ id: `stale:${performance.now()}`, kind: 'gesture', gesture: 'wave', at: 0.5 }, stale);
  message(`旧动作 ${result.accepted ? '被接受（需检查）' : '被拒绝'}：${result.reason || 'unknown'}`);
  return result;
}
function snapshot() {
  return {
    boundary: evidenceBoundary, identity, oldIdentity, providerFinished, packetCount, duration, options: currentOptions,
    audio: transport?.snapshot() || { status: 'idle', time: 0, receivedDuration: 0, queuedSeconds: 0, sourceCount: 0, sourceActive: false },
    scheduler: scheduler.snapshot(), events: [...events], statusHistory: [...statusHistory], lastInterrupt, error,
    sidecar: currentOptions.sidecar ? sidecar?.snapshot() || { status: 'off' } : { status: 'off' }, subtitleEvents: [...subtitleEvents], subtitleText, lastCue,
    performance: { frameCount, maxSources, sampleCount: costs.length, schedulerP95Ms: percentile(costs, .95), schedulerP99Ms: percentile(costs, .99), frameIntervalP95Ms: percentile(intervals, .95), lastBenchmark,
      appendCount, appendP95Ms: percentile(appendCosts, .95), subtitlePushCount, subtitlePushP95Ms: percentile(subtitlePushCosts, .95), firstPlayingWall }
  };
}
function runBenchmark(seconds = 30) {
  if (benchmark) return Promise.reject(new Error('已有采样正在运行'));
  const durationSeconds = Math.max(1, Math.min(60, Number(seconds) || 30));
  return new Promise(resolve => {
    benchmark = { start: wall(), end: wall() + durationSeconds, costs: [], playingCosts: [], intervals: [], statusFrames: {}, maxSources: 0, startFrames: frameCount, resolve };
    message(`正在采样 ${durationSeconds} 秒；可操作暂停、打断和替换。`);
  });
}
function exportEvidence() {
  const evidence = { generatedAt: new Date().toISOString(), ...snapshot() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `realtime-lab-${Date.now()}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return evidence;
}
function render() {
  const state = snapshot(), audio = state.audio;
  $('play-state').textContent = audio.status;
  $('generation').textContent = identity ? `epoch ${identity.epoch} · ${identity.responseId}` : 'epoch —';
  $('media-time').textContent = `${audio.time.toFixed(3)} s`;
  $('buffer').textContent = `队列 ${audio.queuedSeconds.toFixed(3)} s`;
  $('sources').textContent = String(audio.sourceCount);
  $('input-state').textContent = providerFinished ? '输入已结束 ≠ 播放已结束' : '输入未结束';
  $('cost').textContent = costs.length ? `${state.performance.schedulerP95Ms.toFixed(3)} ms` : '—';
  $('frames').textContent = `p95 · ${costs.length} 帧样本`;
  $('played').value = duration ? audio.time / duration : 0;
  $('received').value = duration ? audio.receivedDuration / duration : 0;
  $('duration').textContent = `${duration.toFixed(2)} s`;
  $('packets').textContent = `${packetCount} 包`;
  $('subtitle-live').textContent = subtitleText || '等待测试字幕…';
  $('sidecar-state').textContent = `${state.sidecar.status} · 累计 ${state.sidecar.counts?.queuedCues || 0} 条提示已排队 · push p95 ${state.performance.subtitlePushP95Ms.toFixed(3)} ms`;
  $('current-cue').textContent = lastCue ? `${lastCue.preset || lastCue.gesture || lastCue.action} · 强度 ${lastCue.strength}` : '等待动作命令';
  $('subtitle-reason').textContent = subtitleEvents.at(-1)?.reason || '分析在 Worker 内运行，语音不等待它完成';
  if (lastRenderedEvent !== eventSerial) {
    $('events').replaceChildren(...events.slice(-14).reverse().map(item => {
      const li = document.createElement('li');
      const name = document.createElement('b'); name.textContent = item.type;
      const body = document.createElement('span');
      const label = item.cue?.gesture || item.cue?.action || item.cue?.preset || item.posture || item.reason || item.status || item.result?.reason || item.error || '';
      body.textContent = `  ${label}  `;
      const meta = document.createElement('em'); meta.textContent = `@${item.wall.toFixed(2)}s${item.identity ? ` · e${item.identity.epoch}` : ''}`;
      li.append(name, body, meta); return li;
    }));
    lastRenderedEvent = eventSerial;
  }
  $('evidence').textContent = JSON.stringify({ audio: { status: audio.status, time: Number(audio.time.toFixed(3)), sourceCount: audio.sourceCount, finished: audio.finished }, scheduler: { status: state.scheduler.status, queued: state.scheduler.queued, fault: state.scheduler.fault }, sidecar: state.sidecar, lastInterrupt, lastBenchmark }, null, 2);
}
function frame(now) {
  const interval = lastFrame ? now - lastFrame : 0; lastFrame = now;
  const before = performance.now();
  try { synchronize(); } catch (cause) { reportError(cause); }
  const cost = performance.now() - before;
  if (transport) {
    boundedPush(costs, cost); if (interval) boundedPush(intervals, interval); frameCount++;
  }
  if (benchmark) {
    boundedPush(benchmark.costs, cost, 20000); if (interval) boundedPush(benchmark.intervals, interval, 20000);
    const audio = transport?.snapshot();
    const status = audio?.status || 'idle';
    benchmark.statusFrames[status] = (benchmark.statusFrames[status] || 0) + 1;
    if (status === 'playing') boundedPush(benchmark.playingCosts, cost, 20000);
    benchmark.maxSources = Math.max(benchmark.maxSources, audio?.sourceCount || 0);
    if (wall() >= benchmark.end) {
      const run = benchmark; benchmark = null;
      lastBenchmark = { seconds: wall() - run.start, frames: frameCount - run.startFrames, sampleCount: run.costs.length, statusFrames: run.statusFrames, schedulerP95Ms: percentile(run.costs, .95), schedulerP99Ms: percentile(run.costs, .99), playingP95Ms: run.playingCosts.length ? percentile(run.playingCosts, .95) : null, frameIntervalP95Ms: percentile(run.intervals, .95), maxSources: run.maxSources, boundary: evidenceBoundary };
      run.resolve(lastBenchmark); message('采样完成，可导出 JSON。耗时不含角色渲染。');
    }
  }
  if (now - lastUi > 180) { render(); lastUi = now; }
  requestAnimationFrame(frame);
}

$('start').addEventListener('click', () => { start().catch(reportError); });
$('pause').addEventListener('click', () => safe(pause));
$('resume').addEventListener('click', () => { resume().catch(reportError); });
$('cancel').addEventListener('click', () => safe(() => cancel()));
$('replace').addEventListener('click', () => { start(currentOptions).catch(reportError); });
$('stale').addEventListener('click', () => safe(injectStale));
$('volume').addEventListener('input', () => transport?.setVolume(Number($('volume').value)));
$('benchmark').addEventListener('click', () => { runBenchmark(30).catch(reportError); });
$('export').addEventListener('click', exportEvidence);
$('subtitle-send').addEventListener('click', () => { const result = pushSubtitle($('subtitle-input').value); message(`手动字幕：${result.reason}`); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['playing', 'buffering', 'paused'].includes(transport?.snapshot().status)) safe(() => cancel('page_hidden'));
});
window.realtimeLab = { start, pause, resume, cancel, replace: options => start(options || currentOptions), injectStale, enqueue, snapshot, runBenchmark, exportEvidence, pushSubtitle, finishSubtitles };
requestAnimationFrame(frame);
