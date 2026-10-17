import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DuplexClient } from '../duplex/client.mjs';
import { LiveAvatarSession } from '../qwen/live-session.mjs';
import { FaceController } from '../../preview/core/controller.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';

function setup({ realSession } = {}) {
  let now = 1000, begins = 0, finishes = 0;
  const sent = [], cues = [], appended = [];
  const audio = { status: 'buffering', time: 0, receivedDuration: 0, queuedSeconds: 0,
    sourceCount: 0, sourceActive: false, sampleRate: 24000, finished: false, epoch: 1 };
  const session = realSession ?? { owner: null, motion: { snapshot: () => ({ gestures: [{ id: 'wave' }] }) },
    audio: { snapshot: () => ({ ...audio }) }, setConnection: () => true,
    beginResponse: owner => { begins++; return (session.owner = { ...owner, epoch: 1 }); },
    appendPcm: ({ owner, sequence, samples }) => { appended.push({ owner, sequence, frames: samples.length });
      audio.sourceCount++; audio.receivedDuration += samples.length / 24000; return true; },
    finishAudio: () => { finishes++; audio.finished = true; return true; }, providerDone: () => true,
    enqueue: (cue, owner) => { cues.push({ cue, owner }); return { accepted: true }; },
    cancel: () => { audio.status = 'cancelled'; audio.sourceCount = 0; audio.queuedSeconds = 0; return true; },
    pause: () => { audio.status = 'paused'; audio.sourceCount = 0; return true; },
    resume: async () => { audio.status = 'playing'; return true; }, sync: () => ({ ...audio }) };
  const client = new DuplexClient({ session, clock: () => now });
  client.socket = { readyState: 1, send: text => sent.push(JSON.parse(text)) };
  const send = (type, fields = {}) => client.message({ type, connectionId: 'browser', turnId: 'turn', ...fields });
  send('ready', { variant: 'qwen-direct', budget: {}, listenerConfiguration: {} });
  send('turn_started', { text: '请根据记忆回答，需要的话再分析。' });
  const segments = [];
  const open = (index = 0, phase = index ? 'full' : 'direct') => {
    const startFrame = segments.reduce((n, segment) => n + segment.frames, 0);
    const segment = { index, connectionId: `provider${index}`, responseId: `response${index}`,
      phase, startFrame, frames: 0, audioDone: true, transcriptDone: true, status: 'completed' };
    const metadata = { segmentIndex: index, phase, startFrame, providerConnectionId: segment.connectionId, responseId: segment.responseId };
    send('request_sent', metadata); send('response_created', metadata); segments.push(segment);
    const event = (type, fields = {}) => send(type, { ...metadata, ...fields });
    let transcript = '';
    return { segment, metadata, event,
      audio(frames = 24000) { segment.frames += frames; event('audio', { pcm: Buffer.alloc(frames * 2, 32).toString('base64') }); },
      subtitle(text) { transcript += text; event('subtitle', { delta: text }); },
      tool(callId = 'same-provider-call') { event('tool', { callId, name: 'perform_avatar', arguments: '{"expression":"smile","gesture":"wave"}' }); },
      done() { event('audio_done'); event('response_done', { result: { ...segment, transcript } }); },
      handoff() { event('handoff_requested', { callId: 'handoff', reason: 'long_answer' }); } };
  };
  const finish = transcript => {
    const last = segments.at(-1), frames = segments.reduce((n, s) => n + s.frames, 0);
    const result = { connectionId: last.connectionId, responseId: last.responseId, frames, transcript,
      status: 'completed', audioDone: true, transcriptDone: true, segments: structuredClone(segments) };
    send('turn_output_done', { providerConnectionId: last.connectionId, responseId: last.responseId, result });
    return result;
  };
  const delivery = result => send('delivery', { deliveryId: 'delivery', responseId: result.responseId,
    providerConnectionId: result.connectionId, expectedFrames: result.frames, segments: structuredClone(result.segments) });
  const played = frames => { Object.assign(audio, { status: 'ended', finished: true, time: frames / 24000,
    receivedDuration: frames / 24000, queuedSeconds: 0, sourceCount: 0, sourceActive: false }); client.sync(); };
  return { client, audio, session, send, open, finish, delivery, played, sent, cues, appended,
    advance: n => now += n, get begins() { return begins; }, get finishes() { return finishes; } };
}

test('direct answer plays without a second response and ACKs exactly one segment after playback', () => {
  const f = setup(), one = f.open(); one.audio(); one.subtitle('记得，你喜欢柠檬水。');
  assert.equal(f.appended.length, 1); assert.equal(f.finishes, 0);
  one.done(); assert.equal(f.finishes, 0);
  const result = f.finish('记得，你喜欢柠檬水。'); f.delivery(result);
  assert.equal(f.sent.length, 0); f.played(24000); f.client.sync();
  assert.equal(f.begins, 1); assert.equal(f.finishes, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].segments, result.segments); assert.equal(f.sent[0].frames, 24000);
});

test('handoff keeps one playback epoch, queues both voices in order, and settles their total once', () => {
  const f = setup(), one = f.open(); one.audio(); one.subtitle('我先确认一下。'); one.done(); one.handoff();
  const owner = f.client.current.owner;
  const two = f.open(1); two.audio(); two.subtitle('结合完整分析，答案是这样。'); two.done();
  assert.equal(f.begins, 1); assert.equal(f.client.current.owner, owner); assert.equal(f.finishes, 0);
  assert.deepEqual(f.appended.map(a => a.sequence), [0, 1]);
  assert.ok(f.appended.every(a => a.owner === owner));
  const result = f.finish('我先确认一下。\n结合完整分析，答案是这样。'); f.delivery(result);
  f.played(24000); assert.equal(f.sent.length, 0);
  f.played(48000); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].responseId, 'response1');
  assert.deepEqual(f.sent[0].segments, result.segments);
});

test('second segment action waits for its audio position and reused provider call IDs remain independent', () => {
  const f = setup(), one = f.open(); one.audio(); one.tool(); one.done(); one.handoff();
  assert.equal(f.cues.length, 2);
  const two = f.open(1); two.audio(); two.tool(); f.client.sync();
  assert.equal(f.cues.length, 2);
  Object.assign(f.audio, { time: 1, status: 'buffering' }); f.client.sync(); assert.equal(f.cues.length, 2);
  Object.assign(f.audio, { time: 1.01, status: 'playing', sourceActive: true }); f.client.sync();
  assert.equal(f.cues.length, 4); assert.notEqual(f.cues[0].cue.id, f.cues[2].cue.id);
  assert.ok(f.cues[2].cue.at >= 1.01); assert.equal(f.cues[3].cue.strength, .65);
  two.tool(); assert.equal(f.cues.length, 4);
  assert.equal(f.client.current.tools.at(-1).result.reason, 'duplicate_call');
});

test('tool-only handoff adds no fictitious audio and permits the second Qwen voice', () => {
  const f = setup(), one = f.open(); one.done(); one.handoff();
  assert.equal(f.appended.length, 0); assert.equal(f.cues.length, 0); assert.equal(f.finishes, 0);
  const two = f.open(1); assert.equal(two.segment.startFrame, 0); two.audio(); two.subtitle('完整分析的答案。'); two.done();
  const result = f.finish('完整分析的答案。'); f.delivery(result); f.played(24000);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].segments[0].frames, 0); assert.equal(f.begins, 1);
});

test('cancelling while full analysis waits clears the whole turn and drops late second audio and actions', () => {
  const f = setup(), one = f.open(); one.audio(); one.done(); one.handoff(); f.client.cancel();
  const two = f.open(1); two.audio(); two.tool(); two.done();
  const result = f.finish(''); f.delivery(result); f.played(48000);
  assert.equal(f.begins, 1); assert.equal(f.appended.length, 1); assert.equal(f.cues.length, 0);
  assert.equal(f.client.current.droppedPcm, 24000); assert.equal(f.finishes, 0);
  assert.deepEqual(f.sent.map(e => e.type), ['cancel']);
});

test('cancelling second voice prevents aggregate history confirmation even after terminal delivery', () => {
  const f = setup(), one = f.open(); one.audio(); one.done(); one.handoff();
  const two = f.open(1); two.audio(); two.tool(); f.client.cancel(); two.done();
  const result = f.finish(''); f.delivery(result); f.played(48000);
  assert.equal(f.audio.sourceCount, 0); assert.equal(f.cues.length, 0);
  assert.equal(f.sent.filter(e => e.type === 'playback_complete').length, 0);
});

test('duplicate or late segment events never append additional audio or restart the local epoch', () => {
  const f = setup(), one = f.open(); one.audio(); one.done();
  assert.throws(() => f.send('response_created', one.metadata), /owner_conflict/);
  assert.throws(() => one.event('audio', { pcm: Buffer.alloc(480).toString('base64') }), /late_segment_event/);
  assert.throws(() => one.done(), /late_segment_event/);
  assert.equal(f.appended.length, 1); assert.equal(f.begins, 1);
});

test('second response requires a completed explicit Qwen handoff and rejects wrong physical owners', () => {
  const f = setup(), one = f.open(); one.audio(); one.done();
  assert.throws(() => f.open(1), /segment_owner_conflict/);
  assert.throws(() => one.event('tool_receipt_send', { providerConnectionId: 'foreign' }), /segment_owner_conflict/);
  assert.equal(f.begins, 1);
});

test('handoff before first terminal, repeated handoff, and handoff by second Qwen are rejected', () => {
  const f = setup(), one = f.open(); assert.throws(() => one.handoff(), /invalid_handoff/);
  one.done(); one.handoff(); assert.throws(() => one.handoff(), /invalid_handoff/);
  const two = f.open(1); two.audio(); two.done(); assert.throws(() => two.handoff(), /invalid_handoff/);
});

test('aggregate or delivery identity mismatches cannot finish audio or confirm history', () => {
  const f = setup(), one = f.open(); one.audio(); one.done();
  assert.throws(() => f.send('turn_output_done', { responseId: 'response0', providerConnectionId: 'provider0',
    result: { frames: 24000, status: 'completed', audioDone: true, transcriptDone: true, segments: [] } }), /turn_output_conflict/);
  assert.equal(f.finishes, 0);
  const result = f.finish(''); result.segments[0].responseId = 'forged';
  assert.throws(() => f.delivery(result), /delivery_owner_conflict/);
  f.played(24000); assert.equal(f.sent.length, 0);
});

test('audio-free direct turn without a completed second voice cannot be marked delivered', () => {
  const f = setup(), one = f.open(); one.done();
  assert.throws(() => f.finish(''), /turn_output_conflict/); assert.equal(f.finishes, 0);
});

test('unknown usage blocks and cancels the full playback epoch without a delivery ACK', () => {
  const f = setup(), one = f.open(); one.audio();
  f.send('blocked', { code: 'provider_usage_missing_or_invalid', budget: { blocked: true, unknown: 1 } });
  assert.equal(f.client.blocked, true); assert.equal(f.client.current.revoked, true); assert.equal(f.audio.sourceCount, 0);
  assert.equal(f.sent.length, 0);
});

test('full-bypass single response remains explicit and cannot request another handoff', () => {
  const f = setup(), one = f.open(0, 'full-bypass'); one.audio(); one.subtitle('完整路径回答。'); one.done();
  assert.throws(() => one.handoff(), /invalid_handoff/);
  const result = f.finish('完整路径回答。'); f.delivery(result); f.played(24000); assert.equal(f.sent.length, 1);
});

test('real PCM transport survives the inter-Qwen gap and only ACKs after both scheduled sources drain', async t => {
  const context = { state: 'running', currentTime: 0, destination: {}, sources: [], async resume() {},
    createBuffer(channels, length, sampleRate) { const data = new Float32Array(length);
      return { length, duration: length / sampleRate, sampleRate, getChannelData: () => data }; },
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {} }, connect() {}, disconnect() {} }; },
    createBufferSource() { const source = { connect() {}, disconnect() {}, stop() { this.stopped = true; },
      start(when, offset, duration) { Object.assign(this, { when, offset, duration }); } };
      this.sources.push(source); return source; } };
  const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
  const session = new LiveAvatarSession({ context, face: new FaceController(), motion: new MotionController({ skeleton }),
    clock: () => context.currentTime, naturalConversation: false });
  t.after(() => session.dispose());
  const f = setup({ realSession: session }), one = f.open(); await session.playReady;
  one.audio(12000); one.subtitle('稍等。'); one.done();
  const epoch = session.owner.epoch; context.currentTime = .7; f.client.sync();
  assert.equal(session.audio.snapshot().status, 'buffering'); assert.equal(session.audio.snapshot().finished, false);
  assert.equal(f.sent.length, 0);
  one.handoff(); const two = f.open(1); two.audio(12000); two.subtitle('想好了。'); two.tool(); two.done();
  const result = f.finish('稍等。\n想好了。'); f.delivery(result);
  assert.equal(session.owner.epoch, epoch); assert.equal(session.metrics.responses, 1);
  assert.equal(context.sources.length, 2); assert.ok(context.sources[1].when >= context.sources[0].when + context.sources[0].duration);
  assert.equal(f.sent.length, 0); context.currentTime = .8; f.client.sync();
  assert.equal(f.client.current.tools[0].result.accepted, true);
  context.currentTime = 1.4; f.client.sync();
  assert.equal(session.audio.snapshot().status, 'ended'); assert.equal(session.audio.snapshot().sourceCount, 0);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].frames, 24000); assert.equal(f.sent[0].segments.length, 2);
});

function reconnectFixture() {
  const f = setup(), sockets = [];
  f.client.socket.readyState = 3;
  f.client.socketFactory = () => {
    const socket = { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); },
      close() { this.readyState = 3; this.onclose?.(); },
      receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); } };
    sockets.push(socket); return socket;
  };
  const ready = (socket, connectionId, budget = { blocked: false, unknown: 0 }) => socket.receive({
    type: 'ready', connectionId, budget, variant: 'qwen-direct', listenerConfiguration: {} });
  const expire = (socket, connectionId, code = 'session_input_limit', budget = { blocked: false, unknown: 0 }) => {
    socket.receive({ type: 'blocked', connectionId, code, budget }); socket.close();
  };
  return { ...f, sockets, ready, expire };
}

test('a fresh current-socket ready clears only a known-safe session duration limit and admits new audio', async () => {
  const f = reconnectFixture(); let connected = f.client.connect(); const first = f.sockets[0];
  f.ready(first, 'session-first'); await connected;
  first.receive({ type: 'input_exhausted', connectionId: 'session-first' });
  f.expire(first, 'session-first'); assert.equal(f.client.canReconnect, true); assert.equal(f.client.blocked, true);
  connected = f.client.connect(); const second = f.sockets[1];
  assert.equal(f.client.blocked, true); f.ready(second, 'session-second'); await connected;
  assert.equal(f.client.blocked, false); assert.equal(f.client.error, null); assert.equal(f.client.inputExhausted, false);
  assert.equal(f.client.sendAudio(new Int16Array(1600)), true); assert.equal(second.sent.at(-1).type, 'audio');
  assert.equal(second.sent.at(-1).sequence, 0);
});

test('late ready and budget events from the retired socket cannot unblock or poison a new handshake', async () => {
  const f = reconnectFixture(); let connected = f.client.connect(); const first = f.sockets[0];
  f.ready(first, 'session-first'); await connected; f.expire(first, 'session-first');
  connected = f.client.connect(); const second = f.sockets[1];
  f.ready(first, 'late-first'); assert.equal(f.client.blocked, true); assert.equal(f.client.ready, false);
  f.ready(second, 'session-second'); await connected;
  first.receive({ type: 'blocked', connectionId: 'session-first', code: 'provider_usage_missing_or_invalid',
    budget: { blocked: true, unknown: 1 } });
  second.receive({ type: 'blocked', connectionId: 'session-first', code: 'provider_usage_missing_or_invalid',
    budget: { blocked: true, unknown: 1 } });
  assert.equal(f.client.blocked, false); assert.equal(f.client.connectionId, 'session-second');
});

test('a retired connection ID on the current socket fails closed instead of recovering the old session', async () => {
  const f = reconnectFixture(); let connected = f.client.connect(); const first = f.sockets[0];
  f.ready(first, 'session-first'); await connected; f.expire(first, 'session-first');
  connected = f.client.connect(); const rejected = assert.rejects(connected, /connection_closed/), second = f.sockets[1];
  f.ready(second, 'session-first'); assert.equal(f.client.blocked, true); assert.equal(f.client.hardBlocked, true);
  assert.equal(f.client.canReconnect, false); assert.equal(f.client.ready, false);
  second.close(); await rejected;
});

test('unknown usage is sticky and cannot be cleared by a later benign limit or local reconnect', async () => {
  const f = reconnectFixture(); const connected = f.client.connect(), first = f.sockets[0];
  f.ready(first, 'session-first'); await connected;
  first.receive({ type: 'response_accounting', connectionId: 'session-first', budget: { blocked: false, unknown: 1 } });
  f.expire(first, 'session-first');
  assert.equal(f.client.hardBlocked, true); assert.equal(f.client.canReconnect, false);
  await assert.rejects(f.client.connect(), /session_input_limit/); assert.equal(f.sockets.length, 1);
  assert.throws(() => f.client.message({ type: 'ready', connectionId: 'injected', budget: { blocked: false, unknown: 0 } }), /invalid_ready/);
  assert.equal(f.client.blocked, true);
});

test('new ready must explicitly confirm both safe budget fields before a duration limit can recover', async () => {
  for (const budget of [{}, { blocked: false }, { unknown: 0 }, { blocked: true, unknown: 0 }, { blocked: false, unknown: 1 }]) {
    const f = reconnectFixture(); let connected = f.client.connect(); const first = f.sockets[0];
    f.ready(first, 'session-first'); await connected; f.expire(first, 'session-first');
    connected = f.client.connect(); const second = f.sockets[1]; f.ready(second, 'session-second', budget); await connected;
    assert.equal(f.client.blocked, true); assert.equal(f.client.sendText('不能发送'), false); second.close();
  }
});

test('non-duration protocol and response-budget blocks cannot use reconnect to clear admission', async () => {
  for (const code of ['bridge_error', 'reply_cleanup_failed', 'input_limit', 'provider_usage_missing_or_invalid']) {
    const f = reconnectFixture(); const connected = f.client.connect(), first = f.sockets[0];
    f.ready(first, 'session-first'); await connected; f.expire(first, 'session-first', code);
    assert.equal(f.client.canReconnect, false); await assert.rejects(f.client.connect(), new RegExp(code));
    assert.equal(f.sockets.length, 1);
  }
});
