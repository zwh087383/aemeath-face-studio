import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createPreparationServer } from '../action-preparation/server.mjs';
import { verifyFingerprints } from '../../scripts/action-preparation/source-fingerprints.mjs';
import { verifyFacePlaybackSources } from '../../scripts/action-preparation/face-playback-sources.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function createFacePreparationServer() {
  const server = createPreparationServer(), previous = server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    if (!['/face-preparation-data/playback.json', '/native-behavior-data/queue.json'].includes(req.url)) return previous(req, res);
    const port = server.address()?.port;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
    try {
      if (req.url === '/native-behavior-data/queue.json') {
        const bytes = await readFile(path.join(root, 'outputs/action-preparation-20261023/review-queue.json'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const bytes = await readFile(path.join(root, 'outputs/action-execution-preparation-20261023/face-playback.json')), data = JSON.parse(bytes);
      verifyFingerprints(data.dependencies, root);
      await verifyFacePlaybackSources(data, root);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Face preparation unavailable or stale: ' + error.message); }
  }); return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port'), port = at < 0 ? 18796 : Number(process.argv[at + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port');
  const server = createFacePreparationServer(); server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Face preparation: http://127.0.0.1:${port}/face-preparation-lab/`));
}
