async page => {
  // Invoke separately with __avatarSidecarPart = semantic | starve | autopause |
  // ended_cancel | ended_replace. This script never calls the manual cue API.
  const part = await page.evaluate(() => window.__avatarSidecarPart || 'semantic');
  if (!['semantic', 'starve', 'autopause', 'ended_cancel', 'ended_replace'].includes(part)) throw new Error(`Unknown sidecar part: ${part}`);
  const checks = [], errors = [];
  const read = () => page.evaluate(() => window.avatarLab.snapshot());
  const accept = result => result === true || result?.accepted === true;
  const assert = (condition, name, detail) => {
    if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`);
    checks.push({ name, passed: true, detail });
  };
  const sameOwner = (a, b) => a && b && a.connectionId === b.connectionId && a.responseId === b.responseId && a.epoch === b.epoch;
  const cueEvents = state => state.session.events.filter(event => event.type === 'cue' && sameOwner(event.owner, state.session.owner));
  const pageError = error => errors.push({ type: 'pageerror', message: error.message });
  const consoleError = event => { if (event.type() === 'error') errors.push({ type: 'console', message: event.text() }); };
  page.on('pageerror', pageError); page.on('console', consoleError);
  const boundary = 'Real subtitle Worker -> scheduler -> existing face/body controllers -> rendered PMX. Test subtitles are independent of the local WAV; its precomputed lip track is not live inference. Web Audio and rendered-state measurements do not prove physical speaker timing or word alignment.';
  const start = async (options = {}) => {
    const accepted = await page.evaluate(options => window.avatarLab.start({ sidecar: true, autoSubtitles: false,
      providerFast: false, starve: false, chunkMs: 20, ...options }), options);
    if (accepted !== true) throw new Error(`Avatar start failed: ${JSON.stringify(accepted)}`);
    await page.waitForFunction(() => {
      const s = window.avatarLab.snapshot(); return s.session.audio.status === 'playing' && s.session.audio.time > .08;
    }, undefined, { timeout: 7000 });
    return read();
  };
  const push = (text, options = {}) => page.evaluate(({ text, options }) => window.avatarLab.pushSubtitle(text, options), { text, options });
  const waitForBudget = async (gesture, preset) => page.evaluate(async ({ gesture, preset }) => {
    // Cooldowns intentionally survive replies. Respect recent authoritative
    // queued decisions instead of treating legal suppression as pipeline failure.
    const now = performance.now() / 1000, events = window.avatarLab.snapshot().session.events;
    let until = now;
    for (const event of events) {
      if (event.type !== 'subtitle' || event.decision?.status !== 'queued' || !Number.isFinite(event.atWall)) continue;
      for (const cue of event.decision.cues || []) {
        if (gesture && cue.kind !== 'expression') {
          until = Math.max(until, event.atWall + 3);
          if (cue.kind === 'gesture' && cue.gesture === gesture) until = Math.max(until, event.atWall + 8);
        }
        if (preset && cue.kind === 'expression' && cue.preset === preset) until = Math.max(until, event.atWall + 6);
      }
    }
    const waitMs = Math.max(0, Math.ceil((until - now) * 1000));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs + 100));
    return waitMs;
  }, { gesture, preset });
  const waitForRenderedGesture = async gesture => {
    await page.waitForFunction(gesture => {
      const s = window.avatarLab.snapshot();
      const cue = s.session.events.find(event => event.type === 'cue' && event.owner?.epoch === s.session.owner.epoch
        && event.cue?.gesture === gesture && event.cue.id.startsWith('subtitle:'));
      return cue && s.motion.gestures.some(g => g.id === cue.cue.id && !g.recovering) && s.rendered.finite;
    }, gesture, { timeout: 4000 });
    const state = await read();
    const event = cueEvents(state).find(event => event.cue.gesture === gesture && event.cue.id.startsWith('subtitle:'));
    return { state, id: event.cue.id, event };
  };
  let detail = {}, autoPauseInput = null;
  try {
    await page.waitForFunction(() => window.avatarLab?.ready, undefined, { timeout: 30000 });
    await page.evaluate(() => { window.avatarLab.setIdle(false); window.avatarLab.setNatural(false); window.avatarLab.setView('body'); });
    if (part === 'semantic') {
      const cooldownWaitMs = await waitForBudget('wave', 'happy');
      const initial = await start();
      await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.length === 0, undefined, { timeout: 5000 });
      const first = await push('我不会');
      await page.waitForTimeout(220);
      const partial = await read();
      assert(accept(first) && partial.session.sidecar.counts.decisions === initial.session.sidecar.counts.decisions
        && cueEvents(partial).length === 0,
      '真实Worker保留未闭合否定片段，不抢先驱动角色', { input: first, sidecar: partial.session.sidecar });
      const second = await push('摇头。');
      await page.waitForFunction(count => window.avatarLab.snapshot().session.sidecar.counts.decisions > count,
        initial.session.sidecar.counts.decisions, { timeout: 4000 });
      const negative = await read();
      assert(accept(second) && cueEvents(negative).length === 0 && !negative.face.actions.includes('shake'),
        '合并后的否定句在真实角色链路中不触发摇头', { input: second, sidecar: negative.session.sidecar, actions: negative.face.actions });
      const positive = await page.evaluate(async () => {
        const lab = window.avatarLab, { C, AEMEATH_BINDINGS } = await import('/preview/core/profile.js');
        const before = lab.snapshot(), started = performance.now();
        const input = lab.pushSubtitle('我很高兴，我轻轻挥手。');
        if (!input?.accepted) throw new Error(`Positive subtitle rejected: ${JSON.stringify(input)}`);
        const deadline = performance.now() + 4000;
        while (performance.now() < deadline) {
          const s = lab.snapshot(), owner = s.session.owner;
          const events = s.session.events.filter(event => event.owner?.epoch === owner.epoch);
          const wave = events.find(event => event.type === 'cue' && event.cue?.gesture === 'wave' && event.cue.id.startsWith('subtitle:'));
          const happy = events.find(event => event.type === 'cue' && event.cue?.preset === 'happy' && event.cue.id.startsWith('subtitle:'));
          const smileEyes = s.rendered.morphWeights[AEMEATH_BINDINGS[C.smileEyes][0]];
          const wrist = s.rendered.bones.rightWrist.position, original = before.rendered.bones.rightWrist.position;
          const wristDelta = Math.hypot(...wrist.map((value, index) => value - original[index]));
          if (wave && happy && s.face.preset === 'happy' && smileEyes > .1 && wristDelta > 1e-4
            && s.motion.gestures.some(g => g.id === wave.cue.id && !g.recovering)) {
            return { input, elapsedToObservedRenderMs: performance.now() - started, before,
              observed: s, waveCue: wave, happyCue: happy, smileEyes, wristDelta };
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        throw new Error('Positive subtitle did not reach both actual facial morph and body gesture before the deadline');
      });
      assert(positive.observed.session.sidecar.counts.jobs > initial.session.sidecar.counts.jobs
        && positive.observed.session.sidecar.counts.queuedCues >= initial.session.sidecar.counts.queuedCues + 2
        && positive.waveCue.accepted && positive.happyCue.accepted,
      '字幕经过Worker、调度器和实际执行端，同时产生开心表情与挥手', {
        elapsedToObservedRenderMs: positive.elapsedToObservedRenderMs, smileEyes: positive.smileEyes,
        wristDelta: positive.wristDelta, waveCue: positive.waveCue, happyCue: positive.happyCue,
        sidecar: positive.observed.session.sidecar,
      });
      await page.evaluate(() => window.avatarLab.cancel('avatar_semantic_complete'));
      await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.length === 0, undefined, { timeout: 5000 });
      detail = { cooldownWaitMs, initial, negative, positive };
    } else if (part === 'starve') {
      const cooldownWaitMs = await waitForBudget('chest');
      const initial = await start({ starve: true });
      const input = await push('我把手放在胸前。');
      const dispatched = await waitForRenderedGesture('chest');
      assert(accept(input) && dispatched.event.accepted, '断供前由真实字幕Worker启动胸前手势', { input, cue: dispatched.event });
      await page.waitForFunction(id => {
        const s = window.avatarLab.snapshot(), a = s.session.audio;
        return a.status === 'buffering' && a.receivedDuration >= 1 && Math.abs(a.time - a.receivedDuration) < .0001
          && s.session.events.some(event => event.type === 'starvation' && event.owner?.epoch === s.session.owner.epoch)
          && s.motion.gestures.some(g => g.id === id && g.clock === 'audio' && !g.recovering);
      }, dispatched.id, { timeout: 7000 });
      const starved = await read();
      await page.waitForTimeout(300);
      const held = await read();
      const beforeGesture = starved.motion.gestures.find(g => g.id === dispatched.id);
      const heldGesture = held.motion.gestures.find(g => g.id === dispatched.id);
      assert(held.session.audio.status === 'buffering' && Math.abs(held.session.audio.time - starved.session.audio.time) < .002
        && held.rendered.mouthOpen <= .01 && heldGesture && Math.abs(heldGesture.age - beforeGesture.age) < 1e-6,
      '受控断供期间媒体时间与语音动作冻结，真实嘴型关闭', {
        mediaBefore: starved.session.audio.time, mediaAfter: held.session.audio.time, mouthOpen: held.rendered.mouthOpen,
        beforeGesture, heldGesture, beforeWrist: starved.rendered.bones.rightWrist, heldWrist: held.rendered.bones.rightWrist,
      });
      await page.waitForFunction(({ time, id }) => {
        const s = window.avatarLab.snapshot();
        return s.session.audio.status === 'playing' && s.session.audio.time > time + .2 && s.motion.gestures.some(g => g.id === id && !g.recovering);
      }, { time: held.session.audio.time, id: dispatched.id }, { timeout: 5000 });
      const recovered = await read(), recoveredGesture = recovered.motion.gestures.find(g => g.id === dispatched.id);
      const dispatches = cueEvents(recovered).filter(event => event.cue.id === dispatched.id);
      assert(sameOwner(recovered.session.owner, initial.session.owner) && recoveredGesture.age > heldGesture.age && dispatches.length === 1,
        '续包在同一代次继续原手势，字幕动作不重新派发', { before: heldGesture, after: recoveredGesture, dispatches: dispatches.length, owner: recovered.session.owner });
      await page.waitForFunction(() => window.avatarLab.snapshot().rendered.mouthOpen > .04, undefined, { timeout: 5000 });
      const speakingAgain = await read();
      assert(speakingAgain.session.audio.time > held.session.audio.time && speakingAgain.rendered.finite,
        '续包后真实发音口型恢复', { mouthOpen: speakingAgain.rendered.mouthOpen, mediaTime: speakingAgain.session.audio.time });
      await page.evaluate(() => window.avatarLab.cancel('avatar_starve_complete'));
      await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.length === 0, undefined, { timeout: 5000 });
      detail = { cooldownWaitMs, initial, dispatched, starved, held, recovered, speakingAgain };
    } else if (part === 'autopause') {
      autoPauseInput = await page.locator('#subtitle-input').inputValue();
      await page.locator('#subtitle-input').fill('我们可以慢慢聊聊今天发生的事情，先把完整的想法说完，然后再讨论下一步。');
      const initial = await start({ autoSubtitles: true });
      await page.waitForFunction(() => window.avatarLab.snapshot().displayedSubtitle.length >= 2, undefined, { timeout: 4000 });
      const started = await read();
      const pause = await page.evaluate(() => window.avatarLab.pause());
      const paused = await read();
      await page.waitForTimeout(900);
      const held = await read();
      assert(pause === true && held.session.audio.status === 'paused'
        && Math.abs(held.session.audio.time - paused.session.audio.time) < .002
        && held.displayedSubtitle === paused.displayedSubtitle
        && held.session.sidecar.receivedChunks === paused.session.sidecar.receivedChunks,
      '自动测试字幕在暂停的三个供给周期内不推进', { pause, subtitleBefore: paused.displayedSubtitle,
        subtitleAfter: held.displayedSubtitle, mediaBefore: paused.session.audio.time, mediaAfter: held.session.audio.time,
        chunksBefore: paused.session.sidecar.receivedChunks, chunksAfter: held.session.sidecar.receivedChunks });
      const resumed = await page.evaluate(() => window.avatarLab.resume());
      await page.waitForFunction(({ length, time }) => {
        const s = window.avatarLab.snapshot(); return s.displayedSubtitle.length > length && s.session.audio.time > time + .1;
      }, { length: held.displayedSubtitle.length, time: held.session.audio.time }, { timeout: 4000 });
      const continued = await read();
      assert(resumed === true && sameOwner(continued.session.owner, initial.session.owner)
        && continued.displayedSubtitle.startsWith(held.displayedSubtitle),
      '恢复后自动字幕与媒体时间在同一回复继续', { resumed, owner: continued.session.owner,
        beforeSubtitle: held.displayedSubtitle, afterSubtitle: continued.displayedSubtitle, mediaTime: continued.session.audio.time });
      await page.evaluate(() => window.avatarLab.cancel('avatar_autopause_complete'));
      detail = { initial, started, paused, held, continued };
    } else {
      const initial = await start({ providerFast: true });
      await page.waitForFunction(() => window.avatarLab.snapshot().session.audio.finished, undefined, { timeout: 5000 });
      const generated = await read();
      assert(generated.session.audio.status !== 'ended' && generated.session.audio.time < generated.session.duration - 5,
        '快速收完PCM后角色仍沿实际播放时钟说话', { audio: generated.session.audio, duration: generated.session.duration });
      // More than eight seconds elapse before this input, so prior per-gesture
      // subtitle cooldowns cannot suppress this wave. It is created only by text.
      await page.waitForFunction(() => {
        const s = window.avatarLab.snapshot();
        return s.session.audio.status === 'playing' && s.session.audio.time >= s.session.duration - 1.1;
      }, undefined, { timeout: 20000 });
      const input = await push('我轻轻挥手。');
      const dispatched = await waitForRenderedGesture('wave');
      assert(accept(input) && dispatched.event.accepted, '临近自然结束时字幕Worker产生真实挥手', { input, cue: dispatched.event });
      await page.waitForFunction(() => window.avatarLab.snapshot().session.audio.status === 'ended', undefined, { timeout: 5000 });
      const ended = await read(), tail = ended.motion.gestures.find(g => g.id === dispatched.id);
      assert(ended.session.audio.sourceCount === 0 && ended.session.scheduler.queued === 0 && tail
        && tail.clock === 'wall' && !tail.recovering && !ended.motion.active,
      '自然播完后保留真实身体动作尾部，并转为本地时钟', { audio: ended.session.audio, motion: ended.motion, tail });
      if (part === 'ended_cancel') {
        const cancelled = await page.evaluate(() => { const accepted = window.avatarLab.cancel('avatar_ended_tail_cancel'); return { accepted, state: window.avatarLab.snapshot() }; });
        assert(cancelled.accepted && cancelled.state.motion.gestures.some(g => g.id === dispatched.id && g.recovering)
          && cancelled.state.session.audio.sourceCount === 0 && cancelled.state.session.scheduler.queued === 0,
        '自然结束后的明确取消仍收回身体尾部', { accepted: cancelled.accepted, motion: cancelled.state.motion, interrupt: cancelled.state.lastInterrupt });
        await page.waitForFunction(() => {
          const s = window.avatarLab.snapshot(); return s.motion.gestures.length === 0 && Number.isFinite(s.lastInterrupt?.retractCompleteMs);
        }, undefined, { timeout: 5000 });
        const settled = await read();
        const late = await push('我轻轻挥手。', { owner: ended.session.owner, itemId: 'old-ended-text', sequence: 0 });
        const resume = await page.evaluate(() => window.avatarLab.resume());
        assert(!accept(late) && resume !== true && settled.motion.posture === 'listening' && settled.rendered.mouthOpen <= .01,
          '尾部收回后旧字幕与resume不能复活已结束回复', { late, resume, settled: settled.motion, interrupt: settled.lastInterrupt });
        detail = { initial, generated, dispatched, ended, cancelled, settled, late, resume };
      } else {
        const replacement = await start();
        const carried = replacement.motion.gestures.filter(g => g.id === dispatched.id);
        assert(replacement.session.owner.epoch > ended.session.owner.epoch
          && replacement.face.epoch === replacement.session.owner.epoch && replacement.motion.epoch === replacement.session.owner.epoch
          && carried.every(g => g.recovering),
        '自然结束后的换轮会收回旧尾部，并统一新回复代次', { oldOwner: ended.session.owner, owner: replacement.session.owner,
          faceEpoch: replacement.face.epoch, motionEpoch: replacement.motion.epoch, carried });
        const late = await push('我轻轻挥手。', { owner: ended.session.owner, itemId: 'old-ended-text', sequence: 0 });
        const fresh = await push('我很高兴。');
        await page.waitForFunction(() => {
          const s = window.avatarLab.snapshot();
          return s.face.preset === 'happy' && s.session.events.some(event => event.type === 'cue' && event.owner?.epoch === s.session.owner.epoch
            && event.cue?.preset === 'happy' && event.cue.id.startsWith('subtitle:'));
        }, undefined, { timeout: 4000 });
        await page.waitForFunction(id => !window.avatarLab.snapshot().motion.gestures.some(g => g.id === id), dispatched.id, { timeout: 5000 });
        const recovered = await read();
        assert(!accept(late) && accept(fresh) && recovered.session.audio.time > replacement.session.audio.time
          && recovered.motion.gestures.every(g => g.epoch === recovered.session.owner.epoch || g.recovering),
        '新轮字幕Worker恢复驱动，旧尾部消失且旧字幕被拒绝', { late, fresh, owner: recovered.session.owner,
          face: recovered.face, motion: recovered.motion, audio: recovered.session.audio });
        await page.evaluate(() => window.avatarLab.cancel('avatar_ended_replace_complete'));
        detail = { initial, generated, dispatched, ended, replacement, late, fresh, recovered };
      }
    }
    const final = await read();
    assert(final.rendered.finite && final.rendered.missingBindings.length === 0 && !final.error
      && !final.session.lastError && !final.session.scheduler.fault && !final.session.audio.fault && errors.length === 0,
    '真实字幕联合场景结束无绑定、音频或调度故障', { errors, error: final.error, sessionError: final.session.lastError,
      schedulerFault: final.session.scheduler.fault, audioFault: final.session.audio.fault, missingBindings: final.rendered.missingBindings });
    const result = { passed: true, generatedAt: new Date().toISOString(), part, boundary, checks, detail, errors, final,
      stimulus: 'All expression and gesture cues in this script originate from pushSubtitle; no manual enqueue call is used.' };
    await page.evaluate(({ part, result }) => { window.__avatarSidecar ||= {}; window.__avatarSidecar[part] = result; }, { part, result });
    return { passed: true, part, checks: checks.length, evidenceGlobal: `__avatarSidecar.${part}`,
      semanticObservedMs: detail.positive?.elapsedToObservedRenderMs, retractCompleteMs: detail.settled?.lastInterrupt?.retractCompleteMs };
  } catch (error) {
    const final = await read().catch(() => null);
    const result = { passed: false, generatedAt: new Date().toISOString(), part, boundary, error: error.message, checks, detail, errors, final };
    await page.evaluate(({ part, result }) => { window.__avatarSidecar ||= {}; window.__avatarSidecar[part] = result; }, { part, result }).catch(() => {});
    throw error;
  } finally {
    if (autoPauseInput !== null) await page.locator('#subtitle-input').fill(autoPauseInput).catch(() => {});
    page.off('pageerror', pageError); page.off('console', consoleError);
  }
}
