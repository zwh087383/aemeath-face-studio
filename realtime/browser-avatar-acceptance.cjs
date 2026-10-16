async page => {
  // Run once with window.__avatarAcceptancePart='core' (the default), then once
  // with 'performance'. Each invocation has its own bounded sampling window.
  const part = await page.evaluate(() => window.__avatarAcceptancePart || 'core');
  if (!['core', 'performance'].includes(part)) throw new Error(`Unknown avatar acceptance part: ${part}`);
  const checks = [], errors = [];
  const assert = (condition, name, detail) => {
    if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`);
    checks.push({ name, passed: true, detail });
  };
  const read = () => page.evaluate(() => window.avatarLab.snapshot());
  const accepted = result => result === true || result?.accepted === true;
  const pageError = error => errors.push({ type: 'pageerror', message: error.message });
  const consoleError = event => { if (event.type() === 'error') errors.push({ type: 'console', message: event.text() }); };
  page.on('pageerror', pageError); page.on('console', consoleError);
  const boundary = 'Actual PMX rendering, existing precomputed lip track for the bundled local WAV, streamed PCM and browser Web Audio context. No new speech-to-face inference, live provider, microphone, physical speaker stop measurement or GPU-completion timing.';
  const start = async (options = {}) => {
    const result = await page.evaluate(options => window.avatarLab.start({ sidecar: true, autoSubtitles: false,
      providerFast: false, starve: false, chunkMs: 20, ...options }), options);
    if (result !== true) throw new Error(`Avatar start failed: ${JSON.stringify(result)}`);
    await page.waitForFunction(() => {
      const state = window.avatarLab.snapshot();
      return state.session.audio.status === 'playing' && state.session.audio.time > .08;
    }, undefined, { timeout: 7000 });
    return read();
  };
  let result;
  try {
    await page.waitForFunction(() => window.avatarLab?.ready, undefined, { timeout: 30000 });
    await page.waitForFunction(() => window.avatarLab.snapshot().rendered.frame > 1, undefined, { timeout: 5000 });
    if (part === 'core') {
      await page.evaluate(() => { window.avatarLab.setIdle(false); window.avatarLab.setNatural(false); window.avatarLab.setView('body'); });
      const ready = await read();
      const boneNames = ['head', 'neck', 'leftWrist', 'rightWrist'];
      assert(ready.rendered.finite && ready.rendered.missingBindings.length === 0 && ready.rendered.morphWeights.length > 0
        && boneNames.every(name => ready.rendered.bones[name]?.position?.length === 3 && ready.rendered.bones[name]?.quaternion?.length === 4),
      '真实模型已渲染，口型和骨骼绑定完整', { frame: ready.rendered.frame, missingBindings: ready.rendered.missingBindings,
        finite: ready.rendered.finite, morphCount: ready.rendered.morphWeights.length, bones: ready.rendered.bones });
      const initial = await start();
      const owner = initial.session.owner;
      assert(initial.face.epoch === owner.epoch && initial.motion.epoch === owner.epoch && initial.session.audio.epoch === owner.epoch,
        '音频、面部和身体绑定同一回复代次', { owner, faceEpoch: initial.face.epoch, motionEpoch: initial.motion.epoch, audioEpoch: initial.session.audio.epoch });
      const cues = await page.evaluate(() => {
        const lab = window.avatarLab, epoch = lab.snapshot().session.owner.epoch;
        return [
          lab.enqueue({ id: `avatar-${epoch}-smile`, kind: 'expression', preset: 'smile' }),
          lab.enqueue({ id: `avatar-${epoch}-nod`, kind: 'action', action: 'nod' }),
          lab.enqueue({ id: `avatar-${epoch}-explain`, kind: 'gesture', gesture: 'explain' }),
        ];
      });
      assert(cues.every(accepted), '表情、短动作与身体手势都通过统一调度入口', cues);
      await page.waitForFunction(() => {
        const s = window.avatarLab.snapshot();
        return s.face.preset === 'smile' && s.face.actions.includes('nod') && s.motion.gestures.some(g => g.gesture === 'explain' && !g.recovering);
      }, undefined, { timeout: 5000 });
      const composed = await read();
      const delta = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
      assert(composed.rendered.frame > initial.rendered.frame && composed.rendered.finite
        && delta(composed.rendered.bones.rightWrist.position, initial.rendered.bones.rightWrist.position) > 1e-5,
      '统一提示改变了真实人物骨骼，语音仍在推进', { mediaTime: composed.session.audio.time,
        rightWristBefore: initial.rendered.bones.rightWrist, rightWristAfter: composed.rendered.bones.rightWrist, face: composed.face });
      await page.evaluate(() => window.avatarLab.pause());
      const paused = await read();
      await page.waitForTimeout(260);
      const held = await read();
      const audioGestures = state => state.motion.gestures.filter(g => g.clock === 'audio' && !g.recovering);
      assert(held.session.audio.status === 'paused' && held.session.audio.sourceCount === 0
        && Math.abs(held.session.audio.time - paused.session.audio.time) < .002 && held.rendered.mouthOpen <= .01,
      '暂停冻结媒体时间并关闭真实口型', { beforeTime: paused.session.audio.time, afterTime: held.session.audio.time,
        sourceCount: held.session.audio.sourceCount, mouthOpen: held.rendered.mouthOpen });
      assert(audioGestures(held).length > 0 && audioGestures(held).every(g => audioGestures(paused).some(p => p.id === g.id && Math.abs(p.age - g.age) < 1e-6)),
        '暂停保留同一个手势，动作年龄不推进', { before: audioGestures(paused), after: audioGestures(held) });
      await page.evaluate(() => window.avatarLab.resume());
      await page.waitForFunction(time => window.avatarLab.snapshot().session.audio.time > time + .12, held.session.audio.time, { timeout: 5000 });
      const resumed = await read();
      assert(resumed.session.owner.epoch === owner.epoch && audioGestures(held).every(g => {
        const current = resumed.motion.gestures.find(item => item.id === g.id); return !current || current.age > g.age;
      }), '恢复同一回复且手势不重新起播', { epoch: resumed.session.owner.epoch, gestures: resumed.motion.gestures });
      const queuedFuture = await page.evaluate(() => {
        const lab = window.avatarLab, s = lab.snapshot(), at = s.session.audio.time + 3;
        return [lab.enqueue({ id: `future-face-${s.session.owner.epoch}`, kind: 'expression', preset: 'curious', at }),
          lab.enqueue({ id: `future-body-${s.session.owner.epoch}`, kind: 'gesture', gesture: 'chest', at })];
      });
      assert(queuedFuture.every(accepted), '打断前确实存在未来表情和动作', queuedFuture);
      const voicedInterrupt = await page.evaluate(async () => {
        const lab = window.avatarLab, deadline = performance.now() + 6000;
        while (performance.now() < deadline) {
          const before = lab.snapshot();
          if (before.session.audio.status === 'playing' && before.rendered.mouthOpen > .08) {
            lab.cancel('avatar_voiced_acceptance');
            return { beforeMouth: before.rendered.mouthOpen, owner: before.session.owner, audioTime: before.session.audio.time, after: lab.snapshot() };
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        throw new Error('No rendered open-mouth voiced frame observed');
      });
      await page.waitForFunction(() => {
        const s = window.avatarLab.snapshot(); return Number.isFinite(s.lastInterrupt?.mouthClosedMs) && s.rendered.mouthOpen <= .01;
      }, undefined, { timeout: 3000 });
      const closed = await read();
      assert(voicedInterrupt.beforeMouth > .08 && Number.isFinite(closed.lastInterrupt.mouthClosedMs)
        && closed.lastInterrupt.mouthClosedMs < 180 && closed.session.audio.sourceCount === 0
        && closed.session.scheduler.queued === 0 && closed.face.queued === 0 && closed.motion.queued === 0,
      '发声状态下打断会停音频、清队列并在180ms内收口', { beforeMouth: voicedInterrupt.beforeMouth,
        interrupt: closed.lastInterrupt, mouthOpen: closed.rendered.mouthOpen, audio: closed.session.audio,
        queues: { scheduler: closed.session.scheduler.queued, face: closed.face.queued, motion: closed.motion.queued } });
      await page.waitForFunction(() => {
        const s = window.avatarLab.snapshot(); return Number.isFinite(s.lastInterrupt?.retractCompleteMs) && s.motion.gestures.length === 0;
      }, undefined, { timeout: 5000 });
      const retracted = await read();
      assert(retracted.motion.posture === 'listening' && retracted.motion.status === 'cancelled' && retracted.rendered.finite,
        '已取消手势按本地时钟完成收势并进入倾听', { motion: retracted.motion, interrupt: retracted.lastInterrupt });
      const replacement = await start();
      const stale = await page.evaluate(oldOwner => ({
        cue: window.avatarLab.enqueue({ id: 'stale-avatar-body', kind: 'gesture', gesture: 'wave' }, oldOwner),
        subtitle: window.avatarLab.pushSubtitle('你好。', { owner: oldOwner, itemId: 'old-avatar-transcript', sequence: 0 }),
      }), voicedInterrupt.owner);
      await page.waitForTimeout(220);
      const isolated = await read();
      assert(!accepted(stale.cue) && !accepted(stale.subtitle) && isolated.session.owner.epoch === replacement.session.owner.epoch
        && isolated.motion.gestures.every(g => g.epoch === replacement.session.owner.epoch || g.recovering),
      '新回复拒绝旧动作和旧字幕，旧轮不复活', { stale, owner: isolated.session.owner, gestures: isolated.motion.gestures });

      const phaseTrials = [];
      for (const [phase, gesture] of [['prepare', 'wave'], ['stroke', 'shrug'], ['recover', 'chest']]) {
        await start({ sidecar: false });
        await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.length === 0, undefined, { timeout: 5000 });
        const trial = await page.evaluate(async ({ phase, gesture }) => {
          const lab = window.avatarLab, initial = lab.snapshot(), id = `phase-${phase}-${initial.session.owner.epoch}`;
          const queued = lab.enqueue({ id, kind: 'gesture', gesture });
          if (!(queued === true || queued?.accepted)) throw new Error(`Phase cue rejected: ${JSON.stringify(queued)}`);
          const deadline = performance.now() + 10000;
          while (performance.now() < deadline) {
            const before = lab.snapshot(), body = before.motion.gestures.find(g => g.id === id && !g.recovering);
            if (body?.phase === phase) {
              // The observed phase and cancel happen in the same browser callback.
              lab.cancel(`avatar_phase_${phase}`);
              return { requestedPhase: phase, gesture, id, observed: body, mouthAtCancel: before.rendered.mouthOpen,
                voicedAtCancel: before.rendered.mouthOpen > .05, mediaTime: before.session.audio.time,
                owner: before.session.owner, immediatelyAfter: lab.snapshot().lastInterrupt };
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          throw new Error(`Did not observe actual ${gesture}:${phase}; phase coverage cannot be inferred from elapsed time`);
        }, { phase, gesture });
        await page.waitForFunction(() => {
          const s = window.avatarLab.snapshot(); return Number.isFinite(s.lastInterrupt?.retractCompleteMs) && s.motion.gestures.length === 0;
        }, undefined, { timeout: 5000 });
        const done = await read();
        const cannotResume = await page.evaluate(() => window.avatarLab.resume());
        const stalePhase = await page.evaluate(owner => window.avatarLab.enqueue({ id: `stale-${owner.epoch}`, kind: 'gesture', gesture: 'explain' }, owner), trial.owner);
        const stillCancelled = await read();
        assert(trial.observed.phase === phase && !trial.observed.recovering && done.session.audio.sourceCount === 0
          && done.session.scheduler.queued === 0 && done.face.queued === 0 && done.motion.queued === 0
          && Number.isFinite(done.lastInterrupt.retractCompleteMs) && !accepted(stalePhase)
          && cannotResume !== true && stillCancelled.session.audio.status === 'cancelled',
        `真实${phase}阶段打断、完成收势且旧代次无法恢复`, { ...trial, completed: done.lastInterrupt,
          stalePhase, cannotResume, posture: done.motion.posture });
        phaseTrials.push({ ...trial, completed: done.lastInterrupt });
      }
      const shortActions = [];
      for (const action of ['nod', 'shake', 'tilt', 'glance', 'blink']) {
        await start({ sidecar: false });
        const observed = await page.evaluate(async action => {
          const lab = window.avatarLab;
          const { C, AEMEATH_BINDINGS } = await import('/preview/core/profile.js');
          const initial = lab.snapshot(), id = `short-${action}-${initial.session.owner.epoch}`;
          const result = lab.enqueue({ id, kind: 'action', action });
          if (!(result === true || result?.accepted)) throw new Error(`Short action rejected: ${action}`);
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            const s = lab.snapshot(), q = s.rendered.bones.head.quaternion, before = initial.rendered.bones.head.quaternion;
            const headDelta = Math.hypot(...q.map((value, index) => value - before[index]));
            const blinkWeight = s.rendered.morphWeights[AEMEATH_BINDINGS[C.blink][0]];
            if (s.face.actions.includes(action) && (action === 'blink' ? blinkWeight > .1 : headDelta > .002)) {
              const observation = { action, id, epoch: s.session.owner.epoch, audioTime: s.session.audio.time,
                headDelta, blinkWeight, rendered: s.rendered, face: s.face };
              lab.cancel(`short_action_${action}_complete`);
              return observation;
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          throw new Error(`No actual rendered effect observed for ${action}`);
        }, action);
        assert(observed.rendered.finite && observed.audioTime > 0, `${action}短动作在真实人物上生效`, {
          action, headDelta: observed.headDelta, blinkWeight: observed.blinkWeight, frame: observed.rendered.frame, audioTime: observed.audioTime,
        });
        shortActions.push(observed);
      }
      const final = await read();
      assert(final.rendered.finite && final.rendered.missingBindings.length === 0 && !final.session.scheduler.fault
        && !final.session.audio.fault && errors.length === 0,
      '核心联合验收结束无绑定、渲染或调度故障', { errors, finite: final.rendered.finite,
        missingBindings: final.rendered.missingBindings, schedulerFault: final.session.scheduler.fault, audioFault: final.session.audio.fault });
      result = { passed: true, part, generatedAt: new Date().toISOString(), boundary, checks, phaseTrials, shortActions, errors, final };
    } else {
      await page.evaluate(() => { window.avatarLab.setIdle(true); window.avatarLab.setNatural(true); window.avatarLab.setView('body'); });
      const measurement = await page.evaluate(async () => {
        const lab = window.avatarLab, snapshots = [], failures = [], seenGestures = new Set();
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const startAndQueue = async () => {
          const started = await lab.start({ sidecar: false, autoSubtitles: false, providerFast: false, starve: false, chunkMs: 20 });
          if (!started) throw new Error('Performance reply did not start');
          const deadline = performance.now() + 5000;
          while (lab.snapshot().session.audio.status !== 'playing') {
            if (performance.now() > deadline) throw new Error('Performance reply did not reach playing');
            await nextFrame();
          }
          const s = lab.snapshot(), epoch = s.session.owner.epoch, base = s.session.audio.time;
          const cues = [
            ...[['smile', .1], ['curious', 2.2], ['focus', 4.3], ['happy', 6.4], ['shy', 8.5], ['playful', 10.6], ['neutral', 12.7]]
              .map(([preset, at]) => ({ kind: 'expression', preset, id: `perf-face-${epoch}-${preset}`, at: base + at })),
            ...[['explain', .2], ['wave', 4.4], ['chest', 8.9]]
              .map(([gesture, at]) => ({ kind: 'gesture', gesture, id: `perf-body-${epoch}-${gesture}`, at: base + at })),
          ];
          for (const cue of cues) {
            const result = lab.enqueue(cue);
            if (!(result === true || result?.accepted)) failures.push({ stage: 'enqueue', cue, result });
          }
        };
        await startAndQueue();
        const sampleTimer = setInterval(() => {
          const s = lab.snapshot();
          for (const g of s.motion.gestures) if (!g.recovering) seenGestures.add(g.gesture);
          snapshots.push({ at: performance.now(), epoch: s.session.owner.epoch, audioStatus: s.session.audio.status,
            mediaTime: s.session.audio.time, frame: s.rendered.frame, finite: s.rendered.finite,
            schedulerFault: s.session.scheduler.fault, audioFault: s.session.audio.fault });
        }, 100);
        const restartTimers = [14000, 28000].map(delay => setTimeout(() => {
          startAndQueue().catch(error => failures.push({ stage: 'restart', error: error.message }));
        }, delay));
        let statistics;
        try { statistics = await lab.measure(30); }
        finally { clearInterval(sampleTimer); restartTimers.forEach(clearTimeout); }
        const final = lab.snapshot(); lab.cancel('avatar_performance_complete');
        return { performance: statistics, snapshots, failures, seenGestures: [...seenGestures], final };
      });
      const stats = measurement.performance;
      const playingSamples = measurement.snapshots.filter(sample => sample.audioStatus === 'playing').length;
      assert(stats && stats.samples >= 100 && ['driverP95Ms', 'motionP95Ms', 'renderSubmitP95Ms', 'frameP95Ms', 'fps'].every(key => Number.isFinite(stats[key]))
        && measurement.snapshots.length >= 200 && playingSamples / measurement.snapshots.length >= .75,
      '30秒真实模型与流式音频性能窗口有足够活跃样本', { performance: stats, observationSamples: measurement.snapshots.length, playingSamples });
      assert(measurement.failures.length === 0 && measurement.snapshots.every(sample => sample.finite && !sample.schedulerFault && !sample.audioFault)
        && measurement.seenGestures.length > 0 && errors.length === 0,
      '持续播放与回复替换期间模型、动作和音频均无故障', { failures: measurement.failures, seenGestures: measurement.seenGestures, errors });
      const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } }));
      result = { passed: true, part, generatedAt: new Date().toISOString(), boundary,
        timingBoundary: 'Driver, motion and renderer submission are CPU intervals. RAF frame cadence is not GPU completion or acoustic playback latency. The 30-second window repeatedly supplies the same local WAV to avoid measuring a long idle tail.',
        environment, checks, measurement, errors };
    }
    await page.evaluate(({ part, result }) => {
      window.__avatarAcceptance ||= {}; window.__avatarAcceptance[part] = result;
    }, { part, result });
    return { passed: result.passed, part, checks: checks.length, evidenceGlobal: `__avatarAcceptance.${part}`,
      performance: result.measurement?.performance, phases: result.phaseTrials?.map(trial => ({ phase: trial.requestedPhase,
        voicedAtCancel: trial.voicedAtCancel, mouthClosedMs: trial.completed.mouthClosedMs, retractCompleteMs: trial.completed.retractCompleteMs })) };
  } catch (error) {
    const final = await read().catch(() => null);
    result = { passed: false, part, generatedAt: new Date().toISOString(), boundary, error: error.message, checks, errors, final };
    await page.evaluate(({ part, result }) => { window.__avatarAcceptance ||= {}; window.__avatarAcceptance[part] = result; }, { part, result }).catch(() => {});
    throw error;
  } finally {
    page.off('pageerror', pageError); page.off('console', consoleError);
  }
}
