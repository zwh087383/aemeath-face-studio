import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingAudioTransport} from '../stream-audio.mjs';

class FakeContext {
  currentTime = 0;
  state = 'suspended';
  destination = {};
  sources = [];
  async resume() { this.state = 'running'; }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {length, sampleRate, getChannelData: () => data};
  }
  createGain() {
    return {gain: {value: 1, cancelScheduledValues() {}, setValueAtTime() {}}, connect() {}, disconnect() {}};
  }
  createBufferSource() {
    const source = {
      stopped: false, onended: null, connect() {}, disconnect() {},
      start(when, offset, duration) { Object.assign(this, {when, offset, duration}); },
      stop() { this.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }
  advance(seconds, callbacks = false) {
    if (this.state !== 'running') return;
    this.currentTime += seconds;
    if (callbacks) for (const source of this.sources) {
      if (!source.stopped && this.currentTime >= source.when + source.duration) source.onended?.();
    }
  }
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function setup() {
  const context = new FakeContext();
  const audio = new StreamingAudioTransport(context);
  audio.begin(1, {sampleRate: 8000});
  let sequence = 0;
  const append = seconds => assert.equal(audio.append({epoch: 1, sequence: sequence++, samples: new Float32Array(seconds * 8000)}), true);
  return {context, audio, append};
}

test('390 ms marker in a 400 ms chunk survives a missed voiced tail and source pruning', async () => {
  const {context, audio, append} = setup();
  assert.equal(audio.setPlaybackMarker(.39), true);
  assert.deepEqual(audio.playbackMarker(), {mediaTime: .39, contextTime: null, reached: false});
  append(.4);
  await audio.play();
  near(audio.playbackMarker().contextTime, .43);
  assert.equal(audio.playbackMarker().reached, false);
  context.advance(.6);
  assert.equal(audio.snapshot().status, 'buffering');
  assert.equal(audio.snapshot().sourceCount, 0);
  near(audio.playbackMarker().contextTime, .43);
  assert.equal(audio.playbackMarker().reached, true);
});

test('onended callback retains marker before pruning even without any RAF or snapshot', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.39);
  append(.4);
  await audio.play();
  context.advance(.6, true);
  assert.equal(audio._sources.length, 0);
  assert.equal(audio.playbackMarker().reached, true);
  near(audio.playbackMarker().contextTime, .43);
});

test('context suspension cannot advance a pending marker but retains one reached before suspension', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.39);
  append(.4);
  await audio.play();
  context.advance(.2);
  context.state = 'suspended';
  context.advance(5);
  assert.equal(audio.playbackMarker().reached, false);
  await context.resume();
  context.advance(.4);
  context.state = 'suspended';
  audio.snapshot();
  assert.equal(audio.playbackMarker().reached, true);
  near(audio.playbackMarker().contextTime, .43);
});

test('marker in a later chunk includes the real underrun rather than virtual media time', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.45);
  append(.4);
  await audio.play();
  context.advance(2);
  assert.equal(audio.snapshot().status, 'buffering');
  assert.deepEqual(audio.playbackMarker(), {mediaTime: .45, contextTime: null, reached: false});
  append(.2);
  near(audio.playbackMarker().contextTime, 2.09);
  context.advance(.1);
  assert.equal(audio.playbackMarker().reached, true);
});

test('a chunk boundary marker belongs to the next scheduled chunk', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.4);
  append(.4);
  await audio.play();
  context.advance(1);
  audio.snapshot();
  assert.equal(audio.playbackMarker().contextTime, null);
  append(.2);
  near(audio.playbackMarker().contextTime, 1.04);
  assert.equal(audio.playbackMarker().reached, false);
  context.advance(.05);
  assert.equal(audio.playbackMarker().reached, true);
});

test('pause before marker invalidates scheduled timestamp and resume retimes from retained offset', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.39);
  append(.4);
  await audio.play();
  context.advance(.2);
  audio.pause();
  assert.deepEqual(audio.playbackMarker(), {mediaTime: .39, contextTime: null, reached: false});
  context.advance(2);
  assert.equal(audio.playbackMarker().reached, false);
  await audio.resume();
  near(audio.playbackMarker().contextTime, 2.47);
  context.advance(.3);
  assert.equal(audio.playbackMarker().reached, true);
  near(audio.playbackMarker().contextTime, 2.47);
});

test('cancel before marker cannot produce a false reached timestamp from an old source callback', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.39);
  append(.4);
  await audio.play();
  const lateCallback = context.sources[0].onended;
  context.advance(.2);
  audio.cancel();
  context.advance(5);
  lateCallback();
  assert.deepEqual(audio.playbackMarker(), {mediaTime: .39, contextTime: null, reached: false});
});

test('cancel after marker preserves historical timing and begin clears the prior epoch', async () => {
  const {context, audio, append} = setup();
  audio.setPlaybackMarker(.39);
  append(.4);
  await audio.play();
  context.advance(.435);
  audio.cancel();
  assert.equal(audio.playbackMarker().reached, true);
  near(audio.playbackMarker().contextTime, .43);
  assert.equal(audio.begin(2), true);
  assert.equal(audio.playbackMarker(), null);
});

test('setting a marker after scheduling binds it without restarting audio', async () => {
  const {context, audio, append} = setup();
  append(.4);
  await audio.play();
  context.advance(.2);
  assert.equal(audio.setPlaybackMarker(.39), true);
  near(audio.playbackMarker().contextTime, .43);
  assert.equal(context.sources.length, 1);
  const marker = audio.playbackMarker();
  marker.contextTime = 999;
  near(audio.playbackMarker().contextTime, .43);
});

test('invalid and already consumed markers do not fabricate history or disturb the current marker', async () => {
  const {context, audio, append} = setup();
  for (const bad of [-1, NaN, Infinity, '0']) assert.equal(audio.setPlaybackMarker(bad), false);
  assert.equal(audio.playbackMarker(), null);
  append(.4);
  await audio.play();
  context.advance(.6);
  audio.snapshot();
  assert.equal(audio.setPlaybackMarker(.1), false);
  assert.equal(audio.playbackMarker(), null);
  audio.setPlaybackMarker(.5);
  assert.equal(audio.setPlaybackMarker(NaN), false);
  assert.deepEqual(audio.playbackMarker(), {mediaTime: .5, contextTime: null, reached: false});
});
