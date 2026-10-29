import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function meter() {
  const source = readFileSync(new URL('../realtime/action-preservation-live/probe.js', import.meta.url), 'utf8');
  const code = source.match(/const code=`([\s\S]*?)`;/)[1];
  const messages = [];
  let Processor;
  const sandbox = { sampleRate: 48000, currentFrame: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => messages.push(value) }; } },
    registerProcessor(name, constructor) { Processor = constructor; } };
  vm.runInNewContext(code, sandbox);
  const processor = new Processor();
  const step = signal => {
    const output = new Float32Array(128);
    processor.process(signal === null ? [[]] : [[new Float32Array(128).fill(signal)]], [[output]]);
    assert.ok(output.every(x => x === 0), 'measurement branch must never duplicate audible output');
    sandbox.currentFrame += 128;
  };
  return { step, messages };
}

test('output meter records explicit silence after disconnected input, not missing observations', () => {
  const { step, messages } = meter();
  for (let i = 0; i < 4; i++) step(.2);
  for (let i = 0; i < 8; i++) step(null);
  assert.equal(messages.length, 3);
  assert.ok(messages[0][2] > .19);
  assert.equal(messages[1][2], 0);
  assert.equal(messages[2][2], 0);
  assert.equal(messages[1][0], 512 / 48000);
  assert.equal(messages[2][0], 1024 / 48000);
});

test('output meter retains a partial final voiced block before the silence boundary', () => {
  const { step, messages } = meter();
  step(.1);
  for (let i = 0; i < 7; i++) step(null);
  assert.equal(messages.length, 2);
  assert.ok(messages[0][2] > .09);
  assert.equal(messages[1][2], 0);
  assert.equal(messages[0][1], 512 / 48000);
});
