import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPreparationServer } from '../realtime/action-preparation/server.mjs';

test('preparation routes are read-only and expose only the selected local catalog', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'action-prep-'));
  const file = path.join(directory, 'catalog.json'); await writeFile(file, JSON.stringify({ privateFixture: 'expected' }));
  const server = createPreparationServer({ catalogFile: file });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/action-preparation/')).status, 200);
  assert.deepEqual(await (await fetch(base + '/action-preparation-data/catalog.json')).json(), { privateFixture: 'expected' });
  assert.equal((await fetch(base + '/action-preparation-data/catalog.json', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/action-preparation-data/raw.json')).status, 404);
  assert.equal((await fetch(base + '/action-preparation-data/catalog.json', { method: 'HEAD' })).headers.get('content-type'), 'application/json; charset=utf-8');
  const external = await new Promise(resolve => { http.get(base + '/action-preparation/', { headers: { Host: 'external.example' } }, r => { r.resume(); resolve(r.statusCode); }); });
  assert.equal(external, 403);
});
