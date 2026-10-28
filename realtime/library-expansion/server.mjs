import { createNativeResourcesServer } from '../native-resources/server.mjs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFingerprints } from '../../scripts/action-preparation/source-fingerprints.mjs';
import { verifyFacePlaybackSources } from '../../scripts/action-preparation/face-playback-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const within = (base, target) => { const r = path.relative(base, target); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const types = { '.json': 'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.bmp':'image/bmp', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.wav':'audio/wav' };

/** Source always comes from this checkout. Only explicit private asset aliases
 * read assetRoot; no write route and no broad outputs/workspace mount exists. */
export function createLibraryServer({ assetRoot = root } = {}) {
  const server = createNativeResourcesServer({ dataRoot:path.join(assetRoot,'outputs/native-complete-20261022'), sourceDataRoot:path.join(assetRoot,'outputs/native-motion-20261022') });
  const previous = server.listeners('request')[0]; server.removeAllListeners('request');
  const exact = new Map([
    ['/native-behavior-data/queue.json','outputs/action-preparation-20261023/review-queue.json'],
    ['/face-preparation-data/playback.json','outputs/action-execution-preparation-20261023/face-playback.json'],
    ['/library-data/inspection.json','assets/Aemeath-inspection.json'],
    ['/library-data/sample.wav','audio/chinese-probe.wav'],
  ]);
  server.on('request', async (req,res) => {
    let name; try { name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname); } catch { res.writeHead(400);return res.end(); }
    if (name === '/') {res.writeHead(302,{Location:'/library-expansion/'});return res.end();}
    const isBaseline=name.startsWith('/baseline/')&&['.js','.mjs'].includes(path.extname(name));
    const mount = name.startsWith('/model/') ? ['assets/Aemeath',name.slice(7)] : isBaseline ? ['outputs/library-expansion-20261027/baseline-source',name.slice(10)] : null;
    if(!exact.has(name)&&!mount){if(name.startsWith('/realtime/'))req.url=req.url.replace('/realtime/','/');return previous(req,res);}
    const deny = status => {res.writeHead(status);res.end();};
    if(!['GET','HEAD'].includes(req.method))return deny(405);
    if(![`127.0.0.1:${server.address()?.port}`,`localhost:${server.address()?.port}`].includes(req.headers.host))return deny(403);
    if(name.includes('\\')||name.includes('\0')||name.split('/').some(p=>p.startsWith('.')))return deny(403);
    try {
      const relative=exact.get(name), base=await realpath(path.join(isBaseline?root:assetRoot,mount?mount[0]:path.dirname(relative))), target=await realpath(path.join(base,mount?mount[1]:path.basename(relative)));
      if(!within(base,target)||!(await stat(target)).isFile())return deny(403);
      const bytes=await readFile(target);
      if(name==='/face-preparation-data/playback.json') { const data=JSON.parse(bytes);verifyFingerprints(data.dependencies,assetRoot);await verifyFacePlaybackSources(data,assetRoot); }
      res.writeHead(200,{'Content-Type':types[path.extname(target)]??'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:bytes);
    } catch(error) { res.writeHead(error.code==='ENOENT'?404:409,{'Content-Type':'text/plain; charset=utf-8'});res.end('Asset unavailable: '+error.message); }
  });return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const flag = (key,fallback) => {const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
  const port=Number(flag('--port',18820));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  const server=createLibraryServer({assetRoot:path.resolve(flag('--asset-root',root))});
  server.on('error',e=>{console.error(e.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Local motion library: http://127.0.0.1:${port}/library-expansion/`));
}
