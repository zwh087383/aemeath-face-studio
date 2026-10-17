import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveAvatarSession } from '../qwen/live-session.mjs';
import { FaceController } from '../../preview/core/controller.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';
import { createSubtitleWorkerHandler } from '../subtitle-worker.mjs';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(
  new URL('../../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const pcm = (seconds = .2, value = .15) => new Float32Array(Math.round(24000 * seconds)).fill(value);
const voiced = (seconds = .2) => Float32Array.from({ length: Math.round(24000 * seconds) },
  (_, frame) => .2 * Math.sin(2 * Math.PI * 220 * frame / 24000));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

class FakeContext {
  currentTime = 0; state = 'suspended'; destination = {}; sources = []; pendingResume = null;
  failStop = false; failResume = false;
  async resume() {
    if (this.pendingResume) await this.pendingResume;
    if (this.failResume) throw new Error('resume_failed');
    this.state = 'running';
  }
  createBuffer(channels, length, sampleRate) {
    assert.equal(channels, 1); const data = new Float32Array(length);
    return { length, duration: length / sampleRate, sampleRate, getChannelData: () => data };
  }
  createGain() {
    return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; } },
      connect() {}, disconnect() {} };
  }
  createBufferSource() {
    const context = this;
    const source = { onended: null, stopped: false, disconnected: false, connect() {},
      start(when, offset, duration) { Object.assign(this, { when, offset, duration }); },
      stop() { if (context.failStop) throw new Error('stop_failed'); this.stopped = true; },
      disconnect() { this.disconnected = true; } };
    this.sources.push(source); return source;
  }
  advance(seconds) {
    if (this.state === 'running') this.currentTime += seconds;
    for (const source of this.sources) {
      if (!source.stopped && source.onended && this.currentTime >= source.when + source.duration) source.onended();
    }
  }
}

class WorkerDouble {
  jobs = []; handler = createSubtitleWorkerHandler(); terminated = false;
  postMessage(job) { this.jobs.push(job); }
  terminate() { this.terminated = true; }
  complete() { const job = this.jobs.shift(); if (job) this.onmessage?.({ data: this.handler(job) }); }
}

function fixture(t, options = {}) {
  let now = 0;
  const context = new FakeContext(), face = new FaceController(), motion = new MotionController({ skeleton, seed: 42 });
  const workers = [], events = [];
  const session = new LiveAvatarSession({ context, face, motion, clock: () => now,
    workerFactory: () => { const worker = new WorkerDouble(); workers.push(worker); return worker; },
    onEvent: event => events.push(event), ...options });
  const render = dt => {
    const audio = session.sync();
    const visual = session.visualState(audio);
    face.update(now, dt, session.lipSample(audio), true, visual);
    motion.update(now, dt, { face: face.head, actions: face.activeActions, speech: 0, behavior: visual.behavior, paused: visual.paused });
    for (const quaternion of motion.locals.values()) assert.ok(quaternion.every(Number.isFinite));
  };
  const advance = seconds => {
    const end = now + seconds;
    while (now + 1e-9 < end) { const dt = Math.min(1 / 60, end - now); now += dt; context.advance(dt); render(dt); }
    return session.audio.snapshot();
  };
  const begin = async (responseId = 'r1', options = {}) => {
    if (!session.connectionId) assert.equal(session.setConnection('c1'), true);
    const owner = session.beginResponse({ connectionId: session.connectionId, responseId, ...options });
    assert.ok(owner); assert.equal(await session.playReady, true); return owner;
  };
  t.after(() => { context.failStop = false; session.dispose(); });
  return { session, context, face, motion, workers, events, advance, render, begin };
}

test('external PCM starts synchronously; generated completion does not drain queued playback', async t => {
  const f = fixture(t), owner = await f.begin();
  assert.equal(f.session.appendPcm({ owner, sequence: 0, samples: pcm() }), true);
  assert.equal(f.session.providerDone(owner), true);
  assert.equal(f.session.scheduler.generated, true);
  assert.equal(f.session.audio.snapshot().finished, false);
  assert.equal(f.session.finishAudio(owner), true);
  assert.equal(f.session.audio.snapshot().status, 'buffering');
  f.advance(.1);
  assert.equal(f.session.audio.status, 'playing');
  near(f.session.scheduler.time, f.session.audio.snapshot().time);
  near(f.face.time, f.motion.time);
  f.advance(.3);
  assert.equal(f.session.scheduler.status, 'ended');
  assert.equal(f.session.events.filter(event => event.type === 'playback_ended').length, 1);
  const commands = f.session.scheduler.counts.commands; f.advance(1);
  assert.equal(f.session.scheduler.counts.commands, commands);
  const timings = f.session.snapshot().timings;
  assert.ok(timings.firstPlaybackAt >= 40); assert.ok(timings.playbackEndedAt >= 240);
  assert.equal(timings.providerDoneAt, 0);
});

test('response.done after physical scheduling drain is diagnostic only and succeeds', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: pcm(.08) }); f.session.finishAudio(owner); f.advance(.2);
  assert.equal(f.session.scheduler.status, 'ended');
  const commands = f.session.scheduler.counts.commands;
  assert.equal(f.session.providerDone(owner), true);
  assert.equal(f.session.finishAudio(owner), true); assert.equal(f.session.finishSubtitles(owner), true);
  assert.equal(f.session.scheduler.counts.commands, commands);
  assert.equal(f.session.audio.snapshot().sourceCount, 0);
});

test('empty audio completes without manufacturing a first playback measurement', async t => {
  const f = fixture(t), owner = await f.begin();
  assert.equal(f.session.finishAudio(owner), true); f.session.sync();
  assert.equal(f.session.scheduler.status, 'ended');
  assert.equal(f.session.snapshot().timings.firstPlaybackAt, undefined);
  assert.equal(f.session.providerDone(owner), true);
});

test('connection installation and response tombstones reject old created events', async t => {
  const f = fixture(t), old = await f.begin();
  assert.equal(f.session.beginResponse({ connectionId: 'c1', responseId: 'r1' }), null);
  assert.equal(f.session.setConnection('c2'), true);
  assert.equal(f.session.setConnection('c1'), false);
  assert.equal(f.session.beginResponse({ connectionId: 'c1', responseId: 'late' }), null);
  const current = await f.begin('r1'); assert.ok(current.epoch > old.epoch);
  assert.equal(f.session.cancel('old_socket', old), false);
  assert.equal(f.session.owner, current); assert.equal(f.session.audio.status, 'buffering');
  assert.equal(f.session.appendPcm({ owner: old, sequence: 0, samples: pcm() }), false);
});

test('cancel fences a pending AudioContext resume and PCM already received during it', async t => {
  const f = fixture(t); let release;
  f.context.pendingResume = new Promise(resolve => { release = resolve; });
  f.session.setConnection('c1');
  const owner = f.session.beginResponse({ connectionId: 'c1', responseId: 'r1' });
  const pending = f.session.playReady;
  assert.equal(f.session.appendPcm({ owner, sequence: 0, samples: pcm() }), true);
  assert.equal(f.session.audio.snapshot().sourceCount, 0);
  assert.equal(f.session.cancel('during_resume', owner), true); release();
  assert.equal(await pending, false); assert.equal(f.session.audio.status, 'cancelled');
  assert.equal(f.context.sources.length, 0);
});

test('replacement fences old async playback, old worker results and every old terminal event', async t => {
  const f = fixture(t); let release;
  f.context.pendingResume = new Promise(resolve => { release = resolve; });
  f.session.setConnection('c1');
  const old = f.session.beginResponse({ connectionId: 'c1', responseId: 'r1' }), pending = f.session.playReady;
  f.session.appendPcm({ owner: old, sequence: 0, samples: pcm() });
  const current = f.session.beginResponse({ connectionId: 'c1', responseId: 'r2' });
  f.session.appendPcm({ owner: current, sequence: 0, samples: pcm() }); release();
  assert.equal(await pending, false); assert.equal(await f.session.playReady, true);
  assert.equal(f.session.finishAudio(old), false); assert.equal(f.session.providerDone(old), false);
  assert.equal(f.session.finishSubtitles(old), false); assert.equal(f.session.cancel('late', old), false);
  assert.equal(f.session.pushSubtitle('你好。', { owner: old, sequence: 0 }).accepted, false);
  assert.equal(f.session.audio.epoch, current.epoch); assert.equal(f.session.scheduler.fault, null);
});

test('transcript is visible immediately but analysis waits near its audio arrival boundary', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: pcm(1) });
  f.session.appendPcm({ owner, sequence: 1, samples: pcm(1) });
  const accepted = f.session.pushSubtitle('你好，很高兴见到你！', { owner, itemId: 'a', sequence: 0 });
  assert.equal(accepted.boundary, 1);
  assert.equal(f.events.at(-1).type, 'raw_subtitle'); assert.equal(f.workers[0].jobs.length, 0);
  f.session.finishSubtitles(owner); f.advance(.8);
  assert.equal(f.workers[0].jobs.length, 0); assert.equal(f.session.snapshot().pendingText, 1);
  f.advance(.25); assert.ok(f.workers[0].jobs.length > 0);
  f.workers[0].complete(); f.advance(.1);
  assert.ok(f.session.scheduler.counts.dispatched > 0);
  assert.equal(f.session.scheduler.fault, null);
  assert.equal(f.session.snapshot().pendingText, 0);
});

test('stalled worker cannot block PCM and old worker callback cannot enter replacement', async t => {
  const f = fixture(t), old = await f.begin();
  f.session.appendPcm({ owner: old, sequence: 0, samples: pcm() });
  f.session.pushSubtitle('你好呀。', { owner: old, sequence: 0 }); f.advance(.08);
  const worker = f.workers[0], callback = worker.onmessage, job = worker.jobs[0]; assert.ok(job);
  const current = await f.begin('r2'); callback({ data: worker.handler(job) });
  assert.equal(f.session.scheduler.queue.length, 0);
  f.session.appendPcm({ owner: current, sequence: 0, samples: pcm() }); f.session.finishAudio(current); f.advance(.3);
  assert.equal(f.session.scheduler.status, 'ended'); assert.equal(worker.terminated, true);
});

test('subtitle capacity and conflicting sequence disable only the optional visual sidecar', async t => {
  const f = fixture(t, { maxPendingText: 1 }), owner = await f.begin();
  assert.equal(f.session.pushSubtitle('你好，', { owner, sequence: 0 }).accepted, true);
  assert.equal(f.session.pushSubtitle('很高兴。', { owner, sequence: 1 }).reason, 'sidecar_disabled');
  assert.equal(f.session.sidecar.status, 'cancelled');
  assert.equal(f.events.at(-2).type, 'raw_subtitle');
  assert.equal(f.session.pushSubtitle('我还可以继续说话。', { owner, sequence: 2 }).accepted, true);
  assert.equal(f.events.at(-1).type, 'raw_subtitle');
  assert.equal(f.session.appendPcm({ owner, sequence: 0, samples: pcm() }), true);
  f.session.finishAudio(owner); f.advance(.3); assert.equal(f.session.scheduler.status, 'ended');
  const next = await f.begin('r2');
  assert.equal(f.session.pushSubtitle('你好。', { owner: next, sequence: 1 }).reason, 'subtitle_sequence_conflict');
  assert.equal(f.session.audio.status, 'buffering');
});

test('duplicate subtitles do not duplicate actions or disable sidecar', async t => {
  const f = fixture(t), owner = await f.begin();
  assert.equal(f.session.pushSubtitle('你好。', { owner, sequence: 0 }).accepted, true);
  assert.equal(f.session.pushSubtitle('你好。', { owner, sequence: 0 }).reason, 'duplicate');
  assert.equal(f.session.sidecar.status, 'active');
});

test('raw subtitles remain observable when Worker is disabled or unavailable', async t => {
  const f = fixture(t, { workerFactory() { throw new Error('worker_missing'); } }), owner = await f.begin();
  assert.equal(f.session.pushSubtitle('仍然显示字幕。', { owner, sequence: 0 }).reason, 'sidecar_disabled');
  assert.equal(f.events.at(-1).text, '仍然显示字幕。');
  const next = await f.begin('r2', { sidecar: false });
  assert.equal(f.session.pushSubtitle('关闭动作仍显示字幕。', { owner: next, sequence: 0 }).accepted, true);
  assert.equal(f.events.at(-1).type, 'raw_subtitle');
  assert.equal(f.session.snapshot().pendingText, 0);
});

test('invalid PCM sequence or bounded buffer overflow cancels instead of dropping audio silently', async t => {
  const f = fixture(t, { audioOptions: { maxBufferedSeconds: .3 } }), owner = await f.begin();
  assert.equal(f.session.appendPcm({ owner, sequence: 0, samples: pcm() }), true);
  assert.equal(f.session.appendPcm({ owner, sequence: 1, samples: pcm() }), false);
  assert.equal(f.session.audio.status, 'cancelled'); assert.match(f.session.lastError, /buffer_limit/);
  assert.equal(f.session.audio.snapshot().sourceCount, 0);
  const next = await f.begin('r2');
  assert.equal(f.session.appendPcm({ owner: next, sequence: 1, samples: pcm() }), false);
  assert.equal(f.session.audio.status, 'cancelled'); assert.match(f.session.lastError, /sequence/);
});

test('pause accepts arriving PCM but freezes media and mouth until resume', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: pcm() }); f.advance(.1);
  assert.equal(f.session.pause(), true); const before = f.session.audio.snapshot();
  assert.equal(f.session.appendPcm({ owner, sequence: 1, samples: pcm() }), true); f.advance(.5);
  near(f.session.audio.snapshot().time, before.time);
  assert.ok(f.session.lipSample().weights.every(value => value === 0));
  assert.equal(await f.session.resume(), true); f.advance(.1);
  assert.ok(f.session.audio.snapshot().time > before.time); assert.equal(f.session.scheduler.fault, null);
});

test('streamed mouth uses media position; starvation and cancellation close it immediately', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced() }); f.advance(.1);
  assert.ok(f.session.lipSample().weights.some(value => value > 0));
  f.advance(.3); assert.equal(f.session.audio.status, 'buffering');
  assert.ok(f.session.lipSample().weights.every(value => value === 0));
  f.session.appendPcm({ owner, sequence: 1, samples: voiced() }); f.advance(.1);
  assert.ok(f.session.lipSample().weights.some(value => value > 0));
  assert.equal(f.session.cancel(), true); assert.ok(f.session.lipSample().weights.every(value => value === 0));
  assert.equal(f.session.providerDone(owner), false); assert.equal(f.session.finishAudio(owner), false);
});

test('lip analysis failure and diagnostic observer exceptions do not stop playback', async t => {
  const broken = { begin: () => true, append() { throw new Error('lip_failed'); }, sample() { throw new Error('not_called'); },
    finish: () => true, cancel: () => true };
  const f = fixture(t, { lipTrack: broken, onEvent: async () => { throw new Error('observer'); } }), owner = await f.begin();
  assert.equal(f.session.appendPcm({ owner, sequence: 0, samples: pcm() }), true);
  f.session.finishAudio(owner); f.advance(.3); assert.equal(f.session.scheduler.status, 'ended');
  assert.equal(f.session.metrics.visualFailures, 1); await Promise.resolve();
});

test('failed cleanup prevents replacement or connection advancement', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: pcm() }); f.context.failStop = true;
  assert.equal(f.session.cancel(), false); assert.equal(f.session.scheduler.status, 'fault');
  assert.equal(f.session.setConnection('c2'), false);
  assert.equal(f.session.beginResponse({ connectionId: 'c1', responseId: 'r2' }), null);
  const events = f.session.events.length; f.session.sync(); f.session.sync(); assert.equal(f.session.events.length, events);
});

test('natural ended wall-clock body tail retracts on explicit cancel', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: pcm() }); f.session.finishAudio(owner);
  assert.equal(f.session.enqueue({ kind: 'gesture', gesture: 'wave', at: .01 }).accepted, true); f.advance(.3);
  assert.equal(f.motion.snapshot().gestures[0].clock, 'wall');
  assert.equal(f.session.cancel('ended_tail'), true); assert.equal(f.motion.snapshot().recovering, true);
  f.advance(2); assert.equal(f.motion.snapshot().gestures.length, 0);
});

test('failed resume closes received PCM and never reports audible playback', async t => {
  const f = fixture(t); f.context.failResume = true; f.session.setConnection('c1');
  const owner = f.session.beginResponse({ connectionId: 'c1', responseId: 'r1' });
  f.session.appendPcm({ owner, sequence: 0, samples: pcm() });
  assert.equal(await f.session.playReady, false); assert.equal(f.session.audio.snapshot().sourceCount, 0);
  assert.equal(f.session.snapshot().timings.firstPlaybackAt, undefined); assert.match(f.session.lastError, /resume_failed/);
});

test('host interaction persists through long thinking and rejects an obsolete local turn', async t => {
  const f = fixture(t); f.session.setConnection('c1');
  const old = f.session.inputStarted();
  assert.equal(f.session.inputEnded(old), true);
  f.advance(7);
  assert.equal(f.session.snapshot().behavior.mode, 'thinking');
  assert.equal(f.motion.snapshot().posture, 'relaxed');
  assert.equal(f.motion.snapshot().gestures.length, 0);
  assert.ok(Math.abs(f.motion.snapshot().gaze.yaw) < .005, 'long unresolved wait preserves partner attention');
  const next = f.session.inputStarted();
  assert.equal(f.session.inputEnded(old), false);
  assert.equal(f.session.snapshot().behavior.mode, 'listening');
  f.session.inputEnded(next);
  const owner = await f.begin(); f.advance(.4);
  assert.equal(f.session.snapshot().behavior.mode, 'thinking', 'buffering does not solve the thought');
  assert.equal(f.session.visualState().mouthMode, 'closed');
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(1) }); f.advance(.15);
  assert.equal(f.session.snapshot().behavior.mode, 'responding');
  assert.equal(f.session.visualState().mouthMode, 'speech');
  assert.equal(f.motion.snapshot().posture, 'relaxed', 'audio start must not raise hands');
});

test('natural subtitle comfort keeps hands quiet and its attitude survives media end', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(1) }); f.advance(.1);
  f.session.pushSubtitle('慢慢来，我在这里陪着你。', { owner, sequence: 0 });
  f.advance(.02); f.workers.at(-1).complete(); f.advance(.1);
  assert.equal(f.session.snapshot().behavior.intent, 'comfort');
  assert.equal(f.motion.snapshot().gestures.length, 0);
  assert.equal(f.face.snapshot().preset, 'neutral', 'attitude is not duplicated as preset');
  const warmth = f.session.snapshot().behavior.state.warmth;
  f.session.finishAudio(owner); f.advance(1.3);
  assert.equal(f.session.visualState().mouthMode, 'closed');
  assert.equal(f.session.snapshot().behavior.state.warmth, warmth);
  assert.equal(f.session.snapshot().behavior.mode, 'listening');
  assert.equal(f.session.answerAvailable(owner), false, 'ended cannot be revived as responding');
});

test('cancel and replacement fence behavior as well as audio and delayed worker instructions', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(2) }); f.advance(.1);
  f.session.pushSubtitle('你好！', { owner, sequence: 0 }); f.advance(.02);
  const worker = f.workers.at(-1), callback = worker.onmessage, job = worker.jobs[0];
  assert.equal(f.session.cancel('barge_in'), true);
  assert.equal(f.session.visualState().mouthMode, 'closed');
  assert.equal(f.session.snapshot().behavior.mode, 'listening');
  assert.equal(f.session.snapshot().behavior.owner, null);
  const local = f.session.inputStarted(); f.session.inputEnded(local);
  const next = await f.begin('r2');
  const before = f.session.snapshot().behavior;
  callback({ data: worker.handler(job) });
  assert.equal(f.session.answerAvailable(owner), false);
  assert.equal(f.session.inputEnded(local), false);
  assert.deepEqual(f.session.snapshot().behavior, before);
  assert.equal(f.session.snapshot().behavior.owner.responseId, next.responseId);
});

test('mouth ownership follows playback boundaries despite zero-lip object truthiness', async t => {
  const f = fixture(t), owner = await f.begin();
  assert.ok(f.session.lipSample());
  assert.equal(f.session.visualState().mouthMode, 'closed');
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(1) }); f.advance(.1);
  assert.equal(f.session.visualState().mouthMode, 'speech');
  f.session.pause(); assert.equal(f.session.visualState().paused, true);
  assert.equal(f.session.visualState().mouthMode, 'closed');
  f.advance(.5); await f.session.resume(); f.advance(.1);
  assert.equal(f.session.visualState().paused, false);
  assert.equal(f.session.visualState().mouthMode, 'speech');
  f.session.providerDone(owner);
  assert.equal(f.session.visualState().mouthMode, 'speech', 'providerDone is not playback end');
  f.session.cancel(); assert.equal(f.session.visualState().mouthMode, 'closed');
});

test('optional planner exceptions degrade visuals while accepted audio keeps playing', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.behaviorPlanner.answerAvailable = () => { throw new Error('probe'); };
  assert.equal(f.session.appendPcm({ owner, sequence: 0, samples: voiced(1) }), true);
  f.advance(.1);
  assert.equal(f.session.audio.snapshot().status, 'playing');
  assert.equal(f.session.snapshot().behavior, null);
  assert.equal(f.session.pushSubtitle('随便一段很长的解释也不能重新触发旧兜底。', { owner, sequence: 0 }).reason, 'sidecar_disabled');
  f.session.cancel(); await f.begin('r2');
  assert.equal(f.session._sidecarEnabled, false, 'failure cannot silently re-enable legacy fallback');
});

test('waiting keeps attention without inventing a thinking glance or advancing audio cues', async t => {
  const f = fixture(t); f.session.setConnection('c1');
  f.face.headSway = false; // production scene delegates head motion to the body composer
  f.motion.setOptions({ continuity: true });
  const token = f.session.inputStarted(); f.session.inputEnded(token);
  await f.begin(); f.advance(1);
  assert.equal(f.session.audio.status, 'buffering');
  assert.equal(f.motion.time, 0);
  assert.equal(f.session.visualState().paused, false);
  assert.ok(Math.abs(f.motion.snapshot().gaze.yaw) < .005, 'waiting remains attentive');
  assert.ok(Math.abs(f.motion.snapshot().head.yaw) < .005);
  assert.equal(f.session.snapshot().behavior.state.uncertainty, 0);
});

test('causal partner PCM runs without a response and rejects old/future capture identity', t => {
  const f = fixture(t); f.session.setConnection('c1');
  const token = f.session.inputStarted();
  assert.equal(f.session.owner, null);
  const input = { token, samples: voiced(.02), sampleRate: 24000, capturedAtMs: 0 };
  assert.equal(f.session.observePartnerPcm(input), true);
  assert.equal(f.session.snapshot().behavior.partnerVoicing, true);
  assert.equal(f.session.observePartnerPcm(input), false, 'duplicate capture is not a fresh observation');
  assert.equal(f.session.observePartnerPcm({ ...input, capturedAtMs: 100 }), false, 'future frame refused');
  assert.equal(f.session.snapshot().metrics.cancels, 0);
  const next = f.session.inputStarted(); f.advance(.02);
  assert.equal(f.session.observePartnerPcm({ ...input, capturedAtMs: 20 }), false, 'old generation not relabeled');
  assert.equal(f.session.observePartnerPcm({ ...input, token: next, capturedAtMs: 20 }), true);
  assert.equal(f.session.inputEnded(next), true);
  assert.equal(f.session.snapshot().behavior.partnerVoicing, false);
  assert.equal(f.session.audio.snapshot().status, 'idle');
});

test('partner observation can overlap real playback without revoking it, and pause freezes self voicing', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(1) }); f.advance(.1);
  const token = f.session.interactionToken();
  assert.equal(f.session.observePartnerPcm({ token, samples: voiced(.02), sampleRate: 24000, capturedAtMs: 100 }), true);
  const visual = f.session.visualState();
  assert.equal(visual.behavior.partnerVoicing, true); assert.equal(visual.behavior.selfVoicing, true);
  assert.equal(f.session.audio.status, 'playing'); assert.equal(f.session.metrics.cancels, 0);
  assert.equal(visual.rhythm.clock, 'audio'); assert.ok(visual.rhythm.availableLeadSeconds > .8);
  f.session.pause(); const paused = f.session.visualState();
  assert.equal(paused.mouthMode, 'closed'); assert.equal(paused.rhythm.voiced, false);
  assert.equal(paused.behavior.selfVoicing, false);
});

test('invalid PCM and optional input observation failure cannot cancel accepted reply audio', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(1) }); f.advance(.1);
  const token = f.session.interactionToken();
  assert.equal(f.session.observePartnerPcm({ token, samples: new Float32Array([NaN]), sampleRate: 24000, capturedAtMs: 100 }), false);
  f.session.behaviorPlanner.observeInteraction = () => { throw new Error('optional observation failure'); };
  assert.equal(f.session.observePartnerPcm({ token, samples: voiced(.02), sampleRate: 24000, capturedAtMs: 100 }), false);
  assert.equal(f.session.audio.status, 'playing'); assert.equal(f.session.metrics.cancels, 0);
  assert.equal(f.session.visualState().mouthMode, 'speech');
});

test('silent input arming is not speech and lost PCM expires without audio cancellation', t => {
  const f = fixture(t); f.session.setConnection('c1');
  const token = f.session.inputStarted('c1', { voiced: false });
  assert.ok(token); assert.equal(f.session.snapshot().behavior.partnerVoicing, false);
  assert.equal(f.session.observePartnerPcm({ token, samples: voiced(.02), sampleRate: 24000, capturedAtMs: 0 }), true);
  f.advance(.3);
  assert.equal(f.session.visualState().behavior.partnerVoicing, false);
  assert.equal(f.session.metrics.cancels, 0);
});

test('interrupt releases authored gaze before the arm has completed its protected recovery', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(4) });
  f.session.enqueue({ kind: 'gesture', gesture: 'shy', at: .05 }); f.advance(2);
  assert.ok(Math.abs(f.motion.snapshot().gaze.yaw) > .08);
  f.session.cancel('user_interrupt'); f.advance(.10);
  assert.equal(f.motion.snapshot().recovering, true);
  assert.equal(f.motion.snapshot().gaze.targetYaw, 0, 'old authored glance cannot own new listening attention');
  assert.ok(f.motion.snapshot().gestures.length > 0, 'preserve the managed hand tail');
  f.advance(3); assert.equal(f.motion.snapshot().gestures.length, 0);
});

test('scheduler playback failure retires behavior instead of replaying a stale playing snapshot', async t => {
  const f = fixture(t), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(2) }); f.advance(.1);
  f.face.playback = () => false; f.advance(.02);
  assert.equal(f.session.scheduler.status, 'fault');
  assert.equal(f.session.audio.status, 'cancelled');
  assert.equal(f.session.snapshot().behavior.owner, null);
  assert.equal(f.session.snapshot().behavior.mode, 'listening');
  assert.equal(f.session.visualState().mouthMode, 'closed');
});

test('watchdog cleanup retires the continuous behavior owner without another sync', async t => {
  let clock = 0;
  const f = fixture(t, { clock: () => clock }), owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(2) }); f.advance(.1);
  clock = 2; f.session.scheduler.tick();
  assert.equal(f.session.scheduler.status, 'cancelled');
  assert.equal(f.session.audio.status, 'cancelled');
  assert.equal(f.session.snapshot().behavior.owner, null);
  assert.equal(f.session.snapshot().behavior.mode, 'listening');
});

test('disconnect retires response and local input identity; only a fresh connection can resume', async t => {
  const f = fixture(t); f.session.setConnection('c1');
  const token = f.session.inputStarted(); f.session.inputEnded(token);
  const owner = await f.begin(); f.session.appendPcm({ owner, sequence: 0, samples: voiced(2) }); f.advance(.1);
  assert.equal(f.session.disconnect('c1'), true);
  assert.equal(f.session.connectionId, null); assert.equal(f.session.owner, null);
  assert.equal(f.session.beginResponse({ connectionId: 'c1', responseId: 'late' }), null);
  assert.equal(f.session.inputEnded(token), false);
  assert.equal(f.session.setConnection('c1'), false);
  assert.equal(f.session.setConnection('c2'), true);
  assert.equal(f.session.disconnect('c1'), false);
  const next = f.session.beginResponse({ connectionId: 'c2', responseId: 'fresh' });
  assert.ok(next); assert.equal(await f.session.playReady, true);
  assert.equal(f.session.snapshot().behavior.owner.connectionId, 'c2');
});

test('face actions acknowledge actual composition and cannot acknowledge a retired response', async t => {
  const f = fixture(t); f.motion.setOptions({ continuity: true });
  const owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(2) });
  const feedback = [], original = f.session.sidecar.executionFeedback.bind(f.session.sidecar);
  f.session.sidecar.executionFeedback = (id, result) => { feedback.push({ id, ...result }); return original(id, result); };
  assert.equal(f.session.enqueue({ id: 'actual-shake', kind: 'action', action: 'shake', at: .1 }, owner).accepted, true);
  assert.equal(f.session.timings.firstCueAt, undefined);
  f.advance(.08);
  assert.equal(feedback.some(item => item.id === 'actual-shake' && item.displayed), false);
  f.advance(.12);
  assert.ok(feedback.some(item => item.id === 'actual-shake' && item.accepted && !item.displayed));
  assert.ok(feedback.some(item => item.id === 'actual-shake' && item.displayed));
  assert.ok(f.session.timings.firstDisplayedCueAt >= f.session.timings.firstCueAt);
  const previous = f.face.snapshot();
  assert.ok(previous.executedCues.some(item => item.id === 'actual-shake' && item.epoch === owner.epoch));
  await f.begin('r2'); feedback.length = 0;
  assert.deepEqual(f.face.snapshot().executedCues, []);
  const snapshot = f.face.snapshot.bind(f.face); f.face.snapshot = () => previous;
  f.session.observeMotion();
  assert.equal(feedback.some(item => item.displayed), false);
  f.face.snapshot = snapshot;
});

test('optional nod rejection neither faults audio nor claims first executed cue', async t => {
  const f = fixture(t); f.motion.setOptions({ continuity: true });
  const owner = await f.begin();
  f.session.appendPcm({ owner, sequence: 0, samples: voiced(2) });
  const request = f.motion.requestReaction.bind(f.motion);
  f.motion.requestReaction = reaction => reaction.kind === 'nod' ? false : request(reaction);
  f.session.enqueue({ id: 'rejected-nod', kind: 'action', action: 'nod', at: .05 }, owner);
  f.advance(.2);
  assert.equal(f.session.audio.status, 'playing');
  assert.equal(f.session.timings.firstCueAt, undefined);
  assert.equal(f.session.timings.firstDisplayedCueAt, undefined);
  assert.ok(f.events.some(event => event.type === 'reaction_admission' && !event.accepted));
});

test('voice from a retired generation expires instead of becoming a permanent partner onset', async t => {
  const f = fixture(t); f.session.setConnection('c1');
  const token = f.session.inputStarted('c1', { voiced: false });
  f.session.observePartnerPcm({ token, samples: voiced(.02), sampleRate: 24000, capturedAtMs: 0 });
  assert.equal(f.session.snapshot().behavior.partnerVoicing, true);
  const owner = await f.begin();
  f.advance(.3);
  assert.equal(f.session.visualState().behavior.partnerVoicing, false);
  const next = f.session.interactionToken();
  assert.equal(f.session.observePartnerPcm({ token: next, samples: voiced(.02), sampleRate: 24000, capturedAtMs: 300 }), true);
  assert.equal(f.session.snapshot().behavior.partnerVoicing, true);
  f.session.cancel('input_ended', owner); f.advance(.3);
  assert.equal(f.session.visualState().behavior.partnerVoicing, false);
});
