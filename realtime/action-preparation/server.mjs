import { createNativeResourcesServer } from '../native-resources/server.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const pages = new Map([
  ['/action-preparation/', ['index.html', 'text/html; charset=utf-8']],
  ['/action-preparation/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/action-preparation/viewer.mjs', ['viewer.mjs', 'text/javascript; charset=utf-8']],
  ['/action-preparation/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createPreparationServer({ catalogFile = path.join(root, 'outputs/action-preparation-20261023/catalog.json') } = {}) {
  const server = createNativeResourcesServer();
  const previous = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { res.writeHead(400); return res.end(); }
    if (!pathname.startsWith('/action-preparation')) return previous(req, res);
    const fail = status => { res.writeHead(status); res.end(); };
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405);
    const port = server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return fail(403);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let file, type;
    if (pathname === '/action-preparation-data/catalog.json') {
      file = catalogFile; type = 'application/json; charset=utf-8';
    } else if (pages.has(pathname)) {
      const [name, mime] = pages.get(pathname); file = path.join(directory, name); type = mime;
    } else return fail(404);
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { fail(error.code === 'ENOENT' ? 404 : 500); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port'), port = Number(at < 0 ? 18794 : process.argv[at + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port');
  const server = createPreparationServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Action preparation: http://127.0.0.1:${port}/action-preparation/`));
}
