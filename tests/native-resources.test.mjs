import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createNativeResourcesServer} from '../realtime/native-resources/server.mjs';

const request=(port,url,headers={},method='GET')=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers:{host:`127.0.0.1:${port}`,...headers}},res=>{
    const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(parts)}));
  });req.on('error',reject);req.end();
});
async function fixture(run){
  const dir=await mkdtemp(path.join(os.tmpdir(),'aemeath-native-resources-'));
  for(const folder of ['clips','resources','models','raw'])await mkdir(path.join(dir,folder));
  const plain=Buffer.from(JSON.stringify({schema:1,frames:[1,2,3]}));
  await writeFile(path.join(dir,'clips/idle.json.gz'),gzipSync(plain));
  await writeFile(path.join(dir,'resources/face.json'),JSON.stringify({curves:[{name:'M_A',keys:[]}]}));
  await writeFile(path.join(dir,'resources/rejected.json'),'{}');
  await writeFile(path.join(dir,'models/plane.glb'),'glTF fixture');
  await writeFile(path.join(dir,'models/plane.json'),'material fixture');
  await writeFile(path.join(dir,'private.json'),'PRIVATE RAW');
  await writeFile(path.join(dir,'raw/secret.uasset'),'PRIVATE RAW');
  const manifest={schema:1,experimental:true,clips:[{id:'idle',status:'ready',file:'clips/idle.json.gz'},{id:'archived',status:'archived'},{id:'bad/name',status:'ready'}],resources:[
    {id:'face',status:'decoded',file:'resources/face.json'},
    {id:'rejected',status:'archived',file:'resources/rejected.json'},
    {id:'plane',status:'ready',file:'resources/face.json',modelFile:'models/plane.glb',convertedFiles:['models/plane.json']},
    {id:'escape',status:'ready',file:'../private.json',modelFile:'../private.json'},
  ]};
  await writeFile(path.join(dir,'manifest.partial.json'),JSON.stringify(manifest));
  const server=createNativeResourcesServer({dataRoot:dir,sourceDataRoot:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await run({port:server.address().port,dir,plain,manifest});}finally{
    await new Promise(r=>server.close(r));
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('aemeath-native-resources-'));await rm(dir,{recursive:true,force:true});
  }
}
test('partial/final manifests retain unsupported statuses and expose only valid IDs',async()=>fixture(async({port,dir,manifest})=>{
  let response=await request(port,'/native-resources-data/manifest.json');let m=JSON.parse(response.bytes);
  assert.equal(m.incomplete,true);assert.deepEqual(m.clips.map(r=>r.id),['idle','archived']);
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({...manifest,finished:true}));
  m=JSON.parse((await request(port,'/native-resources-data/manifest.json')).bytes);assert.equal(m.incomplete,false);assert.equal(m.finished,true);
  response=await request(port,'/native-resources-data/resources/rejected.json');assert.equal(response.status,200);
  assert.equal((await request(port,'/native-resources-data/clips/archived.json')).status,404);
}));
test('stored gzip clips honor Accept-Encoding without altering decoded content; model and converted aliases resolve',async()=>fixture(async({port,plain})=>{
  const packed=await request(port,'/native-resources-data/clips/idle.json',{'accept-encoding':'gzip'});
  assert.equal(packed.status,200);assert.equal(packed.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(packed.bytes),plain);
  const decoded=await request(port,'/native-resources-data/clips/idle.json');assert.equal(decoded.headers['content-encoding'],undefined);assert.deepEqual(decoded.bytes,plain);
  const declined=await request(port,'/native-resources-data/clips/idle.json',{'accept-encoding':'br, gzip;q=0'});assert.equal(declined.headers['content-encoding'],undefined);assert.deepEqual(declined.bytes,plain);
  const head=await request(port,'/native-resources-data/clips/idle.json',{},'HEAD');assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),plain.length);
  const model=await request(port,'/native-resources-data/models/plane.glb');assert.equal(model.status,200);assert.equal(model.headers['content-type'],'model/gltf-binary');
  assert.equal((await request(port,'/native-resources-data/converted/plane/0')).bytes.toString(),'material fixture');
}));
test('unlisted, raw, malformed and manifest traversal aliases stay private; writes and foreign hosts are rejected',async()=>fixture(async({port})=>{
  for(const url of ['/native-resources-data/raw/secret.uasset','/native-resources-data/private.json','/native-resources-data/clips/unlisted.json','/native-resources-data/resources/escape.json','/native-resources-data/models/escape.glb','/native-resources-data/converted/plane/2','/native-resources-data/resources/%2e%2e%5cprivate.json','/outputs/native-complete-20261022/manifest.json']){
    const result=await request(port,url);assert.equal(result.status,404,url);assert.ok(!result.bytes.includes('PRIVATE RAW'));
  }
  assert.equal((await request(port,'/native-resources-data/manifest.json',{},'POST')).status,405);
  assert.equal((await request(port,'/native-resources-data/manifest.json',{host:'untrusted.example'})).status,403);
}));
