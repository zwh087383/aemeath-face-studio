async page => {
  const directory = await page.evaluate(() => window.__avatarEvidencePath);
  if (typeof directory !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/.test(directory)) throw new Error('Set an absolute __avatarEvidencePath');
  await page.waitForFunction(() => window.avatarLab?.ready);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.evaluate(() => { window.avatarLab.setView('body'); window.avatarLab.setNatural(true); window.avatarLab.setIdle(true); window.scrollTo(0, 0); });
  const path = `${directory}/avatar-integration-demo.webm`, states = [];
  await page.screencast.start({ path, size: { width: 1280, height: 960 } });
  try {
    await page.screencast.showChapter('Claude 自然动作 · 实验性接线', { description: '四种手势与表情、样例口型共用一条播放时钟。此文件是画面演示。', duration: 1300 });
    await page.locator('#scripted').click();
    await page.waitForFunction(() => window.avatarLab.snapshot().session.audio.status === 'playing');
    for (const gesture of ['wave', 'explain', 'shrug', 'chest']) {
      await page.waitForFunction(gesture => window.avatarLab.snapshot().motion.gestures.some(g => g.gesture === gesture && ['stroke', 'hold'].includes(g.phase)), gesture, { timeout: 10000 });
      states.push(await page.evaluate(() => window.avatarLab.snapshot()));
    }
    await page.waitForFunction(() => { const s = window.avatarLab.snapshot(); return s.session.audio.status === 'ended' && s.motion.gestures.length === 0; }, undefined, { timeout: 8000 });
    await page.screencast.showChapter('字幕旁路 → 动作 → 插话收势', { description: '独立测试字幕，不是样例音频的真实转写。', duration: 1100 });
    await page.locator('#start').click();
    await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.some(g => g.gesture === 'wave' && g.phase === 'stroke'), undefined, { timeout: 7000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${directory}/avatar-live-page.png` });
    await page.locator('#cancel').click();
    await page.waitForFunction(() => window.avatarLab.snapshot().lastInterrupt?.retractCompleteMs !== null, undefined, { timeout: 4000 });
    await page.waitForTimeout(1000);
    const result = { path, generatedAt: new Date().toISOString(), states, final: await page.evaluate(() => window.avatarLab.snapshot()),
      boundary: 'Screen recording only; UI controls operated against the real avatar. Not an audio or performance measurement.' };
    await page.evaluate(result => { window.__avatarDemo = result; }, result);
    return { path, gestures: states.map(s => s.motion.gestures.map(g => g.gesture)), ready: result.final.ready, error: result.final.error };
  } finally { await page.screencast.stop(); }
}
