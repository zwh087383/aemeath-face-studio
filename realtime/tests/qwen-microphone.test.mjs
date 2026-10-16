import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { captureMicrophone } from '../qwen/input-audio.mjs';

function microphoneFixture(t, { moduleFailure = false, disconnectFailure = false, trackFailure = false } = {}) {
  const previous = new Map(['navigator', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const tracks = [0, 1].map(index => ({ calls: 0, stop() {
    this.calls++; if (trackFailure && index === 0) throw new Error('fake_track_failure');
  } }));
  const stream = { getTracks: () => tracks }, nodes = [], constraints = [], modules = [];
  const node = name => {
    const value = { name, connections: [], disconnects: 0,
      connect(target) { this.connections.push(target); },
      disconnect() { this.disconnects++; if (disconnectFailure && name === 'source') throw new Error('fake_disconnect_failure'); } };
    nodes.push(value); return value;
  };
  const context = { destination: {}, audioWorklet: { async addModule(url) {
    modules.push(url); if (moduleFailure) throw new Error('fake_module_failure');
  } }, createMediaStreamSource(value) { assert.equal(value, stream); return node('source'); },
  createGain() { return Object.assign(node('silent'), { gain: { value: 1 } }); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { async getUserMedia(value) { constraints.push(value); return stream; } },
  } });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    constructor(value, name) {
      assert.equal(value, context); assert.equal(name, 'qwen-mic-pcm');
      return Object.assign(node('processor'), { port: { onmessage: null } });
    }
  } });
  return { context, tracks, nodes, constraints, modules };
}

test('microphone stop releases every node/track once and suppresses already-queued callbacks', async t => {
  const f = microphoneFixture(t), chunks = [];
  const handle = await captureMicrophone(f.context, (pcm, level) => chunks.push({ pcm: [...pcm], level }));
  assert.equal(f.constraints.length, 1); assert.equal(f.constraints[0].audio.channelCount, 1);
  assert.equal(f.constraints[0].audio.echoCancellation, true);
  assert.ok(f.modules[0].pathname.endsWith('/qwen/mic-worklet.mjs'));
  const [source, processor, silent] = f.nodes;
  assert.equal(silent.gain.value, 0); assert.equal(silent.connections[0], f.context.destination);
  assert.equal(source.connections[0], processor); assert.equal(processor.connections[0], silent);
  const queuedCallback = processor.port.onmessage;
  queuedCallback({ data: { pcm: Int16Array.of(123, -456).buffer, rms: .25 } });
  assert.deepEqual(chunks, [{ pcm: [123, -456], level: .25 }]);
  handle.stop(); handle.stop();
  assert.equal(processor.port.onmessage, null);
  assert.ok(f.nodes.every(value => value.disconnects === 1));
  assert.ok(f.tracks.every(value => value.calls === 1));
  queuedCallback({ data: { pcm: Int16Array.of(789).buffer, rms: .5 } });
  assert.equal(chunks.length, 1);
});

test('node disconnect and one track failure cannot prevent the remaining microphone tracks from stopping', async t => {
  const f = microphoneFixture(t, { disconnectFailure: true, trackFailure: true });
  const handle = await captureMicrophone(f.context, () => assert.fail('no PCM expected'));
  assert.doesNotThrow(() => handle.stop());
  assert.ok(f.nodes.every(value => value.disconnects === 1));
  assert.ok(f.tracks.every(value => value.calls === 1));
});

test('failed AudioWorklet module load releases the acquired MediaStream before rejecting', async t => {
  const f = microphoneFixture(t, { moduleFailure: true });
  await assert.rejects(captureMicrophone(f.context, () => {}), /fake_module_failure/);
  assert.equal(f.nodes.length, 0); assert.equal(f.modules.length, 1);
  assert.ok(f.tracks.every(value => value.calls === 1));
});

const workletSource = readFileSync(new URL('../qwen/mic-worklet.mjs', import.meta.url), 'utf8');
function processorAt(rate) {
  let Processor; const packets = [];
  class FakeProcessor {
    constructor() { this.port = { postMessage(message, transfer) {
      assert.equal(transfer.length, 1); assert.equal(transfer[0], message.pcm);
      // Detach the producer buffer as a real transferable postMessage does.
      const received = structuredClone(message, { transfer });
      packets.push({ pcm: new Int16Array(received.pcm), rms: received.rms });
    } }; }
  }
  runInNewContext(workletSource, { AudioWorkletProcessor: FakeProcessor, sampleRate: rate,
    registerProcessor(name, constructor) { assert.equal(name, 'qwen-mic-pcm'); Processor = constructor; } },
  { filename: 'mic-worklet.mjs' });
  return { processor: new Processor(), packets };
}

test('one second of microphone input becomes fifty 320-sample packets at 16k, 44.1k and 48k; monitor output stays silent', () => {
  for (const rate of [16000, 44100, 48000]) {
    const { processor, packets } = processorAt(rate);
    for (let offset = 0; offset < rate; offset += 128) {
      const size = Math.min(128, rate - offset), input = new Float32Array(size).fill(.25);
      const monitor = [new Float32Array(size).fill(.8), new Float32Array(size).fill(-.8)];
      assert.equal(processor.process([[input]], [monitor]), true);
      assert.ok(monitor.every(channel => channel.every(sample => sample === 0)));
    }
    assert.equal(packets.length, 50, `${rate} Hz duration changed`);
    assert.equal(packets.reduce((sum, packet) => sum + packet.pcm.length, 0), 16000);
    assert.ok(packets.every(packet => packet.pcm.length === 320));
    assert.ok(packets.every(packet => packet.pcm.every(sample => sample === 8192)));
    assert.ok(packets.every(packet => Math.abs(packet.rms - .25) < 1e-10));
    assert.equal(new Set(packets.map(packet => packet.pcm.buffer)).size, 50);
  }
});

test('worklet retains partial packets across render quanta and bounds malformed microphone samples', () => {
  const { processor, packets } = processorAt(16000);
  processor.process([[new Float32Array(319).fill(.5)]], [[new Float32Array(128)]]);
  assert.equal(packets.length, 0);
  processor.process([], [[new Float32Array(128).fill(.9)]]);
  assert.equal(packets.length, 0);
  processor.process([[Float32Array.of(.5)]], [[new Float32Array(128)]]);
  assert.equal(packets.length, 1); assert.ok(packets[0].pcm.every(value => value === 16384));
  const malformed = Float32Array.from({ length: 320 }, (_, i) => [NaN, Infinity, -Infinity, 2, -2][i % 5]);
  processor.process([[malformed]], [[new Float32Array(128)]]);
  assert.equal(packets.length, 2);
  assert.deepEqual([...packets[1].pcm.slice(0, 5)], [0, 0, 0, 32767, -32767]);
  assert.ok(Number.isFinite(packets[1].rms) && packets[1].rms <= 1);
});
