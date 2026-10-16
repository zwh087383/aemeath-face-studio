async page => {
  const config = await page.evaluate(() => window.__performanceVisualConfig);
  if (!config || !/^[A-Za-z]:[\\/]/.test(config.directory)) throw new Error('Set absolute __performanceVisualConfig.directory and a gesture ID list');
  await page.waitForFunction(() => window.performanceLab?.ready, undefined, { timeout: 30000 });
  const rows = [], errors = [], onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    for (const id of config.gestures) {
      const timing = await page.evaluate(async id => {
        const { GESTURES } = await import('/preview/core/motion-profile.js');
        return { id, apex: GESTURES[id].apex, cooldown: GESTURES[id].cooldown };
      }, id);
      await page.evaluate(() => { window.performanceLab.stop(); window.performanceLab.setOptions({ speech: false, expression: true }); });
      await page.waitForFunction(() => !window.performanceLab.snapshot().motion.gestures.length);
      await page.waitForFunction(({ id, cooldown }) => {
        const lab = window.performanceLab;
        return lab.director.now - (lab.motion.lastStart.get(id) ?? -100) >= cooldown;
      }, timing);
      const accepted = await page.evaluate(id => window.performanceLab.play(id), id);
      if (!accepted) throw new Error(`Gesture rejected: ${id}`);
      await page.waitForFunction(({ id, apex }) => {
        const s = window.performanceLab.snapshot();
        return s.motion.gestures.some(g => g.gesture === id && g.age >= apex);
      }, timing, { timeout: 10000 });
      await page.locator('#pause').click();
      for (const view of config.views || ['body', 'angle']) {
        await page.locator(`[data-view="${view}"]`).click();
        await page.waitForFunction(view => window.performanceLab.snapshot().rendered.view === view, view);
        const state = await page.evaluate(() => window.performanceLab.snapshot());
        if (!state.rendered.finite || state.error) throw new Error(`Invalid model: ${id}`);
        if (!state.motion.gestures.some(g => g.gesture === id && g.age >= timing.apex && !g.recovering)) throw new Error(`Capture missed authored apex: ${id}`);
        const path = `${config.directory}/${id}-${view}.png`;
        await page.locator('#stage').screenshot({ path });
        rows.push({ id, view, path, state });
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    await page.evaluate(rows => { window.__performanceVisualRows ||= []; window.__performanceVisualRows.push(...rows); }, rows);
    return { passed: true, captures: rows.map(({ id, view, path }) => ({ id, view, path })), errors };
  } finally { page.off('pageerror', onError); }
}
