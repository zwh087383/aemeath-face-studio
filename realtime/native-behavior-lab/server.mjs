import {createNativeResourcesServer} from '../native-resources/server.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function createNativeBehaviorServer({queueFile=path.join(root,'outputs/action-preparation-20261023/review-queue.json')}={}) {
  const server=createNativeResourcesServer(),previous=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',async(req,res)=>{
    let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400);return res.end();}
    if(!pathname.startsWith('/native-behavior-data/'))return previous(req,res);
    const fail=code=>{res.writeHead(code);res.end();};
    if(!['GET','HEAD'].includes(req.method))return fail(405);
    if(![`127.0.0.1:${server.address()?.port}`,`localhost:${server.address()?.port}`].includes(req.headers.host))return fail(403);
    if(pathname!=='/native-behavior-data/queue.json')return fail(404);
    try{const bytes=await readFile(queueFile);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);}catch{fail(500);}
  });return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const at=process.argv.indexOf('--port'),port=Number(at<0?18795:process.argv[at+1]);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  const server=createNativeBehaviorServer();server.on('error',e=>{console.error(e.message);process.exitCode=1;});server.listen(port,'127.0.0.1',()=>console.log(`Experimental native behavior lab: http://127.0.0.1:${port}/native-behavior-lab/`));
}
