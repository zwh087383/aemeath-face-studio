async page => {
  // Own a separate page. Every WebSocket there is replaced BEFORE application
  // modules load; the replacement never constructs or calls a native socket.
  const base = page.url().split('/').slice(0,3).join('/') + '/qwen/', checks = [], errors = [];
  const offline = await page.context().newPage();
  const boundary = 'FAKE PROVIDER ONLY. Actual PMX, actual WebAudio sine PCM, real subtitle Worker and renderer. Synthetic MediaStream tests lifecycle without opening hardware microphone. No cloud connection, provider latency, speech quality or physical speaker-stop measurement.';
  let result;
  const assert = (condition, name, detail) => {
    if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`);
    checks.push({ name, passed: true, detail });
  };
  offline.on('pageerror', error => errors.push(error.message));
  try {
    await offline.route('**/api/status', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ experimental: true, configured: true, usageUnknownBlocked: false, connected: false }) }));
    await offline.addInitScript(() => {
      const bridge = window.__offlineBridge = { sockets: [], commands: [], nativeSocketCalls: 0, provider: 'fake-in-page' };
      const pcm = (frames, offset = 0) => {
        const bytes = new Uint8Array(frames * 2), view = new DataView(bytes.buffer);
        for (let frame = 0; frame < frames; frame++) view.setInt16(frame * 2,
          Math.round(9000 * Math.sin(2 * Math.PI * 220 * (offset + frame) / 24000)), true);
        let text = ''; for (let start = 0; start < bytes.length; start += 4096) text += String.fromCharCode(...bytes.subarray(start, start + 4096));
        return btoa(text);
      };
      class FakeBridgeSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor(url) {
          this.url = url; this.readyState = 0; this.timers = []; this.response = null; this.responses = 0;
          this.connectionId = `offline-qwen-${bridge.sockets.length + 1}`; bridge.sockets.push(this);
          setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0);
        }
        emit(value) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ connectionId: this.connectionId, serverAtMs: performance.now(), ...value }) }); }
        native(event, extra = {}) { this.emit({ type: 'provider', event, requestId: this.response?.requestId, ...extra }); }
        later(callback, ms) { this.timers.push(setTimeout(callback, ms)); }
        clear() { this.timers.forEach(clearTimeout); this.timers = []; }
        reply(requestId) {
          this.response = { requestId, responseId: `offline-response-${++this.responses}`, done: false };
          const rid = this.response.responseId;
          this.native({ type: 'response.created', response: { id: rid } });
          this.native({ type: 'response.audio_transcript.delta', response_id: rid, item_id: 'offline-text', content_index: 0,
            delta: '你好，很高兴见到你！我轻轻挥挥手。' });
          this.native({ type: 'response.audio_transcript.done', response_id: rid, item_id: 'offline-text' });
          // Twenty 100-ms PCM chunks delivered over half a second. This is
          // genuine browser playback of synthetic audio, not cloud timing.
          for (let chunk = 0; chunk < 20; chunk++) this.later(() => {
            this.native({ type: 'response.audio.delta', response_id: rid, delta: pcm(2400, chunk * 2400) });
          }, chunk * 25);
          this.later(() => this.native({ type: 'response.audio.done', response_id: rid }), 500);
          this.later(() => this.finish('completed'), 650);
        }
        finish(status, revoked = false) {
          if (!this.response || this.response.done) return;
          this.response.done = true;
          this.native({ type: 'response.done', response: { id: this.response.responseId, status,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }, { revoked });
        }
        send(raw) {
          const command = JSON.parse(raw); bridge.commands.push({ ...command, ...(command.audio ? { audio: '[synthetic PCM omitted]' } : {}), atMs: performance.now() });
          if (command.type === 'connect') this.emit({ type: 'ready', mode: command.mode,
            model: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1', inputSampleRate: 16000, outputSampleRate: 24000 });
          else if (command.type === 'text' || command.type === 'commit') this.reply(command.requestId);
          else if (command.type === 'input_audio') this.emit({ type: 'input_ack', sequence: command.sequence });
          else if (command.type === 'cancel') {
            this.clear(); this.emit({ type: 'cancel_ack', requestId: this.response?.requestId,
              responseId: this.response?.responseId, remoteNeeded: !this.response?.done }); this.finish('cancelled', true);
          } else if (command.type === 'close') this.close();
        }
        close() { this.clear(); if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000 }); }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: FakeBridgeSocket });
      const media = window.__offlineMedia = { mode: 'pending', requests: 0, resolved: 0, stoppedTracks: 0, pending: [], tracks: [] };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
        media.requests++;
        if (media.mode === 'reject') return Promise.reject(new DOMException('Synthetic permission rejection', 'NotAllowedError'));
        return new Promise(resolve => media.pending.push(resolve));
      } });
      media.resolveNext = () => {
        const resolve = media.pending.shift(); if (!resolve) throw new Error('No pending synthetic permission request');
        const context = new AudioContext(), destination = context.createMediaStreamDestination();
        const stream = destination.stream;
        for (const track of stream.getTracks()) {
          media.tracks.push(track); const stop = track.stop.bind(track); let stopped = false;
          track.stop = () => { if (!stopped) { stopped = true; media.stoppedTracks++; stop(); context.close().catch(() => {}); } };
        }
        media.resolved++; resolve(stream);
      };
    });
    await offline.goto(base);
    await offline.waitForFunction(() => window.qwenLab?.ready, undefined, { timeout: 45000 });
    await offline.waitForFunction(() => window.qwenLab.snapshot().rendered?.frame > 2, undefined, { timeout: 5000 });
    const ready = await offline.evaluate(() => window.qwenLab.snapshot());
    assert(ready.rendered.finite && ready.rendered.missingBindings.length === 0,
      '真实 PMX 已加载且绑定完整', { frame: ready.rendered.frame, missingBindings: ready.rendered.missingBindings, environment: ready.environment });
    await offline.evaluate(() => window.qwenLab.connect('manual'));
    const interruption = await offline.evaluate(async () => {
      const lab = window.qwenLab; lab.setSidecar(true); lab.sendText('离线合成音频的浏览器验收。');
      const deadline = performance.now() + 7000;
      while (performance.now() < deadline) {
        const before = lab.snapshot(), trial = before.trials.at(-1);
        if (before.session.audio.sourceActive && before.rendered.mouthOpen > .05
          && trial?.cues?.some(cue => cue.kind === 'expression')
          && before.motion.gestures.some(gesture => !gesture.recovering)) {
          const accepted = lab.interrupt('offline_voiced_interruption');
          return { accepted, before, immediate: lab.snapshot() };
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error(`No combined voiced-mouth / subtitle / body frame observed: ${JSON.stringify(lab.snapshot())}`);
    });
    assert(interruption.accepted && interruption.before.rendered.mouthOpen > .05
      && interruption.before.session.scheduler.counts.dispatched >= 2,
    '实际 WebAudio PCM、实时粗口型与字幕表情动作同时生效', {
      mouthOpen: interruption.before.rendered.mouthOpen, transcript: interruption.before.trials.at(-1).transcript,
      cues: interruption.before.trials.at(-1).cues, gestures: interruption.before.motion.gestures,
      sourceCount: interruption.before.session.audio.sourceCount });
    assert(interruption.immediate.session.audio.sourceCount === 0 && interruption.immediate.session.scheduler.queued === 0,
      '打断同步返回时已切断实际浏览器音源并清空调度队列', {
        audio: interruption.immediate.session.audio, schedulerQueued: interruption.immediate.session.scheduler.queued });
    await offline.waitForFunction(() => {
      const s = window.qwenLab.snapshot(), stop = s.interruptions.at(-1);
      return Number.isFinite(stop?.mouthClosedMs) && Number.isFinite(stop?.retractCompleteMs) && s.motion.gestures.length === 0;
    }, undefined, { timeout: 5000 });
    const stopped = await offline.evaluate(() => window.qwenLab.snapshot());
    const stop = stopped.interruptions.at(-1);
    assert(stopped.rendered.mouthOpen <= .01 && stopped.session.audio.sourceCount === 0 && stop.mouthClosedMs < 250
      && stop.retractCompleteMs < 3000 && stopped.rendered.finite,
    '实际模型及时收口并完成自然收势', { interruption: stop, posture: stopped.motion.posture, renderedMouth: stopped.rendered.mouthOpen });

    const micCases = [];
    for (const action of ['finishMic', 'disconnect']) {
      await offline.evaluate(() => {
        window.__offlineMedia.mode = 'pending';
        window.__offlineMicStart = window.qwenLab.startMic().then(value => ({ resolved: true, value }), error => ({ resolved: false, error: error.message }));
      });
      await offline.waitForFunction(() => window.__offlineMedia.pending.length === 1, undefined, { timeout: 3000 });
      const before = await offline.evaluate(() => ({ stoppedTracks: window.__offlineMedia.stoppedTracks,
        inputCommands: window.__offlineBridge.commands.filter(command => command.type === 'input_audio').length }));
      const finished = await offline.evaluate(async action => {
        window.qwenLab[action](); window.__offlineMedia.resolveNext();
        return await window.__offlineMicStart;
      }, action);
      const after = await offline.evaluate(() => ({ stoppedTracks: window.__offlineMedia.stoppedTracks,
        trackStates: window.__offlineMedia.tracks.map(track => track.readyState),
        inputCommands: window.__offlineBridge.commands.filter(command => command.type === 'input_audio').length,
        pending: window.__offlineMedia.pending.length, state: window.qwenLab.snapshot() }));
      assert(finished.resolved && finished.value === false && after.stoppedTracks > before.stoppedTracks
        && after.inputCommands === before.inputCommands && after.trackStates.every(state => state === 'ended') && after.pending === 0,
      `${action} 在麦克风权限等待期间撤销，迟到 stream 被释放且无输入包发送`, { before, finished,
        after: { stoppedTracks: after.stoppedTracks, trackStates: after.trackStates, inputCommands: after.inputCommands, pending: after.pending } });
      micCases.push({ action, before, finished, after: { stoppedTracks: after.stoppedTracks, trackStates: after.trackStates, inputCommands: after.inputCommands } });
    }
    await offline.evaluate(() => window.qwenLab.connect('manual'));
    const denied = await offline.evaluate(async () => {
      window.__offlineMedia.mode = 'reject'; let rejection;
      try { await window.qwenLab.startMic(); } catch (error) { rejection = { name: error.name, message: error.message }; }
      const requestId = window.qwenLab.sendText('权限拒绝后的独立文字回复。', { sidecar: false, profile: 'balanced' });
      window.qwenLab.interrupt('offline_permission_test_complete');
      return { rejection, requestId, state: window.qwenLab.snapshot() };
    });
    assert(denied.rejection?.name === 'NotAllowedError' && typeof denied.requestId === 'string' && denied.state.client.ready,
      '麦克风权限拒绝不遗留输入 pending，随后文字请求仍可发送', { rejection: denied.rejection, requestId: denied.requestId });
    const protection = await offline.evaluate(() => ({ sockets: window.__offlineBridge.sockets.length,
      provider: window.__offlineBridge.provider, nativeSocketCalls: window.__offlineBridge.nativeSocketCalls,
      inputCommands: window.__offlineBridge.commands.filter(command => command.type === 'input_audio').length,
      tracks: window.__offlineMedia.tracks.map(track => track.readyState) }));
    assert(protection.provider === 'fake-in-page' && protection.nativeSocketCalls === 0 && protection.inputCommands === 0,
      '所有会话均为页内假桥接，未建立云 WebSocket 或发送麦克风 PCM', protection);
    assert(errors.length === 0, '离线浏览器测试没有未捕获异常', errors);
    result = { passed: true, generatedAt: new Date().toISOString(), boundary, checks, errors,
      interruption: stop, micCases, protection, final: await offline.evaluate(() => window.qwenLab.snapshot()) };
  } catch (error) {
    result = { passed: false, generatedAt: new Date().toISOString(), boundary, checks, errors, error: error.message,
      final: await offline.evaluate(() => window.qwenLab?.snapshot()).catch(() => null) };
  } finally {
    if (result) {
      await offline.evaluate(result => { window.__qwenOfflineResult = result; }, result).catch(() => {});
      await page.evaluate(result => { window.__qwenOfflineResult = result; }, result);
    }
    await offline.evaluate(() => window.qwenLab?.disconnect()).catch(() => {});
    await offline.close();
  }
  return { passed: result?.passed === true, checks: checks.length, boundary, error: result?.error,
    interruption: result?.interruption, evidenceGlobal: '__qwenOfflineResult (original page)' };
}
