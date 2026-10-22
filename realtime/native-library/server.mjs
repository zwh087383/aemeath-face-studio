import {createNativeMotionServer} from '../native-motion/server.mjs';
import {readFile,realpath,stat} from 'node:fs/promises';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const compress=promisify(gzip),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const idPattern=/^[a-z][a-z0-9-]{0,79}$/;
const within=(base,target)=>{const rel=path.relative(base,target);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
const sourceFile='source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb';

/** Explicit reviewed clip aliases only. Game files, index and keys remain private. */
export function createNativeLibraryServer({dataRoot=path.join(root,'outputs/native-common-motions-20261022'),sourceDataRoot=path.join(root,'outputs/native-motion-20261022')}={}) {
  const server=createNativeMotionServer({dataRoot:sourceDataRoot}),previous=server.listeners('request')[0];server.removeAllListeners('request');
  const compressed=new Map();
  async function resolveInside(base,name){const physicalBase=await realpath(base),target=await realpath(path.join(physicalBase,name));if(!within(physicalBase,target))throw Error('Path denied');return target;}
  async function manifest(){
    const target=await resolveInside(dataRoot,'manifest.json'),data=JSON.parse(await readFile(target,'utf8'));
    if(data.schema!==1||!Array.isArray(data.clips))throw Error('Invalid manifest');
    return {...data,clips:data.clips.filter(c=>c.status==='ready'&&typeof c.id==='string'&&idPattern.test(c.id))};
  }
  server.on('request',async(req,res)=>{
    let name;try{name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{return previous(req,res);}
    if(!name.startsWith('/native-library-data/'))return previous(req,res);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const fail=(code)=>{res.writeHead(code);res.end();},port=server.address()?.port;
    if(!['GET','HEAD'].includes(req.method))return fail(405);
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return fail(403);
    try{
      let bytes,type='application/json; charset=utf-8',cacheKey;
      if(name==='/native-library-data/manifest.json')bytes=Buffer.from(JSON.stringify(await manifest()));
      else if(name==='/native-library-data/source.glb'){
        const file=await resolveInside(sourceDataRoot,sourceFile);bytes=await readFile(file);type='model/gltf-binary';
      }else{
        const match=/^\/native-library-data\/clips\/([a-z][a-z0-9-]{0,79})\.json$/.exec(name);
        if(!match)return fail(404);
        if(!(await manifest()).clips.some(c=>c.id===match[1]))return fail(404);
        const file=await resolveInside(path.join(dataRoot,'clips'),match[1]+'.json'),info=await stat(file);
        cacheKey=file+':'+info.mtimeMs;bytes=await readFile(file);
      }
      if(bytes.length>100000&&type.startsWith('application/json')&&/\bgzip\b/.test(req.headers['accept-encoding']??'')){
        let packed=compressed.get(cacheKey);
        if(!packed){packed=await compress(bytes);if(cacheKey){compressed.set(cacheKey,packed);while(compressed.size>4)compressed.delete(compressed.keys().next().value);}}
        bytes=packed;res.setHeader('Content-Encoding','gzip');res.setHeader('Vary','Accept-Encoding');
      }
      res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){fail(['ENOENT','ENOTDIR'].includes(error.code)?404:500);}
  });return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--port'),port=Number(index<0?18790:process.argv[index+1]);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  const server=createNativeLibraryServer();server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Experimental common native motion library: http://127.0.0.1:${port}/native-library/`));
}
