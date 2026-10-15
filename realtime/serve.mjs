import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const audioFile = path.resolve(root, '..', 'audio', 'chinese-probe.wav');
const portArg = process.argv.indexOf('--port');
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : (process.env.FACE_REALTIME_PORT || 18767));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
const realRoot = await realpath(root);
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.md': 'text/plain; charset=utf-8' };
function contained(file) {
  const relative = path.relative(realRoot, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const fail = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : message); };
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
  try {
    const host = req.headers.host || '';
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return fail(403, 'Invalid host');
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(p => p.startsWith('.'))) return fail(403, 'Path denied');
    if (pathname === '/') { res.writeHead(302, { Location: '/lab/' }); return res.end(); }
    const target = pathname === '/sample.wav' ? audioFile : path.resolve(realRoot, '.' + (pathname.endsWith('/') ? `${pathname}index.html` : pathname));
    const resolved = await realpath(target);
    if (pathname !== '/sample.wav' && !contained(resolved)) return fail(403, 'Path denied');
    if (!(await stat(resolved)).isFile()) return fail(404, 'Not found');
    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': mime[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error instanceof URIError) return fail(400, 'Invalid path encoding');
    fail(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, 'File unavailable');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Realtime lab: http://127.0.0.1:${port}/lab/ (local WAV; no avatar or cloud)`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
