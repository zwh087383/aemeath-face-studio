import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const faceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.md': 'text/plain; charset=utf-8' };
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Read-only, loopback-only host for the integrated experiment. Outputs and the
 * rest of the shared workspace are not mounted as general-purpose directories. */
export function createAvatarServer({ root = faceRoot } = {}) {
  const files = new Map([
    ['/sample.wav', 'audio/chinese-probe.wav'],
    ['/data/chinese-probe.json', 'outputs/chinese-probe.json'],
    ['/data/waveform.json', 'outputs/waveform.json'],
    ['/preview/studio/motion-rig.js', 'preview/studio/motion-rig.js'],
  ]);
  const mounts = [
    ['/preview/core/', 'preview/core'], ['/model/', 'assets/Aemeath'],
    ['/node_modules/three/', 'preview/node_modules/three'],
    ['/node_modules/@takahirox/three-mmd/', 'preview/node_modules/@takahirox/three-mmd'],
    ['/node_modules/mmd-parser/', 'preview/node_modules/mmd-parser'],
  ];
  const server = http.createServer(async (req, res) => {
    const fail = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : message); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Read-only server');
    const port = server.address()?.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return fail(403, 'Invalid host');
    try {
      const name = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
      if (name.includes('\0') || name.includes('\\') || name.split('/').some(part => part.startsWith('.'))) return fail(403, 'Path denied');
      if (name === '/') { res.writeHead(302, { Location: '/avatar/' }); return res.end(); }
      let target;
      if (files.has(name)) {
        target = await realpath(path.join(root, files.get(name)));
        // Exact data aliases may not escape their expected physical parent.
        const expectedParent = await realpath(path.dirname(path.join(root, files.get(name))));
        if (!inside(expectedParent, target)) return fail(403, 'Path denied');
      } else {
        const mount = mounts.find(([prefix]) => name.startsWith(prefix));
        const base = await realpath(path.join(root, mount ? mount[1] : 'realtime'));
        let relative = mount ? name.slice(mount[0].length) : name.slice(1);
        if (relative.endsWith('/')) relative += 'index.html';
        target = await realpath(path.resolve(base, relative));
        if (!inside(base, target)) return fail(403, 'Path denied');
      }
      if (!(await stat(target)).isFile()) return fail(404, 'Not found');
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      fail(error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500, 'Local resource unavailable');
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port');
  const port = Number(index < 0 ? 18768 : process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = createAvatarServer();
  server.listen(port, '127.0.0.1', () => console.log(`Experimental avatar integration: http://127.0.0.1:${port}/avatar/`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
