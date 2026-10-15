async page => {
  const results = [], errors = [], trials = [];
  const boundary = 'Local PCM with independent test subtitles (not a transcription of that audio) and actual browser Worker/Web Audio context; subtitle semantics are rules. No cloud, microphone, avatar, physical speaker measurement or word-aligned synchronization. Slow/stalled modes delay/drop Worker replies; they do not stall the main thread.';
  page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', event => { if (event.type() === 'error') errors.push({ type: 'console', message: event.text() }); });
  const read = () => page.evaluate(() => window.realtimeLab.snapshot());
  const assert = (condition, label, detail) => {
    if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
    results.push({ label, passed: true, detail });
  };
  const cuesFor = (state, epoch = state.identity.epoch) => state.events.filter(event => event.type === 'cue' && event.identity?.epoch === epoch);
  const start = async (options = {}) => {
    const accepted = await page.evaluate(options => window.realtimeLab.start({
      chunkMs: 20, providerFast: false, starve: false, sidecar: true,
      autoSubtitles: false, scriptedCues: false, workerMode: 'normal', profile: 'balanced', ...options,
    }), options);
    if (!accepted) throw new Error('Lab did not start');
    await page.waitForFunction(() => window.realtimeLab.snapshot().audio.time > .10, undefined, { timeout: 5000 });
    return read();
  };
  const push = text => page.evaluate(text => window.realtimeLab.pushSubtitle(text), text);

  try {
    await page.goto('http://127.0.0.1:18767/lab/');
    await page.waitForFunction(() => !!window.realtimeLab?.pushSubtitle, undefined, { timeout: 5000 });

    const split = await start();
    await push('我一点都不');
    await page.waitForTimeout(220);
    const incomplete = await read();
    assert(incomplete.sidecar.counts.decisions === split.sidecar.counts.decisions && cuesFor(incomplete).length === 0,
      '未闭合的中文否定片段不抢先产生动作', { sidecar: incomplete.sidecar, cues: cuesFor(incomplete) });
    await push('高兴。');
    await page.waitForFunction(count => window.realtimeLab.snapshot().sidecar.counts.decisions > count,
      split.sidecar.counts.decisions, { timeout: 3000 });
    const negative = await read();
    assert(!cuesFor(negative).some(event => ['smile', 'happy'].includes(event.cue?.preset) || event.cue?.gesture === 'wave'),
      '分片否定合并后不会误触发开心或招手', { sidecar: negative.sidecar, cues: cuesFor(negative) });

    const normal = await start();
    const normalPush = await push('你好，很高兴见到你。');
    await page.waitForFunction(epoch => window.realtimeLab.snapshot().events.some(event => event.type === 'cue' && event.identity?.epoch === epoch),
      normal.identity.epoch, { timeout: 3000 });
    const delivered = await read();
    assert(normalPush.accepted && delivered.sidecar.counts.queuedCues > normal.sidecar.counts.queuedCues,
      '真实Worker正常结果进入同轮调度器', { sidecar: delivered.sidecar, cues: cuesFor(delivered) });

    const slow = await start({ workerMode: 'slow' });
    await push('你好，很高兴见到你。');
    await page.waitForTimeout(220);
    const slowProgress = await read();
    assert(slowProgress.sidecar.inFlight && slowProgress.audio.time > slow.audio.time + .08
      && slowProgress.performance.appendCount > slow.performance.appendCount,
    '等待800ms Worker回包时PCM仍持续接收和播放', {
      before: { mediaTime: slow.audio.time, appends: slow.performance.appendCount },
      after: { mediaTime: slowProgress.audio.time, appends: slowProgress.performance.appendCount, inFlight: slowProgress.sidecar.inFlight },
    });
    await page.waitForFunction(count => window.realtimeLab.snapshot().sidecar.counts.decisions > count,
      slow.sidecar.counts.decisions, { timeout: 3000 });
    const late = await read();
    assert(late.sidecar.lastDecision?.reason === 'late_result' && cuesFor(late).length === 0,
      '慢结果保留句段原锚点并过期丢弃，不改成现在补演', { sidecar: late.sidecar, cues: cuesFor(late), mediaTime: late.audio.time });

    const stalled = await start({ workerMode: 'stalled' });
    await push('你好，很高兴见到你。');
    await page.waitForTimeout(300);
    const stalledProgress = await read();
    assert(stalledProgress.sidecar.inFlight && stalledProgress.audio.time > stalled.audio.time + .12
      && stalledProgress.performance.appendCount > stalled.performance.appendCount,
    'Worker不回包时PCM仍持续接收和播放', {
      before: { mediaTime: stalled.audio.time, appends: stalled.performance.appendCount },
      after: { mediaTime: stalledProgress.audio.time, appends: stalledProgress.performance.appendCount },
    });
    await page.waitForFunction(() => window.realtimeLab.snapshot().sidecar.status === 'disabled', undefined, { timeout: 3000 });
    const timedOut = await read();
    assert(timedOut.sidecar.lastDecision?.reason === 'worker_timeout' && !timedOut.scheduler.fault
      && timedOut.audio.time > stalledProgress.audio.time + .25 && timedOut.performance.appendCount > stalledProgress.performance.appendCount,
    'Worker超时只停用旁路，音频继续推进', { sidecar: timedOut.sidecar, mediaTime: timedOut.audio.time, appends: timedOut.performance.appendCount, fault: timedOut.scheduler.fault });

    const old = await start({ workerMode: 'slow' });
    await push('你好，很高兴见到你。');
    await page.waitForTimeout(80);
    await page.evaluate(() => window.realtimeLab.cancel('subtitle_acceptance_barge_in'));
    const cancelled = await read();
    assert(cancelled.sidecar.status === 'cancelled' && !cancelled.sidecar.inFlight && cancelled.sidecar.pendingChunks === 0
      && cancelled.audio.status === 'cancelled' && cancelled.audio.sourceCount === 0 && cancelled.scheduler.queued === 0,
    '打断同步清空音频、动作队列和旁路待处理输入', { sidecar: cancelled.sidecar, audio: cancelled.audio, queued: cancelled.scheduler.queued, interrupt: cancelled.lastInterrupt });
    const replacement = await start();
    const oldPush = await page.evaluate(owner => window.realtimeLab.pushSubtitle('再见。', { owner, itemId: 'lab-transcript', sequence: 1 }), old.identity);
    await page.waitForTimeout(950);
    const isolated = await read();
    assert(!oldPush.accepted && isolated.identity.epoch === replacement.identity.epoch && cuesFor(isolated, old.identity.epoch).length === 0,
      '替换后旧轮字幕拒绝，已取消的慢回包不产生旧动作', { rejection: oldPush, oldEpoch: old.identity.epoch, newEpoch: isolated.identity.epoch, oldCues: cuesFor(isolated, old.identity.epoch) });

    const pressureStart = await start({ workerMode: 'stalled' });
    const pressure = await page.evaluate(() => {
      let accepted = 0, rejected = 0;
      const start = performance.now();
      for (let index = 0; index < 1000; index++) {
        const result = window.realtimeLab.pushSubtitle('字');
        if (result.accepted) accepted++; else rejected++;
      }
      return { accepted, rejected, handlerMs: performance.now() - start, state: window.realtimeLab.snapshot() };
    });
    assert(pressure.rejected > 0 && pressure.state.sidecar.pendingChunks <= 32
      && pressure.state.sidecar.receivedChunks <= 256 && pressure.state.sidecar.receivedChars <= 16384
      && pressure.state.subtitleEvents.length <= 100,
    '1000次快速字幕输入受限，旁路状态和诊断记录有界', {
      accepted: pressure.accepted, rejected: pressure.rejected, handlerMs: pressure.handlerMs,
      sidecar: pressure.state.sidecar, subtitleEvents: pressure.state.subtitleEvents.length,
    });
    await page.waitForTimeout(220);
    const pressureAfter = await read();
    assert(pressureAfter.audio.time > pressureStart.audio.time + .08 && !pressureAfter.scheduler.fault,
      '旁路输入超限后音频仍继续', { mediaTime: pressureAfter.audio.time, sidecarStatus: pressureAfter.sidecar.status });

    await start();
    await push('字'.repeat(513));
    await page.waitForFunction(() => window.realtimeLab.snapshot().sidecar.status === 'disabled', undefined, { timeout: 3000 });
    const tooLong = await read();
    assert(tooLong.sidecar.lastDecision?.reason === 'segment_capacity' && cuesFor(tooLong).length === 0 && !tooLong.scheduler.fault,
      '超长无标点句段保守停用旁路，不截掉否定后继续推断', { sidecar: tooLong.sidecar, cues: cuesFor(tooLong) });

    // One warmup pair and four measured pairs. The identical suppressing sentence
    // keeps both modes free of semantic cues, isolating optional subtitle work.
    for (let pair = -1; pair < 4; pair++) {
      const order = pair % 2 === 0 ? [false, true] : [true, false];
      for (const enabled of order) {
        const trial = await page.evaluate(async enabled => {
          const lab = window.realtimeLab;
          const startedAt = performance.now();
          await lab.start({ chunkMs: 20, providerFast: false, starve: false, sidecar: enabled,
            autoSubtitles: false, scriptedCues: false, workerMode: 'normal', profile: 'balanced' });
          const interval = setInterval(() => lab.pushSubtitle('请不要点头，不要微笑，也不要挥手。'), 120);
          let benchmark;
          try { benchmark = await lab.runBenchmark(2); }
          finally { clearInterval(interval); }
          const state = lab.snapshot();
          return { enabled, benchmark, metrics: state.performance,
            observedFirstPlayingMs: state.performance.firstPlayingWall == null ? null : state.performance.firstPlayingWall * 1000 - startedAt,
            audio: state.audio, sidecar: state.sidecar, error: state.error, schedulerFault: state.scheduler.fault,
            cues: state.events.filter(event => event.type === 'cue' && event.identity?.epoch === state.identity.epoch),
            subtitleEventsLength: state.subtitleEvents.length };
        }, enabled);
        if (trial.error || trial.schedulerFault || trial.cues.length || trial.benchmark.sampleCount < 10
          || (trial.benchmark.statusFrames.playing ?? 0) < 10 || trial.metrics.appendCount < 10
          || !Number.isFinite(trial.metrics.appendP95Ms) || !Number.isFinite(trial.metrics.subtitlePushP95Ms)) {
          throw new Error(`Invalid comparable trial: ${JSON.stringify({ pair, ...trial })}`);
        }
        if (pair >= 0) trials.push({ pair, ...trial });
      }
    }
    const metricNames = ['appendP95Ms', 'subtitlePushP95Ms', 'schedulerP95Ms', 'playingP95Ms', 'frameIntervalP95Ms', 'observedFirstPlayingMs'];
    const metric = (trial, name) => name === 'observedFirstPlayingMs' ? trial[name]
      : ['schedulerP95Ms', 'playingP95Ms', 'frameIntervalP95Ms'].includes(name) ? trial.benchmark[name] : trial.metrics[name];
    const statistics = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { samples: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        min: sorted[0], max: sorted.at(-1), values };
    };
    const comparison = Object.fromEntries(metricNames.map(name => {
      const off = [], on = [], delta = [];
      for (let pair = 0; pair < 4; pair++) {
        const offValue = metric(trials.find(trial => trial.pair === pair && !trial.enabled), name);
        const onValue = metric(trials.find(trial => trial.pair === pair && trial.enabled), name);
        if (!Number.isFinite(offValue) || !Number.isFinite(onValue)) throw new Error(`Missing comparison metric ${name}`);
        off.push(offValue); on.push(onValue); delta.push(onValue - offValue);
      }
      return [name, { off: statistics(off), on: statistics(on), onMinusOff: statistics(delta) }];
    }));
    assert(trials.length === 8 && trials.every(trial => trial.subtitleEventsLength <= 100),
      '相同PCM和字幕轨迹完成4对旁路开关成本对照', { pairs: 4, secondsPerTrial: 2, comparison });
    await page.evaluate(() => window.realtimeLab.cancel('subtitle_acceptance_complete'));
    const final = await read();
    assert(!final.error && !final.scheduler.fault && errors.length === 0,
      '浏览器验收无脚本错误和音频调度故障', { errors, error: final.error, fault: final.scheduler.fault });
    const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      audioSampleRate: window.realtimeLab.snapshot().audio.sampleRate }));
    const result = { passed: true, generatedAt: new Date().toISOString(), boundary, environment,
      performanceScope: 'Append and subtitle-push metrics measure their synchronous handlers. Scheduler benchmark measures synchronize() only, excluding DOM rendering and input handlers. First-playing latency is the first observed Web Audio context playing state. Comparison includes ordinary browser scheduling noise and is not a zero-overhead guarantee.',
      results, trials, comparison, errors, final };
    await page.evaluate(result => { window.__subtitleAcceptance = result; }, result);
    return { passed: true, assertions: results.length, environment, comparison, evidenceGlobal: '__subtitleAcceptance' };
  } catch (error) {
    const final = await read().catch(() => null);
    const result = { passed: false, generatedAt: new Date().toISOString(), boundary, error: error.message, results, trials, errors, final };
    await page.evaluate(result => { window.__subtitleAcceptance = result; }, result).catch(() => {});
    throw error;
  }
}
