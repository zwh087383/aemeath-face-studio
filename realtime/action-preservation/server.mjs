// Read-only local comparison; no provider routes and no access to raw ledgers.
import { createFacePreparationServer } from '../face-preparation-lab/server.mjs';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const baseline = '21288ee870b178d80c5b38eb060625d9ae1e5589';
const oldBody = execFileSync('git', ['show', `${baseline}:realtime/character-center/body-director.mjs`], { cwd: root, windowsHide: true, encoding: 'utf8' })
  .replace("'./catalog.mjs'", "'/character-center/catalog.mjs'");
const at = process.argv.indexOf('--port'), port = at < 0 ? 18821 : Number(process.argv[at+1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('invalid_port');
const server = createFacePreparationServer(), previous = server.listeners('request')[0]; server.removeAllListeners('request');
server.on('request', async (req, res) => {
  let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); return res.end(); }
  if (!url.pathname.startsWith('/action-preservation/')) return previous(req, res);
  const fail = code => { res.writeHead(code); res.end(); };
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return fail(403);
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return fail(403);
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const name = url.pathname.slice('/action-preservation/'.length);
    let bytes, mime = 'text/javascript; charset=utf-8';
    if (name === 'legacy-body.mjs') bytes = oldBody;
    else if (name === 'legacy-scene.mjs') {
      const source = await readFile(path.join(root, 'realtime/character-center/scene.mjs'), 'utf8');
      bytes = source.replace(/from\s+(['"])(\.[^'"]+)\1/g, (_, quote, spec) => {
        const target = spec === './body-director.mjs' ? '/action-preservation/legacy-body.mjs'
          : new URL(spec, 'http://127.0.0.1/character-center/scene.mjs').pathname;
        return `from ${quote}${target}${quote}`;
      });
    } else if (name === 'data.json') {
      bytes = await readFile(path.join(root, 'outputs/action-preservation-20261028/comparison-data.json')); mime = 'application/json; charset=utf-8';
    } else if (['', 'index.html', 'viewer.mjs', 'style.css'].includes(name)) {
      bytes = await readFile(path.join(here, name || 'index.html'));
      if (!name || name.endsWith('.html')) mime = 'text/html; charset=utf-8';
      if (name.endsWith('.css')) mime = 'text/css; charset=utf-8';
    } else if (/^video\/short-(03|08)\.webm$/.test(name)) {
      const id = path.basename(name, '.webm');
      const file = path.join(root, 'outputs/character-campaign-simtime-20261027/cases', id, `preview-${id}-original-speed.webm`);
      const size = (await stat(file)).size;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), size-1) : size-1;
      if (start > end || start >= size) return fail(416);
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes',
        'Content-Length': end-start+1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file, { start, end }).pipe(res);
    } else return fail(404);
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) { fail(error.code === 'ENOENT' ? 404 : 500); }
});
server.listen(port, '127.0.0.1', () => console.log(`Action comparison: http://127.0.0.1:${port}/action-preservation/`));
