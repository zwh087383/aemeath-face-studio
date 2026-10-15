async page => {
  const results = [];
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push({ type: 'pageerror', message: error.message }));
  page.on('console', event => { if (event.type() === 'error') browserErrors.push({ type: 'console', message: event.text() }); });
  const assert = (condition, label, detail) => { if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`); results.push({ label, passed: true, detail }); };
  const read = () => page.evaluate(() => window.realtimeLab.snapshot());
  try {
  await page.goto('http://127.0.0.1:18767/lab/');
  await page.waitForFunction(() => !!window.realtimeLab);
  await page.locator('#fast').check();
  await page.locator('#start').click();
  await page.waitForFunction(() => { const s = window.realtimeLab.snapshot(); return s.providerFinished && s.audio.status === 'playing' && s.audio.time > 0.15; }, undefined, { timeout: 10000 });
  const generated = await read();
  assert(generated.audio.queuedSeconds > 1 && generated.audio.finished, 'providerDone 不等于播放完成', { time: generated.audio.time, queuedSeconds: generated.audio.queuedSeconds, status: generated.audio.status });
  await page.locator('#pause').click();
  const paused = await read();
  await page.waitForTimeout(350);
  const stillPaused = await read();
  assert(stillPaused.audio.status === 'paused' && Math.abs(stillPaused.audio.time - paused.audio.time) < .002 && stillPaused.audio.sourceCount === 0, '暂停冻结媒体进度并清除排程节点', { before: paused.audio.time, after: stillPaused.audio.time, sources: stillPaused.audio.sourceCount });
  await page.locator('#resume').click();
  await page.waitForFunction(t => window.realtimeLab.snapshot().audio.time > t + .12, paused.audio.time, { timeout: 5000 });
  const resumed = await read();
  assert(resumed.identity.epoch === paused.identity.epoch, '恢复保留同一代次', { epoch: resumed.identity.epoch });
  const interruptedAt = Date.now();
  await page.locator('#cancel').click();
  const cancelled = await read();
  assert(cancelled.audio.status === 'cancelled' && cancelled.audio.sourceCount === 0 && !cancelled.audio.sourceActive, '打断立即清除全部旧音频源', { toolRoundTripMs: Date.now() - interruptedAt, localHandler: cancelled.lastInterrupt, audio: cancelled.audio });
  const cleanup = cancelled.events.filter(e => e.identity?.epoch === cancelled.identity.epoch && ['stop_audio', 'retract', 'posture'].includes(e.type)).slice(-3);
  assert(cleanup.map(e => e.type).join(',') === 'stop_audio,retract,posture' && cleanup[2].posture === 'listening', '打断交付停音频、收势和倾听命令', cleanup);
  const stale = await page.evaluate(() => window.realtimeLab.injectStale());
  assert(!stale.accepted, '取消后的旧动作拒绝', stale);
  await page.evaluate(() => window.realtimeLab.resume());
  await page.waitForTimeout(100);
  const notResurrected = await read();
  assert(notResurrected.audio.status === 'cancelled' && notResurrected.audio.sourceCount === 0, '旧代次无法被 resume 复活', { status: notResurrected.audio.status });
  await page.locator('#replace').click();
  await page.waitForFunction(e => { const s = window.realtimeLab.snapshot(); return s.identity?.epoch > e && s.audio.status === 'playing'; }, cancelled.identity.epoch, { timeout: 5000 });
  const replaced = await read();
  const rejected = await page.evaluate(() => window.realtimeLab.injectStale());
  assert(!rejected.accepted && replaced.audio.epoch === replaced.identity.epoch, '新回复代次隔离旧提示', { epoch: replaced.identity.epoch, rejected });
  const sample = await page.evaluate(() => window.realtimeLab.runBenchmark(2));
  assert(sample.sampleCount > 10 && Number.isFinite(sample.schedulerP95Ms), '浏览器本地调度采样', sample);
  await page.locator('#cancel').click();
  await page.locator('#fast').uncheck();
  await page.locator('#starve').check();
  await page.locator('#chunk').selectOption('20');
  await page.locator('#start').click();
  await page.waitForFunction(() => {
    const s = window.realtimeLab.snapshot();
    return s.audio.status === 'buffering' && s.audio.receivedDuration >= 1 && Math.abs(s.audio.time - s.audio.receivedDuration) < .0001
      && s.events.some(x => x.type === 'network_gap' && x.epoch === s.identity?.epoch)
      && s.statusHistory.some(x => x.epoch === s.identity?.epoch && x.status === 'playing');
  }, undefined, { timeout: 7000 });
  const starved = await read();
  await page.waitForTimeout(180);
  const stillStarved = await read();
  assert(stillStarved.audio.status === 'buffering' && Math.abs(stillStarved.audio.time - starved.audio.time) < .002, '断流时媒体时间冻结', { before: starved.audio.time, after: stillStarved.audio.time });
  await page.waitForFunction(t => { const s = window.realtimeLab.snapshot(); return s.audio.status === 'playing' && s.audio.time > t + .15; }, starved.audio.time, { timeout: 5000 });
  const recovered = await read();
  assert(recovered.identity.epoch === starved.identity.epoch, '续包恢复同一音频时间线', { epoch: recovered.identity.epoch, time: recovered.audio.time });
  await page.locator('#cancel').click();
  const final = await read();
  assert(!final.error && !final.scheduler.fault, '验收结束无驱动故障', { error: final.error, fault: final.scheduler.fault });
  assert(browserErrors.length === 0, '浏览器无脚本或控制台错误', browserErrors);
  const result = { boundary: final.boundary, results, browserErrors, final };
  await page.evaluate(value => { window.__realtimeAcceptance = value; }, result);
  return result;
  } catch (error) {
    const final = await read().catch(() => null);
    const result = { failed: true, error: error.message, results, browserErrors, final };
    await page.evaluate(value => { window.__realtimeAcceptance = value; }, result).catch(() => {});
    throw error;
  }
}
