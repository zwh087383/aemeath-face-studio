import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import {createNativeLibraryServer} from '../realtime/native-library/server.mjs';

const request=(port,pathname,{method='GET',host=`127.0.0.1:${port}`}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers:{host}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));
    res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
  });req.on('error',reject);req.end();
});

async function fixture(run) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'aemeath-native-library-'));
  const dataRoot=path.join(directory,'library'),sourceDataRoot=path.join(directory,'source');
  await mkdir(path.join(dataRoot,'clips'),{recursive:true});
  await mkdir(sourceDataRoot,{recursive:true});
  const sourceMesh=path.join(sourceDataRoot,'source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb');
  await mkdir(path.dirname(sourceMesh),{recursive:true});
  await writeFile(sourceMesh,Buffer.from('glTF local fixture'));
  const row=(id,status='ready')=>({id,name:id,category:'待机',sourceAsset:`example/${id}.uasset`,duration:2,frameCount:3,boneCount:1,loop:true,status});
  const manifest={schema:1,experimental:true,clips:[row('stand-idle'),row('not-ready','rejected'),row('bad/name')]};
  const clip={schema:1,name:'stand-idle',duration:2,frameCount:3,bones:[],frames:[]};
  await writeFile(path.join(dataRoot,'manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(dataRoot,'clips','stand-idle.json'),JSON.stringify(clip));
  await writeFile(path.join(dataRoot,'clips','not-ready.json'),'private rejected clip');
  await writeFile(path.join(dataRoot,'clips','unlisted.json'),'private unlisted clip');
  await writeFile(path.join(dataRoot,'private.json'),'private operational data');
  await mkdir(path.join(dataRoot,'clips','bad'),{recursive:true});
  await writeFile(path.join(dataRoot,'clips','bad','name.json'),'invalid nested id');
  const server=createNativeLibraryServer({dataRoot,sourceDataRoot});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{await run({port:server.address().port,manifest,clip,dataRoot,sourceDataRoot});}
  finally{
    await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('aemeath-native-library-'));
    await rm(directory,{recursive:true,force:true});
  }
}

test('library serves its manifest and only a listed ready clip through exact aliases',async()=>{
  await fixture(async({port,clip})=>{
    const manifest=await request(port,'/native-library-data/manifest.json');
    assert.equal(manifest.status,200);assert.match(manifest.headers['content-type'],/application\/json/);
    const published=JSON.parse(manifest.body);assert.equal(published.schema,1);assert.equal(published.experimental,true);
    assert.deepEqual(published.clips.map(row=>row.id),['stand-idle'],'Manifest must exclude rejected and invalid aliases');
    const response=await request(port,'/native-library-data/clips/stand-idle.json');
    assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),clip);
    assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.match(response.headers['cache-control'],/no-store/);
    const head=await request(port,'/native-library-data/clips/stand-idle.json',{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(head.body.length,0);
    assert.equal(Number(head.headers['content-length']),response.body.length);
    const localhost=await request(port,'/native-library-data/clips/stand-idle.json',{host:`localhost:${port}`});
    assert.equal(localhost.status,200);
    const source=await request(port,'/native-library-data/source.glb');
    assert.equal(source.status,200);assert.equal(source.headers['content-type'],'model/gltf-binary');
    assert.equal(source.body.toString(),'glTF local fixture');
  });
});

test('large clip JSON is compressed only when requested and retains its decoded content',async()=>{
  await fixture(async({port,dataRoot,clip})=>{
    const large=Buffer.from(JSON.stringify({...clip,padding:'x'.repeat(160000)}));
    await writeFile(path.join(dataRoot,'clips','stand-idle.json'),large);
    const compressed=await new Promise((resolve,reject)=>{
      http.get({hostname:'127.0.0.1',port,path:'/native-library-data/clips/stand-idle.json',headers:{host:`127.0.0.1:${port}`,'accept-encoding':'gzip'}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      }).on('error',reject);
    });
    assert.equal(compressed.status,200);assert.equal(compressed.headers['content-encoding'],'gzip');
    assert.match(compressed.headers.vary,/Accept-Encoding/);assert.ok(compressed.body.length<large.length/4);
    assert.deepEqual(gunzipSync(compressed.body),large);
    const plain=await request(port,'/native-library-data/clips/stand-idle.json');
    assert.equal(plain.headers['content-encoding'],undefined);assert.deepEqual(plain.body,large);
  });
});

test('library rejects unlisted, non-ready, nested and encoded traversal paths',async()=>{
  await fixture(async({port})=>{
    const rejected=[
      '/native-library-data/clips/unlisted.json',
      '/native-library-data/clips/not-ready.json',
      '/native-library-data/clips/missing.json',
      '/native-library-data/private.json',
      '/native-library-data/clips/bad/name.json',
      '/native-library-data/clips/bad%2fname.json',
      '/native-library-data/clips/..%2fprivate.json',
      '/native-library-data/clips/%2e%2e%2fprivate.json',
      '/native-library-data/clips/%2e%2e%5cprivate.json',
      '/native-library-data/clips/%252e%252e%252fprivate.json',
      '/native-library-data/clips/stand-idle.json/extra',
      '/outputs/native-common-motions-20261022/manifest.json',
    ];
    for(const pathname of rejected){
      const response=await request(port,pathname);assert.equal(response.status,404,pathname);
      assert.ok(!response.body.toString().includes('private operational data'),pathname);
    }
  });
});

test('library rejects writes and external Host headers without returning private data',async()=>{
  await fixture(async({port})=>{
    for(const method of ['POST','PUT','DELETE','PATCH']){
      assert.equal((await request(port,'/native-library-data/manifest.json',{method})).status,405,method);
    }
    for(const host of ['example.com',`example.com:${port}`,`127.0.0.1:${port}.example.com`,`localhost:${port + 1}`]){
      const response=await request(port,'/native-library-data/clips/stand-idle.json',{host});
      assert.equal(response.status,403,host);assert.ok(!response.body.toString().includes('stand-idle'));
    }
  });
});
