import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingAudioTransport } from '../stream-audio.mjs';

class FakeContext {
  currentTime = 0;
  state = 'suspended';
  destination = {};
  sources = [];
  gains = [];
  pendingResume = null;
  failStop = false;
  failDisconnect = false;
  failMute = false;
  failStart = false;
  failResume = false;
  async resume() {
    if (this.failResume) throw new Error('resume failed');
    if (this.pendingResume) await this.pendingResume;
    this.state = 'running';
  }
  createBuffer(channels, length, sampleRate) {
    assert.equal(channels, 1);
    const data = new Float32Array(length);
    return { length, duration: length / sampleRate, sampleRate, getChannelData: () => data };
  }
  createGain() {
    const ctx = this;
    const gain = {
      gain: { value: 1, cancelScheduledValues() {}, setValueAtTime(value) {
        if (ctx.failMute) throw new Error('mute failed');
        this.value = value;
      } },
      disconnected: false,
      connect() {}, disconnect() { this.disconnected = true; },
    };
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const ctx = this;
    const source = {
      onended: null, stopped: false, disconnected: false,
      connect() {},
      start(when, offset, duration) {
        if (ctx.failStart) throw new Error('start failed');
        this.when = when; this.offset = offset; this.duration = duration;
      },
      stop() {
        if (this.when === undefined) throw new Error('InvalidStateError: not started');
        if (ctx.failStop) throw new Error('stop failed');
        this.stopped = true;
      },
      disconnect() { if (ctx.failDisconnect) throw new Error('disconnect failed'); this.disconnected = true; },
    };
    this.sources.push(source);
    return source;
  }
  advance(seconds, deliverEnded = true) {
    if (this.state !== 'running') return;
    this.currentTime += seconds;
    if (deliverEnded) for (const source of this.sources) {
      if (!source.stopped && source.onended && this.currentTime >= source.when + source.duration) source.onended();
    }
  }
}

const pcm = (seconds = 1, rate = 8000) => new Float32Array(Math.round(seconds * rate)).fill(0.1);
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function setup(options) {
  const context = new FakeContext();
  const player = new StreamingAudioTransport(context, options);
  assert.equal(player.begin(1, { sampleRate: 8000 }), true);
  return { context, player };
}

test('append is silent until explicit play; initial lead does not advance media time', async () => {
  const { context, player } = setup();
  assert.equal(player.append({ epoch: 1, sequence: 0, samples: pcm() }), true);
  assert.equal(context.sources.length, 0);
  assert.equal(player.snapshot().status, 'buffering');
  assert.equal(await player.play(), true);
  assert.equal(player.snapshot().sourceCount, 1);
  assert.equal(player.snapshot().sourceActive, false);
  context.advance(0.02);
  near(player.snapshot().time, 0);
  context.advance(0.12);
  assert.equal(player.snapshot().status, 'playing');
  near(player.snapshot().time, 0.1);
});

test('PCM chunk boundaries schedule contiguously; input finish is not playback end', async () => {
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm(0.5) });
  await player.play();
  context.advance(0.2);
  player.append({ epoch: 1, sequence: 1, samples: pcm(0.5) });
  near(context.sources[1].when, context.sources[0].when + context.sources[0].duration);
  assert.equal(player.finish(1), true);
  assert.equal(player.snapshot().status, 'playing');
  context.advance(0.84);
  assert.equal(player.snapshot().status, 'ended');
  near(player.snapshot().time, 1);
  assert.equal(player.snapshot().sourceCount, 0);
  assert.equal(player.snapshot().retainedSeconds, 0);
});

test('starvation freezes media time; resumed content uses a fresh lead without counting silence', async () => {
  const { context, player } = setup();
  await player.play();
  context.advance(10);
  near(player.snapshot().time, 0);
  player.append({ epoch: 1, sequence: 0, samples: pcm(0.2) });
  context.advance(1);
  near(player.snapshot().time, 0.2);
  assert.equal(player.snapshot().status, 'buffering');
  context.advance(9);
  near(player.snapshot().time, 0.2);
  player.append({ epoch: 1, sequence: 1, samples: pcm(0.3) });
  context.advance(0.14);
  near(player.snapshot().time, 0.3);
});

test('pause cuts all future nodes and resumes the current PCM offset without skipping data', async () => {
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  player.append({ epoch: 1, sequence: 1, samples: pcm() });
  await player.play();
  context.advance(0.44);
  const originals = context.sources.slice();
  const lateCallback = originals[0].onended;
  assert.equal(player.pause(), true);
  assert.ok(originals.every(source => source.stopped && source.disconnected));
  context.advance(4);
  near(player.snapshot().time, 0.4);
  assert.equal(player.snapshot().status, 'paused');
  assert.equal(await player.resume(), true);
  near(context.sources[2].offset, 0.4);
  near(context.sources[2].duration, 0.6);
  near(context.sources[3].when, context.sources[2].when + 0.6);
  lateCallback();
  near(player.snapshot().time, 0.4);
  context.advance(0.14);
  near(player.snapshot().time, 0.5);
});

test('cancel invalidates epoch playback, queued sources, PCM, and late callbacks', async () => {
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  player.append({ epoch: 1, sequence: 1, samples: pcm() });
  await player.play();
  const callback = context.sources[0].onended;
  context.advance(0.24);
  assert.equal(player.cancel(), true);
  assert.ok(context.sources.every(source => source.stopped && source.disconnected));
  assert.equal(await player.resume(), false);
  assert.equal(player.append({ epoch: 1, sequence: 2, samples: pcm() }), false);
  assert.equal(player.begin(1), false);
  assert.equal(player.begin(2, { sampleRate: 8000 }), true);
  callback();
  near(player.snapshot().time, 0);
  assert.equal(player.snapshot().epoch, 2);
  assert.equal(player.snapshot().sourceCount, 0);
});

for (const operation of ['pause', 'cancel', 'begin']) {
  test(`${operation} fences a delayed AudioContext resume`, async () => {
    const { context, player } = setup();
    player.append({ epoch: 1, sequence: 0, samples: pcm() });
    let release;
    context.pendingResume = new Promise(resolve => { release = resolve; });
    const playing = player.play();
    if (operation === 'begin') player.begin(2);
    else player[operation]();
    release();
    assert.equal(await playing, false);
    assert.equal(context.sources.length, 0);
    assert.equal(player.snapshot().status, { begin: 'buffering', pause: 'paused', cancel: 'cancelled' }[operation]);
  });
}

test('invalid append rejects atomically; caller can retry exactly the next sequence', async () => {
  const { player } = setup();
  for (const bad of [
    { epoch: 2, sequence: 0, samples: pcm() },
    { epoch: 1, sequence: 1, samples: pcm() },
    { epoch: 1, sequence: 0, samples: [0, 1] },
    { epoch: 1, sequence: 0, samples: new Float32Array() },
    { epoch: 1, sequence: 0, samples: new Float32Array([NaN]) },
    { epoch: 1, sequence: 0, samples: new Float32Array([Infinity]) },
  ]) assert.equal(player.append(bad), false);
  assert.equal(player.snapshot().nextSequence, 0);
  assert.equal(player.snapshot().receivedDuration, 0);
  assert.equal(player.append({ epoch: 1, sequence: 0, samples: pcm() }), true);
  assert.equal(player.append({ epoch: 1, sequence: 0, samples: pcm() }), false);
  assert.equal(player.finish(2), false);
  assert.equal(player.finish(1), true);
  assert.equal(player.append({ epoch: 1, sequence: 1, samples: pcm() }), false);
});

test('buffer backpressure is retryable and retained buffers are released after consumption', async () => {
  const { context, player } = setup({ maxBufferedSeconds: 1, maxRetainedSeconds: 1 });
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  assert.equal(player.append({ epoch: 1, sequence: 1, samples: pcm() }), false);
  assert.equal(player.snapshot().lastError, 'buffer_limit');
  await player.play();
  context.advance(0.54);
  assert.equal(player.append({ epoch: 1, sequence: 1, samples: pcm(0.5) }), false);
  assert.equal(player.snapshot().lastError, 'retention_limit');
  context.advance(0.5);
  assert.equal(player.snapshot().retainedSeconds, 0);
  assert.equal(player.append({ epoch: 1, sequence: 1, samples: pcm() }), true);
  near(player.snapshot().receivedDuration, 2);
});

test('browser suspension cannot advance PCM; explicit resume continues scheduled sources', async () => {
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  await player.play();
  context.advance(0.24);
  context.state = 'suspended';
  context.advance(5);
  assert.equal(player.snapshot().status, 'paused');
  near(player.snapshot().time, 0.2);
  await player.resume();
  context.advance(0.1);
  near(player.snapshot().time, 0.3);
  assert.equal(context.sources.length, 1);
});

for (const failure of ['failStop', 'failDisconnect', 'failMute']) {
  test(`${failure} is reported on cancel; independent cleanup still executes; retry is explicit`, async () => {
    const { context, player } = setup();
    player.append({ epoch: 1, sequence: 0, samples: pcm() });
    player.append({ epoch: 1, sequence: 1, samples: pcm() });
    await player.play();
    context[failure] = true;
    assert.throws(() => player.cancel(), /Audio cleanup failed/);
    assert.equal(player.snapshot().status, 'fault');
    assert.ok(player.snapshot().fault);
    assert.equal(player.begin(2), false);
    assert.ok(context.gains.every(gain => gain.disconnected));
    if (failure !== 'failStop') assert.ok(context.sources.every(source => source.stopped));
    if (failure !== 'failDisconnect') assert.ok(context.sources.every(source => source.disconnected));
    context[failure] = false;
    assert.equal(player.cancel(), true);
    assert.equal(player.begin(2), true);
  });
}

test('pause cleanup failure cannot masquerade as a successful paused state', async () => {
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  await player.play();
  context.failStop = true;
  assert.throws(() => player.pause(), /cleanup failed/);
  assert.equal(player.snapshot().status, 'fault');
  assert.equal(await player.resume(), false);
});

test('resume or node start failure enters fault and releases registered audio handles', async () => {
  for (const failure of ['failResume', 'failStart']) {
    const { context, player } = setup();
    player.append({ epoch: 1, sequence: 0, samples: pcm() });
    context[failure] = true;
    assert.equal(await player.play(), false);
    assert.equal(player.snapshot().status, 'fault');
    assert.ok(context.sources.every(source => source.disconnected && (source.stopped || source.when === undefined)));
    assert.equal(player.snapshot().sourceCount, 0);
  }
});

test('PCM is copied, volume is bounded, and an empty finished stream ends without audio', async () => {
  const { context, player } = setup();
  const samples = pcm();
  player.append({ epoch: 1, sequence: 0, samples });
  samples.fill(0);
  await player.play();
  assert.ok(context.sources[0].buffer.getChannelData(0)[0] > 0);
  near(context.gains[0].gain.value, 0.12);
  assert.equal(player.setVolume(5), true);
  near(context.gains[0].gain.value, 1);
  assert.equal(player.setVolume(NaN), false);
  player.cancel();
  player.begin(2);
  assert.equal(player.finish(2), true);
  assert.equal(player.snapshot().status, 'ended');
});

test('content ends at exact scheduled boundary despite fractional floating point and delayed callbacks', async () => {
  const { context, player } = setup();
  for (let sequence = 0; sequence < 19; sequence++) {
    player.append({ epoch: 1, sequence, samples: pcm(0.137) });
  }
  await player.play();
  const first = context.sources[0];
  first.onended(); // An early callback is not evidence that content was played.
  near(player.snapshot().time, 0);
  player.finish(1);
  const last = context.sources.at(-1);
  context.currentTime = last.when + last.duration;
  assert.equal(player.snapshot().status, 'ended');
  near(player.snapshot().time, 19 * 0.137);
});

test('retention cap bounds live memory rather than limiting total response length', async () => {
  const { context, player } = setup({ maxBufferedSeconds: 1, maxRetainedSeconds: 1 });
  await player.play();
  for (let sequence = 0; sequence < 125; sequence++) {
    assert.equal(player.append({ epoch: 1, sequence, samples: pcm() }), true);
    context.advance(1.05);
    assert.equal(player.snapshot().retainedSeconds, 0);
    assert.equal(player.snapshot().sourceCount, 0);
  }
  near(player.snapshot().time, 125);
  assert.equal(player.finish(1), true);
  assert.equal(player.snapshot().status, 'ended');
});

test('invalid constructor limits and invalid epochs/sample rates cannot replace active playback', async () => {
  for (const limits of [{ leadSeconds: -1 }, { maxBufferedSeconds: 0 }, { maxRetainedSeconds: Infinity }]) {
    assert.throws(() => new StreamingAudioTransport(new FakeContext(), limits), RangeError);
  }
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  await player.play();
  for (const epoch of [0, 1, -1, 1.5, NaN, Infinity]) assert.equal(player.begin(epoch), false);
  assert.equal(player.begin(2, { sampleRate: NaN }), false);
  assert.equal(context.sources[0].stopped, false);
  assert.equal(player.snapshot().epoch, 1);
});

test('late rejected resume cannot fault a replacement epoch', async () => {
  const { context, player } = setup();
  let rejectResume;
  context.pendingResume = new Promise((_, reject) => { rejectResume = reject; });
  const playing = player.play();
  assert.equal(player.begin(2), true);
  rejectResume(new Error('stale rejected resume'));
  assert.equal(await playing, false);
  assert.equal(player.snapshot().epoch, 2);
  assert.equal(player.snapshot().status, 'buffering');
  assert.equal(player.snapshot().fault, null);
});

test('external AudioContext closure is faulted and nodes are disconnected', async () => {
  const { context, player } = setup();
  player.append({ epoch: 1, sequence: 0, samples: pcm() });
  await player.play();
  context.state = 'closed';
  assert.equal(player.snapshot().status, 'fault');
  assert.match(player.snapshot().fault, /closed/);
  assert.equal(context.sources[0].disconnected, true);
  assert.equal(await player.resume(), false);
});
