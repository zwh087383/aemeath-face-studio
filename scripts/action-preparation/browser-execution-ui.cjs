async page => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-page="/activities/"]').click();
  await page.waitForFunction(() => document.getElementById('lab').contentWindow?.activityLab, null, { timeout: 180000 });
  const frame = page.frames().find(item => /\/activities\/$/.test(item.url()));
  if (!frame) throw Error('Activity review frame was not created');
  await frame.waitForFunction(() => window.activityLab?.ready || window.activityLab?.snapshot().error, null, { timeout: 180000 });
  await frame.evaluate(() => window.activityLab.setManualClock(true));
  const checks = [];
  for (const id of ['book', 'mug', 'pencil', 'box']) {
    const accepted = await page.evaluate(id => window.executionPreparation.arrange(id), id);
    const measured = await frame.evaluate(id => {
      const api = window.activityLab, scene = api.scene, first = scene.props.snapshot();
      scene.step(0, 0); scene.step(.2, .03);
      const after = scene.props.snapshot(), before = first.props[id], prop = after.props[id];
      return { actualTable: after.props.table.visible, actualProp: prop.visible, attachment: prop.attachment,
        scale: prop.scale, movement: Math.hypot(...prop.position.map((value, i) => value - before.position[i])),
        acquisitions: Object.keys(after.acquisitionReceipts), activeId: scene.body.activeId, finite: prop.position.every(Number.isFinite) };
    }, id);
    checks.push({ id, accepted, ...measured, passed: accepted && measured.actualTable && measured.actualProp && measured.finite
      && measured.attachment === 'table' && measured.scale.every(value => value === 1) && measured.movement < 1e-10
      && measured.acquisitions.length === 0 && measured.activeId === null });
  }
  await page.evaluate(() => window.executionPreparation.arrange('book'));
  const rejected = await frame.evaluate(() => {
    const api = window.activityLab, body = api.scene.body, director = api.director;
    if (!api.choose('activities', 'take_book_standing')) throw Error('Real take did not start');
    director.tick(0); let wall = 0;
    for (let i = 0; i < 30 * 30 && !(body.done && body.activeId === 'take_book_standing'); i++) {
      wall += 1 / 30; const clock = director.tick(wall); api.scene.step(clock.now, clock.dt, { render: i % 8 === 0 });
    }
    if (!body.done) throw Error('Actual palm acquisition never completed');
    const before = body.snapshot(), generation = director.generation, prop = api.scene.props.snapshot().props.book;
    const accepted = api.choose('activities', 'take_pencil_seated');
    const after = body.snapshot(), current = api.scene.props.snapshot().props.book;
    return { accepted, acquiredBook: prop.visible && prop.attachment === 'both', unchangedOwner: before.revision === after.revision && generation === director.generation,
      unchangedObject: JSON.stringify(prop) === JSON.stringify(current), text: document.getElementById('status').textContent };
  });
  checks.push({ id: 'real-held-book-rejection', ...rejected, passed: !rejected.accepted && rejected.acquiredBook && rejected.unchangedOwner && rejected.unchangedObject && rejected.text.includes('书') && rejected.text.includes('笔') });
  const missing = await frame.evaluate(() => {
    const api = window.activityLab; api.reset(); api.setManualClock(true); api.choose('activities', 'take_book_standing');
    let wall = 0; api.director.tick(0);
    for (let i = 0; i < 90; i++) { wall += 1 / 30; const clock = api.director.tick(wall); api.scene.step(clock.now, clock.dt, { render: i % 8 === 0 }); }
    api.drawFrame(api.director.time, 0);
    return { blocker: api.scene.body.pose.preparationBlocker, phase: document.getElementById('phase').textContent,
      text: document.getElementById('preparation-note').textContent, visible: !document.getElementById('preparation-note').hidden,
      fabricatedBook: api.scene.props.snapshot().props.book.visible, done: api.scene.body.done };
  });
  checks.push({ id: 'missing-object-is-visible-wait', ...missing, passed: missing.blocker === 'missing-table-object' && missing.visible && missing.phase.includes('等待') && !missing.fabricatedBook && !missing.done });
  await page.evaluate(() => window.executionPreparation.arrange('book'));
  await frame.evaluate(() => { const api = window.activityLab; api.scene.step(0, 0); api.setView('angle'); });
  await page.screenshot({ path: 'outputs/action-execution-preparation-20261023/execution-preparation-ui.png', fullPage: true });
  return { passed: checks.every(row => row.passed) && !errors.length, errors, checks,
    scope: 'Real PMX review UI: explicit tabletop staging, measured book acquisition followed by visible atomic refusal, and missing-object waiting without fabricating a prop or receipt. No real speech or aesthetic acceptance.' };
}
