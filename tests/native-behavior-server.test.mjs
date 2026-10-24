import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNativeBehaviorServer} from '../realtime/native-behavior-lab/server.mjs';
const request=(port,{method='GET',host=`127.0.0.1:${port}`,route='/native-behavior-data/queue.json'}={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:host}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end();});
test('private preparation queue has only exact GET/HEAD loopback alias',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'native-behavior-')),file=path.join(tmp,'queue.json');await fs.writeFile(file,'{"groups":[]}');
  const server=createNativeBehaviorServer({queueFile:file});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  try{assert.equal((await request(port)).body,'{"groups":[]}');assert.equal((await request(port,{method:'HEAD'})).body,'');assert.equal((await request(port,{method:'POST'})).status,405);assert.equal((await request(port,{host:'attacker.invalid'})).status,403);assert.equal((await request(port,{route:'/native-behavior-data/other.json'})).status,404);assert.equal((await request(port,{route:'/native-behavior-data/%2e%2e/private.json'})).status,404);}finally{await new Promise(r=>server.close(r));await fs.rm(tmp,{recursive:true,force:true});}
});
