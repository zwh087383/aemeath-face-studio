import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAvatarServer } from '../avatar-server.mjs';

test('avatar server exposes only required local resources and read-only routes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'avatar-route-test-'));
  for (const name of ['realtime/avatar/index.html', 'preview/core/controller.js', 'preview/studio/motion-rig.js',
    'outputs/chinese-probe.json', 'outputs/waveform.json', 'outputs/private.json', 'audio/chinese-probe.wav',
    'assets/Aemeath/texture.png', 'preview/node_modules/three/build/three.module.js', 'preview/studio/viewer.js', '.env']) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), name);
  }
  const server = createAvatarServer({ root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const request = (url, { method = 'GET', host = `127.0.0.1:${port}` } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host } }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
  try {
    for (const url of ['/avatar/', '/sample.wav', '/data/chinese-probe.json', '/data/waveform.json', '/model/texture.png', '/preview/core/controller.js', '/preview/studio/motion-rig.js', '/node_modules/three/build/three.module.js']) {
      const result = await request(url); assert.equal(result.status, 200, url); assert.equal(result.headers['cache-control'], 'no-store');
    }
    assert.equal((await request('/')).headers.location, '/avatar/');
    assert.equal((await request('/sample.wav', { method: 'HEAD' })).body, '');
    for (const url of ['/data/private.json', '/outputs/private.json', '/preview/studio/viewer.js', '/%2eenv', '/model/%2e%2e%2f%2eenv', '/model/..%5c..%5c.env']) assert.ok([403, 404].includes((await request(url)).status), url);
    assert.equal((await request('/avatar/', { method: 'POST' })).status, 405);
    assert.equal((await request('/avatar/', { host: 'unrelated.example' })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
