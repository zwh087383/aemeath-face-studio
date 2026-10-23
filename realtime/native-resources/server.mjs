import {createAvatarServer} from '../avatar-server.mjs';
import {readFile, realpath, stat} from 'node:fs/promises';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const unpack=promisify(gunzip), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,100}$/.test(id);
const within=(base,target)=>{const relative=path.relative(base,target);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
const sourceFile='source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb';
const types={'.glb':'model/gltf-binary','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const acceptsGzip=value=>String(value??'').split(',').some(item=>{
  const [coding,...parameters]=item.trim().split(';');
  const quality=parameters.map(p=>/^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)).find(Boolean);
  return coding.toLowerCase()==='gzip'&&(!quality||Number(quality[1])>0);
});

/** Read-only aliases for reviewed exports. Raw packages, keys and resource index
 * have no HTTP route. Paths are checked after realpath, including symlinks. */
export function createNativeResourcesServer({dataRoot=path.join(root,'outputs/native-complete-20261022'),sourceDataRoot=path.join(root,'outputs/native-motion-20261022')}={}) {
  const server=createAvatarServer(), previous=server.listeners('request')[0];server.removeAllListeners('request');
  let cached=null,stamp='';
  async function resolveInside(base,name){
    if(typeof name!=='string'||name.includes('\0')||path.isAbsolute(name)||name.split(/[\\/]/).some(part=>part==='..'))throw Error('Path denied');
    const physical=await realpath(base),target=await realpath(path.join(physical,name));
    if(!within(physical,target))throw Error('Path denied');return target;
  }
  async function manifest(){
    let file,partial=false;
    try{file=await resolveInside(dataRoot,'manifest.json');}catch(error){if(error.code!=='ENOENT')throw error;file=await resolveInside(dataRoot,'manifest.partial.json');partial=true;}
    const info=await stat(file),key=file+':'+info.mtimeMs+':'+info.size;
    if(key!==stamp){
      const data=JSON.parse(await readFile(file,'utf8'));
      if(data.schema!==1||!Array.isArray(data.clips)||!Array.isArray(data.resources))throw Error('Invalid manifest');
      cached={...data,incomplete:partial,clips:data.clips.filter(c=>validId(c.id)),resources:data.resources.filter(c=>validId(c.id))};stamp=key;
    }
    return cached;
  }
  server.on('request',async(req,res)=>{
    let name;try{name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400);return res.end();}
    if(!name.startsWith('/native-resources-data/'))return previous(req,res);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const fail=code=>{res.writeHead(code);res.end();},port=server.address()?.port;
    if(!['GET','HEAD'].includes(req.method))return fail(405);
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return fail(403);
    if(name.includes('\\')||name.includes('\0')||name.split('/').some(p=>p.startsWith('.')))return fail(404);
    try{
      let bytes,file,type='application/json; charset=utf-8',gzip=false;
      if(name==='/native-resources-data/manifest.json')bytes=Buffer.from(JSON.stringify(await manifest()));
      else if(name==='/native-resources-data/source.glb'){file=await resolveInside(sourceDataRoot,sourceFile);type=types['.glb'];}
      else {
        const match=/^\/native-resources-data\/(clips|resources|models)\/([a-z][a-z0-9-]{0,100})\.(json|glb)$/.exec(name);
        const converted=/^\/native-resources-data\/converted\/([a-z][a-z0-9-]{0,100})\/(\d+)$/.exec(name);
        const data=await manifest();
        if(match){
          const [,group,id,extension]=match, row=[...data.clips,...data.resources].find(c=>c.id===id);
          if(!row)return fail(404);
          let relative;
          if(group==='clips'&&extension==='json'&&row.status==='ready'&&data.clips.includes(row)){relative=row.file;gzip=relative?.endsWith('.json.gz');}
          else if(group==='resources'&&extension==='json'&&data.resources.includes(row))relative=row.file;
          else if(group==='models'&&extension==='glb'&&data.resources.includes(row)){relative=row.modelFile;type=types['.glb'];}
          if(!relative)return fail(404);file=await resolveInside(dataRoot,relative);
        }else if(converted){
          const row=data.resources.find(r=>r.id===converted[1]),relative=row?.convertedFiles?.[Number(converted[2])];
          if(!relative)return fail(404);type=types[path.extname(relative).toLowerCase()];if(!type)return fail(404);
          file=await resolveInside(dataRoot,relative);
        }else return fail(404);
      }
      bytes??=await readFile(file);
      if(gzip){
        res.setHeader('Vary','Accept-Encoding');
        if(acceptsGzip(req.headers['accept-encoding']))res.setHeader('Content-Encoding','gzip');
        else bytes=await unpack(bytes);
      }
      res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){fail(['ENOENT','ENOTDIR'].includes(error.code)||error.message==='Path denied'?404:500);}
  });return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const at=process.argv.indexOf('--port'),port=Number(at<0?18792:process.argv[at+1]);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  const server=createNativeResourcesServer();server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Experimental complete native resources: http://127.0.0.1:${port}/native-resources/`));
}
