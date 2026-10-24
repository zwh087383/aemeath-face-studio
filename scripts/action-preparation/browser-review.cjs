async page => {
  const checks = [], errors = [];
  const assert = (ok, name) => { checks.push({ name, passed: Boolean(ok) }); if (!ok) throw Error(name); };
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:18794/action-preparation/');
  await page.waitForFunction(() => window.actionPreparation?.snapshot().ready, null, { timeout: 30000, polling: 250 });
  const catalog = await page.evaluate(async () => (await fetch('/action-preparation-data/catalog.json')).json());
  assert(await page.locator('#records .record').count() === 25, 'list is paginated');
  await page.locator('#kind').selectOption('gesture');
  assert((await page.evaluate(() => window.actionPreparation.snapshot())).visible === 56, 'all 56 authored gestures searchable');
  await page.locator('#search').fill('没有这样的动作');
  assert((await page.evaluate(() => window.actionPreparation.snapshot())).visible === 0, 'empty search retains no stale matches');
  await page.locator('#search').fill(''); await page.locator('#kind').selectOption('');
  for (const [kind, runtimeId] of [['gesture', 'greet'], ['expression', 'happy'], ['micro', 'nod'], ['activity', 'walk_forward'], ['sequence', 'reading_break']]) {
    const row = catalog.items.find(r => r.sourceCatalog === 'authored' && r.kind === kind && r.runtimeId === runtimeId);
    assert(Boolean(row), `${kind} source record exists`);
    await page.evaluate(id => window.actionPreparation.select(id), row.id);
    await page.locator('#detail > button').click();
    await page.waitForFunction(() => /本条已交给/.test(document.getElementById('preview-status').textContent)
      || /资源尚不能|预览准备未完成/.test(document.getElementById('preview-status').textContent), null, { timeout: 200000, polling: 250 });
    const status = await page.locator('#preview-status').innerText();
    assert(status.startsWith('本条已交给'), `${kind} actual runtime accepted: ${status}`);
    const active = await page.evaluate(() => {
      const w = document.getElementById('preview').contentWindow;
      const api = w.activityLab ?? w.performanceLab;
      const value = api.snapshot(); api.stop(); return value;
    });
    assert(!active.error, `${kind} preview has no runtime error`);
  }
  const blocked = catalog.items.find(r => r.preparationStatus === 'blocked');
  await page.evaluate(id => window.actionPreparation.select(id), blocked.id);
  assert(await page.locator('#detail > button').count() === 0, 'archived missing clip has no false play button');
  const native = catalog.items.find(r => r.id === 'body-wuzui02-start-ea77396c2f');
  await page.evaluate(id => window.actionPreparation.select(id), native.id);
  await page.locator('#detail > button').click();
  await page.waitForFunction(() => /本条身体已加载|资源尚不能|预览准备未完成/.test(document.getElementById('preview-status').textContent), null, { timeout: 200000, polling: 250 });
  assert((await page.locator('#preview-status').innerText()).startsWith('本条身体已加载'), 'recovered original source loads in actual native viewer');
  const status = await page.evaluate(() => document.getElementById('preview').contentWindow.nativeResources.snapshot());
  assert(status.currentId === native.id && !status.error, 'native viewer actual current clip identity matches catalog');
  await page.screenshot({ path: 'outputs/action-preparation-20261023/preparation-page.png', fullPage: true });
  assert(errors.length === 0, 'no page errors');
  return { measuredAt: new Date().toISOString(), passed: checks.every(c => c.passed), checks, errors };
}
