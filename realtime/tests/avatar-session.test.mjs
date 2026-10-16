import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AvatarSession } from '../avatar/session.mjs';
import { FaceController } from '../../preview/core/controller.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';
import { createSubtitleWorkerHandler } from '../subtitle-worker.mjs';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(
  new URL('../../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const sample = (seconds = .16) => ({ samples: new Float32Array(Math.round(8000 * seconds)).fill(.1), sampleRate: 8000 });
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
    assert.equal(channels, 1);
    const data = new Float32Array(length);
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
  jobs = []; terminated = false; handler = createSubtitleWorkerHandler();
  postMessage(job) { this.jobs.push(job); }
  terminate() { this.terminated = true; }
  complete() { const job = this.jobs.shift(); if (job) this.onmessage?.({ data: this.handler(job) }); }
}

function fixture(t, options = {}) {
  let now = 0;
  const context = new FakeContext(), face = new FaceController(), motion = new MotionController({ skeleton, seed: 42 });
  const workers = [], events = [];
  const session = new AvatarSession({ context, face, motion, clock: () => now,
    workerFactory: () => { const worker = new WorkerDouble(); workers.push(worker); return worker; },
    onEvent: event => events.push(event), ...options });
  const render = dt => {
    face.update(now, dt, null, true);
    motion.update(now, dt, { face: face.head, actions: face.activeActions, speech: 0 });
    for (const quaternion of motion.locals.values()) assert.ok(quaternion.every(Number.isFinite));
  };
  const advance = seconds => {
    const end = now + seconds;
    while (now + 1e-9 < end) {
      const dt = Math.min(1 / 60, end - now); now += dt; context.advance(dt); session.sync(); render(dt);
    }
    return session.audio.snapshot();
  };
  t.after(() => { context.failStop = false; session.dispose(); });
  return { session, context, face, motion, workers, events, advance, render };
}

// Fire each timer explicitly, after advancing the independent wall/audio clock.
// This models a busy browser delivering callbacks late without hiding several
// yielded catch-up tasks inside a single mock-timer tick.
function feedTimers(t, session) {
  const timers = new Set(), batches = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay = 0) => {
    const timer = { callback, at: session.clock() + delay / 1000 };
    timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); });
  const runOne = () => {
    const timer = [...timers].sort((a, b) => a.at - b.at)[0];
    if (!timer || timer.at > session.clock() + 1e-9) return false;
    timers.delete(timer);
    const before = session.metrics.pcmChunks;
    timer.callback();
    batches.push(session.metrics.pcmChunks - before);
    return true;
  };
  return { batches, runOne, get pending() { return timers.size; }, runDue() {
    let callbacks = 0;
    while (runOne()) assert.ok(++callbacks < 1000, 'timer work must remain bounded');
    return callbacks;
  } };
}

test('single PCM clock drives real controllers; provider completion precedes playback completion', async t => {
  const f = fixture(t);
  assert.equal(await f.session.start(sample(), { providerFast: true }), true);
  assert.equal(f.session.scheduler.generated, true);
  assert.equal(f.session.audio.snapshot().status, 'buffering');
  assert.equal(f.session.audio.snapshot().sourceCount, 8);
  const queued = f.session.enqueue({ kind: 'expression', preset: 'smile' });
  assert.equal(queued.accepted, true);
  f.advance(.12);
  near(f.session.scheduler.time, f.session.audio.snapshot().time);
  near(f.face.time, f.motion.time);
  assert.equal(f.session.scheduler.counts.dispatched, 1);
  f.advance(.2);
  assert.equal(f.session.scheduler.status, 'ended');
  assert.equal(f.face.active, false); assert.equal(f.motion.active, false);
  assert.equal(f.session.snapshot().audio.sourceCount, 0);
});

test('natural end is sent once; later sync cannot fault inactive controllers', async t => {
  const f = fixture(t);
  await f.session.start(sample(.08), { providerFast: true });
  f.advance(.2);
  const commands = f.session.scheduler.counts.commands;
  f.advance(2);
  assert.equal(f.session.scheduler.counts.commands, commands);
  assert.equal(f.session.scheduler.fault, null);
  assert.equal(f.session.sidecar.status, 'cancelled');
});

test('pause freezes media and PCM feeder; resume continues from the same content position', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.session.start(sample(1));
  f.advance(.06);
  assert.equal(f.session.pause(), true);
  const frozen = f.session.audio.snapshot();
  t.mock.timers.tick(1000); f.advance(.5);
  near(f.session.audio.snapshot().time, frozen.time);
  near(f.session.audio.snapshot().receivedDuration, frozen.receivedDuration);
  assert.equal(f.motion.status, 'paused');
  assert.equal(await f.session.resume(), true);
  f.advance(.06);
  assert.ok(f.session.audio.snapshot().time > frozen.time);
  assert.equal(f.session.scheduler.fault, null);
});

test('cancel fences a pending AudioContext resume and leaves no sources', async t => {
  const f = fixture(t); let resolve;
  f.context.pendingResume = new Promise(done => { resolve = done; });
  const starting = f.session.start(sample());
  assert.equal(f.session.cancel('during_resume'), true);
  resolve();
  assert.equal(await starting, false);
  assert.equal(f.session.audio.snapshot().status, 'cancelled');
  assert.equal(f.context.sources.length, 0);
  assert.equal(f.session.sidecar.status, 'cancelled');
});

test('replacement while resume is pending starts only the newest owner', async t => {
  const f = fixture(t); let resolve;
  f.context.pendingResume = new Promise(done => { resolve = done; });
  const first = f.session.start(sample()); const old = f.session.owner;
  const second = f.session.start(sample(.08), { providerFast: true }); const current = f.session.owner;
  resolve();
  assert.equal(await first, false); assert.equal(await second, true);
  assert.ok(current.epoch > old.epoch);
  assert.equal(f.context.sources.length, 4);
  assert.ok(f.context.sources.every(source => !source.stopped));
  assert.equal(f.session.enqueue({ kind: 'action', action: 'nod' }, old).accepted, false);
  assert.equal(f.session.pushSubtitle('你好。', { owner: old }).accepted, false);
  assert.equal(f.session.finishSubtitles(old), false);
});

test('active replacement stops all old scheduled sources before creating new PCM', async t => {
  const f = fixture(t);
  await f.session.start(sample(), { providerFast: true });
  const oldSources = [...f.context.sources];
  f.advance(.08);
  await f.session.start(sample(.08), { providerFast: true });
  assert.ok(oldSources.every(source => source.stopped || source.disconnected));
  assert.equal(f.session.audio.epoch, f.session.owner.epoch);
  assert.equal(f.face.epoch, f.session.owner.epoch);
  assert.equal(f.motion.epoch, f.session.owner.epoch);
  assert.equal(f.session.scheduler.fault, null);
});

test('stalled subtitle worker never blocks PCM feed or completed audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  assert.equal(await f.session.start(sample(.4)), true);
  assert.equal(f.session.pushSubtitle('你好呀。').accepted, true);
  assert.equal(f.session.sidecar.snapshot().inFlight, true);
  for (let i = 0; i < 24; i++) { t.mock.timers.tick(20); f.advance(.02); }
  assert.equal(f.session.audio.snapshot().status, 'ended');
  near(f.session.audio.snapshot().time, .4);
  assert.equal(f.session.scheduler.fault, null);
  assert.equal(f.workers[0].terminated, true);
});

test('worker timeout disables only subtitles while real audio continues', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.session.start(sample(2));
  f.session.pushSubtitle('你好呀。');
  for (let i = 0; i < 65; i++) { t.mock.timers.tick(20); f.advance(.02); }
  assert.equal(f.session.sidecar.status, 'disabled');
  assert.equal(f.session.audio.snapshot().status, 'playing');
  assert.ok(f.session.audio.snapshot().time > 1.2);
  assert.equal(f.session.scheduler.fault, null);
});

test('old worker callback and old subtitle owner cannot enqueue into a replacement', async t => {
  const f = fixture(t);
  await f.session.start(sample(), { providerFast: true });
  f.session.pushSubtitle('你好呀。');
  const worker = f.workers[0], callback = worker.onmessage, job = worker.jobs[0], old = f.session.owner;
  await f.session.start(sample(), { providerFast: true });
  callback({ data: worker.handler(job) });
  assert.equal(f.session.scheduler.queue.length, 0);
  assert.equal(f.session.finishSubtitles(old), false);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.session.pushSubtitle('不要点头。').accepted, true);
  f.workers[1].complete();
  assert.equal(f.session.scheduler.queue.length, 0);
});

test('subtitle analysis can dispatch through the same real-controller scheduler', async t => {
  const f = fixture(t);
  await f.session.start(sample(), { providerFast: true });
  f.session.pushSubtitle('你好呀，很高兴见到你！');
  f.workers[0].complete();
  assert.ok(f.session.scheduler.queue.length > 0);
  assert.equal(f.session.finishSubtitles(), true); f.workers[0].complete();
  f.advance(.11);
  assert.ok(f.session.scheduler.counts.dispatched > 0);
  assert.equal(f.session.scheduler.fault, null);
});

test('cancel after natural end retracts a live wall-clock gesture tail', async t => {
  const f = fixture(t);
  await f.session.start(sample(), { providerFast: true });
  f.session.enqueue({ id: 'tail', kind: 'gesture', gesture: 'wave', at: .01 });
  f.advance(.25);
  assert.equal(f.session.scheduler.status, 'ended');
  assert.equal(f.motion.snapshot().gestures[0].clock, 'wall');
  assert.equal(f.motion.snapshot().gestures[0].recovering, false);
  assert.equal(f.session.cancel('ended_tail'), true);
  assert.equal(f.motion.snapshot().recovering, true);
  f.advance(2);
  assert.equal(f.motion.snapshot().gestures.length, 0);
  assert.equal(f.session.scheduler.fault, null);
});

test('faulting audio cleanup fails closed and does not retry on every RAF', async t => {
  const f = fixture(t);
  await f.session.start(sample(), { providerFast: true });
  f.context.failStop = true;
  assert.equal(f.session.cancel('fault'), false);
  assert.equal(f.session.scheduler.status, 'fault');
  assert.equal(await f.session.start(sample()), false);
  f.session.sync();
  const errors = f.session.metrics.feedFailures;
  for (let i = 0; i < 10; i++) f.session.sync();
  assert.equal(f.session.metrics.feedFailures, errors);
  assert.equal(f.face.active, false); assert.equal(f.motion.active, false);
});

test('failed context resume and diagnostic exceptions cannot leak pending sources', async t => {
  const f = fixture(t, { onEvent: () => { throw new Error('diagnostic_failure'); } });
  f.context.failResume = true;
  assert.equal(await f.session.start(sample()), false);
  assert.equal(f.session.audio.snapshot().sourceCount, 0);
  assert.equal(f.face.active, false); assert.equal(f.motion.active, false);
  assert.match(f.session.lastError, /resume_failed/);
  f.context.failResume = false;
  assert.equal(await f.session.start(sample(), { providerFast: true }), true);
});

test('invalid input does not replace playback; manual payload cannot choose its owner', async t => {
  const f = fixture(t);
  await f.session.start(sample(), { providerFast: true, sidecar: false });
  const owner = f.session.owner;
  assert.equal(await f.session.start(sample(), { chunkMs: 0 }), false);
  assert.equal(f.session.owner, owner);
  assert.equal(f.session.pushSubtitle('你好。').reason, 'sidecar_disabled');
  assert.equal(f.session.enqueue({ kind: 'action', action: 'nod', epoch: -1, connectionId: 'injected' }).accepted, true);
  assert.equal(f.session.scheduler.queue[0].cue.epoch, owner.epoch);
  f.session.dispose();
  assert.equal(await f.session.start(sample()), false);
  assert.equal(f.session.enqueue({ kind: 'action', action: 'nod' }).accepted, false);
  assert.equal(f.session.snapshot().audio.sourceCount, 0);
});

test('missing Worker is isolated; rejected asynchronous observers are diagnostic only', async t => {
  const f = fixture(t, { workerFactory: () => { throw new Error('unavailable'); },
    onEvent: async () => { throw new Error('diagnostic_rejection'); } });
  assert.equal(await f.session.start(sample(), { providerFast: true }), true);
  assert.equal(f.session.sidecar.status, 'disabled');
  f.advance(.25);
  assert.equal(f.session.audio.snapshot().status, 'ended');
  assert.equal(f.session.scheduler.fault, null);
  await Promise.resolve();
});

test('fast input is bounded by audio backpressure; interruption removes its queued timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.session.start(sample(30), { providerFast: true, sidecar: false });
  // Fire fast batches without advancing AudioContext: backpressure must retain
  // the unsent tail in the host sample, not append an unbounded audio queue.
  for (let i = 0; i < 300; i++) t.mock.timers.tick(1);
  assert.ok(f.session.audio.snapshot().queuedSeconds <= 20 + 1e-9);
  assert.equal(f.session.metrics.pcmBatchMaxChunks, 8);
  assert.equal(f.session.scheduler.fault, null);
  assert.equal(f.session.cancel(), true);
  const chunks = f.session.metrics.pcmChunks;
  t.mock.timers.tick(10000);
  assert.equal(f.session.metrics.pcmChunks, chunks);
  assert.equal(f.session.audio.snapshot().sourceCount, 0);
});

test('simulated starvation freezes media time and keeps cues queued until audio resumes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.session.start(sample(2), { starve: true, sidecar: false });
  for (let i = 0; i < 60; i++) { t.mock.timers.tick(20); f.advance(.02); }
  assert.equal(f.session.audio.snapshot().status, 'buffering');
  near(f.session.audio.snapshot().time, 1);
  const accepted = f.session.enqueue({ kind: 'action', action: 'nod' });
  assert.equal(accepted.accepted, true);
  for (let i = 0; i < 25; i++) { t.mock.timers.tick(20); f.advance(.02); }
  near(f.session.audio.snapshot().time, 1);
  assert.equal(f.session.scheduler.counts.dispatched, 0);
  for (let i = 0; i < 35; i++) { t.mock.timers.tick(20); f.advance(.02); }
  assert.ok(f.session.audio.snapshot().time > 1);
  assert.equal(f.session.scheduler.counts.dispatched, 1);
  assert.equal(f.session.scheduler.fault, null);
});

test('27ms callback delivery follows absolute 20ms arrivals without accumulating audio starvation', async t => {
  const f = fixture(t), timers = feedTimers(t, f.session);
  await f.session.start(sample(6), { sidecar: false });
  assert.equal(f.session.metrics.pcmChunks, 4);
  let buffering = 0;
  for (let i = 0; i < 200; i++) {
    const audio = f.advance(.027);
    if (i > 4 && audio.status === 'buffering') buffering++;
    timers.runDue();
  }
  near(f.session.audio.snapshot().receivedDuration, 5.48);
  assert.equal(buffering, 0, 'timer jitter must not cause a permanent delivery deficit');
  assert.ok(timers.batches.some(count => count > 1));
  assert.ok(timers.batches.every(count => count <= 8));
  assert.equal(f.session.scheduler.fault, null);
});

test('a late callback catches up in separately yielded batches of at most eight chunks', async t => {
  const f = fixture(t), timers = feedTimers(t, f.session);
  await f.session.start(sample(4), { sidecar: false });
  f.advance(.8);
  assert.equal(f.session.audio.snapshot().status, 'buffering');
  assert.equal(timers.runOne(), true);
  assert.equal(timers.batches.at(-1), 8);
  near(f.session.audio.snapshot().receivedDuration, .24);
  assert.equal(timers.pending, 1, 'remaining debt is a later task, not a synchronous loop');
  timers.runDue();
  near(f.session.audio.snapshot().receivedDuration, .88);
  assert.ok(timers.batches.every(count => count <= 8));
  assert.equal(f.session.metrics.pcmBatchMaxChunks, 8);
  assert.equal(f.session.scheduler.fault, null);
});

test('a long pause resets arrival origin instead of turning pause time into catch-up debt', async t => {
  const f = fixture(t), timers = feedTimers(t, f.session);
  await f.session.start(sample(20), { sidecar: false });
  f.advance(.04); timers.runDue();
  assert.equal(f.session.pause(), true);
  const chunks = f.session.metrics.pcmChunks, received = f.session.audio.snapshot().receivedDuration;
  f.advance(10); timers.runDue();
  assert.equal(await f.session.resume(), true);
  timers.runDue();
  assert.equal(f.session.metrics.pcmChunks, chunks);
  near(f.session.audio.snapshot().receivedDuration, received);
  f.advance(.021); timers.runDue();
  assert.equal(f.session.metrics.pcmChunks, chunks + 1);
  assert.equal(f.session.scheduler.fault, null);
});

test('deliberate starvation blocks delivery for 1.2 seconds then catches up through yielded tasks', async t => {
  const f = fixture(t), timers = feedTimers(t, f.session);
  await f.session.start(sample(4), { sidecar: false, starve: true });
  for (let i = 0; i < 50; i++) { f.advance(.02); timers.runDue(); }
  const event = f.events.find(event => event.type === 'starvation');
  assert.ok(event);
  near(f.session.audio.snapshot().receivedDuration, 1);
  const elapsed = f.session.clock() - event.atWall;
  f.advance(1.19 - elapsed); timers.runDue();
  near(f.session.audio.snapshot().receivedDuration, 1);
  assert.equal(f.session.audio.snapshot().status, 'buffering');
  f.advance(.011);
  assert.equal(timers.runOne(), true);
  assert.equal(timers.batches.at(-1), 8);
  assert.equal(timers.pending, 1);
  timers.runDue();
  assert.ok(f.session.audio.snapshot().receivedDuration > 2);
  assert.ok(timers.batches.every(count => count <= 8));
  assert.equal(f.session.scheduler.fault, null);
});
