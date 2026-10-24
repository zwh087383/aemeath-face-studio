async page => {
  const report = { measuredAt: new Date().toISOString(), scope: 'Full native curve span and natural return to the latest base, actual PMX surface finite checks; no audio.', recipes: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.facePreparation?.snapshot().ready, null, { timeout: 180000, polling: 250 });
  await page.evaluate(() => window.facePreparation.setManualClock(true));
  const ids = await page.evaluate(() => window.facePreparation.data.recipes.filter(r => r.previewAvailable).map(r => r.id));
  for (const id of ids) {
    report.recipes.push(await page.evaluate(id => {
      const api = window.facePreparation; api.resetForReview(); api.setBase('smile'); api.drawAt(2, { bodyTime: 0, speaking: false });
      if (!api.choose(id)) throw Error('Recipe not accepted');
      const duration = api.snapshot().face.active.attack + api.snapshot().face.active.hold + api.snapshot().face.active.release;
      let finite = true;
      for (let i = 1; i <= 9; i++) { api.drawAt(2 + duration * i / 9, { bodyTime: 0, speaking: false }); finite &&= api.surface(id).flat().every(Number.isFinite); }
      api.setBase('focus'); api.drawAt(4 + duration, { bodyTime: 0, speaking: false });
      const target = {}, recipe = api.data.recipes.find(r => r.id === 'authored-expression:focus');
      for (const channel of recipe.mapping) for (const leaf of channel.leaves) target[leaf.index] = (target[leaf.index] ?? 0) + (recipe.values[channel.source] ?? 0) * leaf.ratio;
      const end = api.snapshot().face, error = Math.max(...end.weights.map((v, index) => Math.abs(v - (target[index] ?? 0))));
      return { id, duration, finite, returnError: error, complete: !end.active, passed: finite && !end.active && error < 1e-8 };
    }, id));
  }
  report.completedAt = new Date().toISOString(); report.passed = !report.errors.length && report.recipes.every(r => r.passed);
  return report;
}
