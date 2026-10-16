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
    face.update(now, dt, session.lipSample(audio), true);
    motion.update(now, dt, { face: face.head, actions: face.activeActions, speech: 0 });
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
