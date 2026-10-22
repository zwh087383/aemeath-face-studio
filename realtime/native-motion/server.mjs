import {createAvatarServer} from '../avatar-server.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function createNativeMotionServer({dataRoot=path.join(root,'outputs/native-motion-20261022')}={}) {
  const server=createAvatarServer();const previous=server.listeners('request')[0];server.removeAllListeners('request');
  const files=new Map([
    ['/native-data/clip.json',['native-clip.json','application/json']],
    ['/native-data/source.glb',['source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb','model/gltf-binary']],
  ]);
  server.on('request',async(req,res)=>{
    let name;try{name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{return previous(req,res);}
    if(!name.startsWith('/native-data/'))return previous(req,res);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const port=server.address()?.port;
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){res.writeHead(403);return res.end();}
    const row=files.get(name);if(!row){res.writeHead(404);return res.end();}
    try{const bytes=await readFile(path.join(dataRoot,row[0]));res.writeHead(200,{'Content-Type':row[1],'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);}
    catch{res.writeHead(404);res.end('Local single-clip assets unavailable; see setup instructions.');}
  });return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const index=process.argv.indexOf('--port'),port=Number(index<0?18789:process.argv[index+1]);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  createNativeMotionServer().listen(port,'127.0.0.1',()=>console.log(`Native single-clip experiment: http://127.0.0.1:${port}/native-motion/`));
}
