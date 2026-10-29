async page => {
  await page.waitForFunction(() => window.comparison?.ready === true, { timeout: 60000 });
  const results = [];
  for (const id of ['short-03', 'short-08']) {
    await page.evaluate(id => window.comparison.load(id, 0), id);
    results.push(await page.evaluate(() => window.comparison.advance(30)));
  }
  return results;
}
