async page => {
  await page.goto('http://127.0.0.1:18767/lab/');
  await page.waitForFunction(() => !!window.realtimeLab);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshots = [], interruptions = [];
  // These offsets exercise the command pipeline at modeled gesture phases. They
  // do not prove where an avatar's hand is: no character is mounted in this lab.
  for (const [phase, time] of [['prepare', .45], ['stroke', 1.1], ['recover', 2.7]]) {
    await page.evaluate(() => window.realtimeLab.start({ chunkMs: 40, providerFast: true }));
    await page.waitForFunction(t => window.realtimeLab.snapshot().audio.time >= t, time);
    const before = await page.evaluate(() => window.realtimeLab.snapshot());
    await page.evaluate(() => window.realtimeLab.cancel('phase_probe'));
    const after = await page.evaluate(() => window.realtimeLab.snapshot());
    if (after.audio.sourceCount || after.audio.sourceActive || after.scheduler.queued || after.scheduler.fault) throw new Error(`Phase cleanup failed: ${phase}`);
    interruptions.push({ simulatedPhase: phase, mediaTimeBefore: before.audio.time, ...after.lastInterrupt });
  }
  await page.evaluate(async () => {
    await window.realtimeLab.start({ chunkMs: 40, providerFast: false });
    window.__benchmarkPromise = window.realtimeLab.runBenchmark(30);
  });
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(8000);
    snapshots.push(await page.evaluate(() => {
      const s = window.realtimeLab.snapshot();
      return { audio: s.audio, scheduler: { status: s.scheduler.status, counts: s.scheduler.counts, fault: s.scheduler.fault }, error: s.error };
    }));
    await page.evaluate(() => window.realtimeLab.replace({ chunkMs: 40, providerFast: false }));
  }
  const measurement = await page.evaluate(() => window.__benchmarkPromise);
  await page.evaluate(() => window.realtimeLab.cancel('benchmark_complete'));
  const final = await page.evaluate(() => window.realtimeLab.snapshot());
  const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, audioSampleRate: window.realtimeLab.snapshot().audio.sampleRate }));
  const result = { environment, boundary: final.boundary, measurement, interruptions, snapshots, errors,
    passed: errors.length === 0 && !final.error && !final.scheduler.fault && snapshots.every(s => !s.error && !s.scheduler.fault)
      && measurement.sampleCount > 300 && (measurement.statusFrames.playing ?? 0) > 200,
    final: { audio: final.audio, scheduler: final.scheduler, lastInterrupt: final.lastInterrupt } };
  await page.evaluate(value => { window.__realtimeBenchmark = value; }, result);
  if (!result.passed) throw new Error('Benchmark encountered driver faults or insufficient active samples');
  return { passed: result.passed, measurement, interruptions, environment };
}
