import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenClient } from '../qwen/client.mjs';

function fixture(t) {
  let now = 100;
  const log = [], events = [], sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) { const command = JSON.parse(value); this.sent.push(command); log.push(['send', command.type]); }
    receive(value) { this.onmessage?.({ data: JSON.stringify({ connectionId: 'c1', ...value }) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = { state: 'suspended', async resume() { this.state = 'running'; } };
  const state = { status: 'idle', time: 0, epoch: 0, finished: false };
  const session = { owner: null, revoked: false, connectionId: null, chunks: [], subtitles: [],
    audio: { snapshot: () => ({ ...state }) },
    snapshot() { return { revoked: this.revoked }; },
    setConnection(value) { this.connectionId = value; return true; },
    beginResponse(value) {
      log.push(['begin', value.responseId]);
      this.owner = Object.freeze({ connectionId: value.connectionId, responseId: value.responseId, epoch: ++state.epoch });
      Object.assign(state, { status: 'buffering', finished: false }); this.revoked = false; this.next = 0; return this.owner;
    },
    appendPcm(input) {
      assert.equal(input.owner, this.owner); assert.equal(input.sequence, this.next++);
      this.chunks.push(input); state.status = 'playing'; log.push(['pcm', input.samples.length]); return true;
    },
    pushSubtitle(text, options) { this.subtitles.push({ text, ...options }); log.push(['subtitle', text]); return { accepted: true }; },
    finishAudio(owner) { if (owner !== this.owner) return false; state.finished = true; log.push(['finish_audio']); return true; },
    finishSubtitles(owner) { log.push(['finish_subtitles', owner.responseId]); return true; },
    providerDone(owner) { log.push(['provider_done', owner.responseId]); return true; },
    cancel(reason, owner) {
      log.push(['local_cancel', reason]);
      if (owner !== this.owner) return false;
      state.status = 'cancelled'; this.revoked = true; return true;
    },
  };
  const client = new QwenClient({ context, session, WebSocketCtor: FakeSocket, clock: () => now, onEvent: event => events.push(event) });
  const connect = async (mode = 'manual') => {
    const promise = client.connect(mode); await new Promise(resolve => setImmediate(resolve));
    const socket = sockets.at(-1); socket.open(); socket.receive({ type: 'ready', mode, inputSampleRate: 16000, outputSampleRate: 24000 });
    assert.equal(await promise, client); return socket;
  };
  const provider = (socket, event, extra = {}) => socket.receive({ type: 'provider', event, ...extra });
  const created = (socket, responseId = 'r1', extra = {}) => provider(socket,
    { type: 'response.created', response: { id: responseId } }, { requestId: client.currentTrial?.requestId, ...extra });
  const done = (socket, responseId = 'r1', status = 'completed', extra = {}) => provider(socket,
    { type: 'response.done', response: { id: responseId, status, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }, extra);
  const pcm = frames => Buffer.alloc(frames * 2, 127).toString('base64');
  t.after(() => client.close());
  return { client, context, session, state, log, events, sockets, connect, provider, created, done, pcm,
    advance: ms => { now += ms; } };
}

test('manual handshake, PCM splitting and subtitle delivery have independent synchronous paths', async t => {
  const f = fixture(t), socket = await f.connect();
  assert.deepEqual(socket.sent[0], { type: 'connect', mode: 'manual' });
  const requestId = f.client.sendText('你好。'); assert.ok(requestId); f.created(socket);
  f.advance(10); f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(60000) });
  assert.deepEqual(f.session.chunks.map(chunk => chunk.samples.length), [24000, 24000, 12000]);
  assert.deepEqual(f.session.chunks.map(chunk => chunk.sequence), [0, 1, 2]);
  assert.equal(f.client.currentTrial.outputFrames, 60000);
  f.provider(socket, { type: 'response.audio_transcript.delta', response_id: 'r1', item_id: 'i1', delta: '你好，' });
  f.provider(socket, { type: 'response.audio_transcript.delta', response_id: 'r1', item_id: 'i1', delta: '很高兴。' });
  assert.deepEqual(f.session.subtitles.map(chunk => chunk.sequence), [0, 1]);
  assert.equal(f.client.currentTrial.transcript, '你好，很高兴。');
  assert.equal(f.client.currentTrial.firstPcmAt, 110); assert.equal(f.client.currentTrial.firstSubtitleAt, 110);
  assert.equal(f.client.sendText('不能并发'), null);
});

test('local input observation runs after network send and cannot fail or cancel input', async t => {
  const f = fixture(t), socket = await f.connect();
  const token = { connectionId: 'c1', interactionGeneration: 4 };
  f.session.interactionToken = () => token;
  f.session.observePartnerPcm = input => {
    assert.equal(socket.sent.at(-1).type, 'input_audio');
    assert.equal(input.token, token); assert.equal(input.sampleRate, 16000);
    f.log.push(['observe_pcm']); throw new Error('visual failure');
  };
  assert.equal(f.client.sendInput(new Int16Array(320)), true);
  assert.equal(f.client.inputSequence, 1);
  assert.ok(f.log.some(event => event[0] === 'observe_pcm'));
  assert.ok(!f.log.some(event => event[0] === 'local_cancel'));
});

test('provider completion never finishes local audio; a new request waits for actual playback drain', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket);
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(2400) }); f.done(socket);
  assert.equal(f.state.finished, false); assert.equal(f.client.sendText('还在播'), null);
  f.provider(socket, { type: 'response.audio.done', response_id: 'r1' }); assert.equal(f.state.finished, true);
  assert.equal(f.client.sendText('还在播'), null); f.state.status = 'ended';
  assert.ok(f.client.sendText('下一轮。')); f.created(socket, 'r2');
  assert.equal(f.session.owner.responseId, 'r2');
});

test('cancel stops local resources before network send, then late audio and text cannot enter renderer', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket);
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(2400) });
  f.advance(50); assert.equal(f.client.cancel('local_vad'), true);
  assert.deepEqual(f.log.slice(-2), [['local_cancel', 'local_vad'], ['send', 'cancel']]);
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(2400) });
  f.provider(socket, { type: 'response.audio_transcript.delta', response_id: 'r1', delta: '过期。' });
  assert.equal(f.session.chunks.length, 1); assert.equal(f.session.subtitles.length, 0);
  socket.receive({ type: 'cancel_ack', responseId: 'r1', requestId: f.client.currentTrial.requestId, remoteNeeded: true });
  f.advance(20); f.done(socket, 'r1', 'cancelled', { revoked: true });
  assert.equal(f.client.currentTrial.cancelAt, 150); assert.equal(f.client.currentTrial.cancelAckAt, 150);
  assert.equal(f.client.currentTrial.remoteCancelDoneAt, 170);
  assert.deepEqual(f.client.currentTrial.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  assert.ok(f.client.sendText('下一轮')); f.created(socket, 'r2');
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(100), }, { revoked: true });
  assert.equal(f.session.owner.responseId, 'r2'); assert.equal(f.session.chunks.length, 1);
});

test('cancel before response.created revokes the pending reply without ever opening a renderer epoch', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。');
  assert.equal(f.client.cancel(), true); f.created(socket, 'r1', { revoked: true });
  assert.equal(f.session.owner, null);
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(100) }, { revoked: true });
  assert.equal(f.session.chunks.length, 0); f.done(socket, 'r1', 'cancelled', { revoked: true });
  assert.ok(f.client.sendText('下一轮'));
});

test('duplicate created and unknown response data never claim a fresh epoch', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket); const owner = f.session.owner;
  f.created(socket); assert.equal(f.session.owner, owner); assert.equal(f.state.epoch, 1);
  f.provider(socket, { type: 'response.audio.delta', response_id: 'unknown', delta: f.pcm(100) });
  assert.equal(f.session.chunks.length, 0); assert.equal(f.client.ready, true);
});

test('manual input has continuous little-endian PCM sequence and commit preserves caller trial metadata', async t => {
  const f = fixture(t), socket = await f.connect();
  const trial = f.client.prepareInput({ sidecar: false, profile: 'gentle' });
  trial.kind = 'audio-fixture'; trial.inputLastSpeechAt = 654;
  const samples = new Int16Array(1600); samples[0] = -32768; samples[1] = 32767;
  assert.equal(f.client.sendInput(samples), true); assert.equal(f.client.sendInput(samples), true);
  const input = socket.sent.filter(command => command.type === 'input_audio');
  assert.deepEqual(input.map(command => command.sequence), [0, 1]);
  assert.deepEqual([...Buffer.from(input[0].audio, 'base64').subarray(0, 4)], [0, 128, 255, 127]);
  assert.equal(f.client.commit(), trial.requestId); assert.equal(f.client.currentTrial, trial);
  assert.equal(trial.sidecar, false); assert.equal(trial.profile, 'gentle');
  assert.equal(trial.inputLastSpeechAt, 654); assert.equal(f.client.commit(), null);
  f.created(socket); assert.equal(f.client.currentTrial, trial);
  assert.equal(f.client.snapshot().trials[0].inputLastSpeechAt, 654);
});

test('VAD input trial binds provider request ID; speech-start barge-in cancels active output', async t => {
  const f = fixture(t), socket = await f.connect('vad');
  const first = f.client.prepareInput(); first.inputStartAt = 90;
  f.provider(socket, { type: 'input_audio_buffer.speech_started' });
  f.created(socket, 'r1', { requestId: 'vad-server-1' }); assert.equal(first.requestId, 'vad-server-1');
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(1000) });
  f.advance(20); f.provider(socket, { type: 'input_audio_buffer.speech_started' });
  assert.equal(first.revoked, true); assert.equal(f.state.status, 'cancelled');
  const second = f.client.currentTrial; assert.notEqual(second, first);
  f.done(socket, 'r1', 'cancelled', { revoked: true }); f.created(socket, 'r2', { requestId: 'vad-server-2' });
  assert.equal(second.requestId, 'vad-server-2'); assert.equal(second.owner.responseId, 'r2');
});

test('late server VAD after a local interruption still prepares the next input trial', async t => {
  const f = fixture(t), socket = await f.connect('vad'); f.client.prepareInput();
  f.created(socket, 'r1', { requestId: 'vad-server-1' });
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(100) });
  f.client.cancel('local_vad'); f.provider(socket, { type: 'input_audio_buffer.speech_started' });
  assert.equal(f.client.currentTrial.phase, 'input');
  assert.equal(socket.sent.filter(command => command.type === 'cancel').length, 1);
});

test('a completed provider reply still playing needs only a local cancel acknowledgement', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket);
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(100) }); f.done(socket);
  assert.equal(f.client.cancel(), true);
  socket.receive({ type: 'cancel_ack', responseId: 'r1', requestId: f.client.currentTrial.requestId, remoteNeeded: false });
  assert.equal(f.client.currentTrial.cancelScope, 'local_playback'); assert.equal(f.client.currentTrial.remoteCancelNeeded, false);
});

test('socket failure cancels locally, marks unsettled usage unknown and does not reconnect', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket);
  socket.onerror(); assert.equal(f.client.ready, false); assert.equal(f.state.status, 'cancelled');
  assert.equal(f.client.currentTrial.usageStatus, 'unknown'); assert.equal(f.sockets.length, 1);
  assert.equal(f.client.sendInput(new Int16Array(1600)), false);
});

test('malformed PCM fails closed and old connection callbacks cannot operate a new socket', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket);
  const oldCallback = socket.onmessage;
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: 'not base64' });
  assert.equal(f.client.ready, false); assert.equal(f.client.lastError, 'invalid_output_pcm');
  const second = await f.connect();
  oldCallback({ data: JSON.stringify({ connectionId: 'old', type: 'error', code: 'stale' }) });
  assert.equal(f.client.ready, true); assert.equal(f.client.socket, second);
});

test('input ASR remains observable and is never mistaken for assistant action text', async t => {
  const f = fixture(t), socket = await f.connect();
  f.provider(socket, { type: 'conversation.item.input_audio_transcription.completed', transcript: '请解释。' });
  assert.equal(f.events.at(-1).type, 'input_transcript'); assert.equal(f.session.subtitles.length, 0);
});

test('close during handshake rejects readiness and never creates a late socket', async t => {
  const f = fixture(t); let release;
  f.context.resume = () => new Promise(resolve => { release = resolve; });
  const promise = f.client.connect(); await Promise.resolve(); f.client.close(); release();
  await assert.rejects(promise, /client_close/); await Promise.resolve();
  assert.equal(f.sockets.length, 0);
});

test('double connect during pending AudioContext resume cannot create two sockets', async t => {
  const f = fixture(t); let release;
  f.context.resume = () => new Promise(resolve => { release = () => { f.context.state = 'running'; resolve(); }; });
  const first = f.client.connect(); await Promise.resolve();
  await assert.rejects(f.client.connect(), /already_connected/); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: 'ready', mode: 'manual', inputSampleRate: 16000, outputSampleRate: 24000 });
  await first;
});

test('cancelling uncommitted input closes its buffer and cannot later commit revoked samples', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.prepareInput(); f.client.sendInput(new Int16Array(1600));
  assert.equal(f.client.cancel('abort_input'), true); assert.equal(f.client.ready, false);
  assert.equal(f.client.commit(), null); assert.equal(f.client.sendInput(new Int16Array(1600)), false);
  assert.equal(socket.sent.some(command => command.type === 'commit'), false);
  assert.equal(socket.sent.at(-1).type, 'close');
});

test('old VAD response settlement cannot consume a new input trial prepared during interruption', async t => {
  const f = fixture(t), socket = await f.connect('vad'); f.client.prepareInput(); f.created(socket, 'r1', { requestId: 'server-vad-1' });
  f.provider(socket, { type: 'response.audio.delta', response_id: 'r1', delta: f.pcm(100) });
  f.client.cancel('local_vad'); const next = f.client.prepareInput(); assert.ok(next);
  f.provider(socket, { type: 'input_audio_buffer.speech_started' }); assert.equal(f.client.currentTrial, next);
  f.done(socket, 'r1', 'cancelled', { revoked: true }); assert.equal(f.client.currentTrial, next);
  f.created(socket, 'r2', { requestId: 'server-vad-2' }); assert.equal(f.client.currentTrial, next);
  assert.equal(next.owner.responseId, 'r2');
});

test('automatic subsequent VAD trials retain the last explicit sidecar settings', async t => {
  const f = fixture(t), socket = await f.connect('vad'); f.client.prepareInput({ sidecar: false, profile: 'gentle' });
  f.created(socket, 'r1', { requestId: 'server-vad-1' }); f.done(socket); f.state.status = 'ended';
  f.provider(socket, { type: 'input_audio_buffer.speech_started' });
  assert.equal(f.client.currentTrial.sidecar, false); assert.equal(f.client.currentTrial.profile, 'gentle');
});

test('closing a naturally ended trial does not manufacture an interruption measurement', async t => {
  const f = fixture(t), socket = await f.connect(); f.client.sendText('你好。'); f.created(socket);
  f.done(socket); f.state.status = 'ended'; f.client.close();
  assert.equal(f.client.currentTrial.cancelAt, null);
});

test('trusted input events use a local interaction token before a response exists', async t => {
  const f = fixture(t), transitions = []; let generation = 0;
  f.session.inputStarted = connectionId => { const token = { connectionId, interactionGeneration: ++generation }; transitions.push(['start', token]); return token; };
  f.session.inputEnded = token => { transitions.push(['end', token]); return true; };
  f.session.inputCancelled = token => { transitions.push(['cancel', token]); return true; };
  const socket = await f.connect();
  f.client.sendText('请想一下再回答。');
  assert.deepEqual(transitions.map(x => x[0]), ['start', 'end']);
  assert.equal(transitions[0][1], transitions[1][1]);
  assert.equal(transitions[0][1].connectionId, 'c1');
  assert.equal(Object.hasOwn(transitions[0][1], 'responseId'), false);
  f.client.cancel();
  assert.equal(transitions.at(-1)[0], 'cancel');
  f.created(socket, 'late-revoked');
  assert.equal(f.session.owner, null, 'late created cannot open a visual response');
});

test('arming VAD while speaking does not itself interrupt; actual speech boundary updates the new token', async t => {
  const f = fixture(t), transitions = []; let generation = 0;
  f.session.inputStarted = connectionId => { const token = { connectionId, interactionGeneration: ++generation }; transitions.push(['start', token]); return token; };
  f.session.inputEnded = token => { transitions.push(['end', token]); return true; };
  const socket = await f.connect('vad'); f.client.prepareInput(); f.created(socket);
  f.state.status = 'playing'; transitions.length = 0;
  f.client.prepareInput();
  assert.equal(transitions.length, 0, 'microphone arming is not VAD');
  f.provider(socket, { type: 'input_audio_buffer.speech_started' });
  assert.equal(transitions.at(-1)[0], 'start');
  const token = transitions.at(-1)[1];
  f.provider(socket, { type: 'input_audio_buffer.speech_stopped' });
  assert.deepEqual(transitions.at(-1), ['end', token]);
  assert.ok(f.log.some(row => row[0] === 'local_cancel' && row[1] === 'server_vad'));
});

test('arming VAD after natural end preserves the attitude until real speech starts', async t => {
  const f = fixture(t), transitions = [];
  f.session.inputStarted = connectionId => { const token = { connectionId, interactionGeneration: 1 }; transitions.push(['start', token]); return token; };
  f.session.inputEnded = token => { transitions.push(['end', token]); return true; };
  const socket = await f.connect('vad'); f.client.prepareInput(); f.created(socket);
  f.done(socket); f.state.status = 'ended'; transitions.length = 0;
  assert.ok(f.client.prepareInput());
  assert.equal(transitions.length, 0, 'quiet microphone arming must preserve previous attitude and body tail');
  f.provider(socket, { type: 'input_audio_buffer.speech_started' });
  assert.equal(transitions.length, 1);
  f.provider(socket, { type: 'input_audio_buffer.speech_stopped' });
  assert.deepEqual(transitions.at(-1), ['end', transitions[0][1]]);
});
