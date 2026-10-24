async page => {
  const report = { measuredAt: new Date().toISOString(), errors: [], recipes: [], checks: [], boundary: 'Actual rendered PMX surface samples; no cloud, physical audio, semantic approval or aesthetic proof.' };
  const assert = (value, name) => { report.checks.push({ name, passed: Boolean(value) }); if (!value) throw Error(name); };
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.facePreparation?.snapshot().ready || window.facePreparation?.snapshot().error, null, { timeout: 180000, polling: 250 });
  assert(await page.evaluate(() => !window.facePreparation.snapshot().error), 'actual model loads');
  await page.evaluate(() => window.facePreparation.setManualClock(true));
  const recipes = await page.evaluate(() => window.facePreparation.data.recipes.map(({ id, name, kind, previewAvailable }) => ({ id, name, kind, previewAvailable })));
  for (const recipe of recipes) {
    if (!recipe.previewAvailable) { report.recipes.push({ ...recipe, state: 'unmapped-no-playback-claim' }); continue; }
    const checks = await page.evaluate(({ id }) => {
      const api = window.facePreparation, data = api.data, rows = [];
      for (const speaking of [false, true]) for (const cancelAt of [.13, .8, 1.72]) {
        api.resetForReview(); api.setBase('smile'); api.drawAt(2, { bodyTime: 0, speaking });
        const before = api.surface(id); if (!api.choose(id)) throw Error('Recipe not accepted');
        for (let i = 1; i <= 12; i++) api.drawAt(2 + cancelAt * i / 12, { bodyTime: 0, speaking });
        const peak = api.surface(id), snapshot = api.snapshot();
        const maximumSurfaceChange = peak.reduce((max, point, i) => Math.max(max, Math.hypot(...point.slice(1).map((n, k) => n - before[i][k + 1]))), 0);
        const mouthError = speaking ? Math.max(...data.mouthIndices.map(index => Math.abs(snapshot.face.weights[index] - (index === 52 ? .26 : index === 53 ? .12 : 0)))) : 0;
        const beforeCancel = snapshot.face.expressionWeights, velocity = snapshot.face.velocity;
        if (!api.cancel()) throw Error('Actual owner cancellation rejected');
        api.drawAt(2 + cancelAt, { bodyTime: 0, speaking }); const cancelled = api.snapshot().face;
        const positionGap = Math.max(...cancelled.expressionWeights.map((v, i) => Math.abs(v - beforeCancel[i])));
        const velocityGap = Math.max(...cancelled.velocity.map((v, i) => Math.abs(v - velocity[i])));
        api.setBase('focus'); api.drawAt(4.5 + cancelAt, { bodyTime: 0, speaking });
        const end = api.snapshot().face;
        rows.push({ speaking, cancelAt, maximumSurfaceChange, probeVertices: peak.length, mouthError, positionGap, velocityGap,
          finite: peak.flat().every(Number.isFinite) && end.weights.every(Number.isFinite), cancelled: !end.active });
      }
      return rows;
    }, recipe);
    report.recipes.push({ ...recipe, checks, passed: checks.every(row => row.finite && row.cancelled && row.mouthError === 0 && row.positionGap === 0 && row.velocityGap === 0) });
    if (!report.recipes.at(-1).passed) { report.passed = false; report.completedAt = new Date().toISOString(); return report; }
  }
  assert(report.recipes.filter(r => r.previewAvailable).every(r => r.passed), 'all playable recipes finite with mouth ownership and three cancellation phases');
  assert(report.errors.length === 0, 'no page errors');
  await page.evaluate(() => { const api = window.facePreparation; api.resetForReview(); api.setBase('smile'); api.drawAt(2, { bodyTime: 0 }); api.choose('authored-expression:surprise'); api.drawAt(2.8, { bodyTime: 0 }); });
  await page.locator('#stage').screenshot({ path: 'outputs/action-execution-preparation-20261023/face-surprise-front.png' });
  await page.evaluate(() => { window.facePreparation.setView('side'); window.facePreparation.drawAt(2.8, { bodyTime: 0 }); });
  await page.locator('#stage').screenshot({ path: 'outputs/action-execution-preparation-20261023/face-surprise-side.png' });
  await page.evaluate(() => { window.facePreparation.setView('face'); window.facePreparation.setManualClock(false); });
  report.completedAt = new Date().toISOString(); report.passed = report.checks.every(r => r.passed);
  report.summary = { sources: report.recipes.length, playback: report.recipes.filter(r => r.previewAvailable).length,
    unmapped: report.recipes.filter(r => !r.previewAvailable).length, scenarios: report.recipes.reduce((n, r) => n + (r.checks?.length ?? 0), 0) };
  return report;
}
