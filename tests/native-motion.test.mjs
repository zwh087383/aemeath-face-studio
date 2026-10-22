import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeClip} from '../preview/core/native-motion.js';
import {createNativeMotionServer} from '../realtime/native-motion/server.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const transform=(p=[0,0,0],q=[0,0,0,1])=>({p,q,s:[1,1,1]});
const fixture=()=>({schema:1,additive:false,duration:2,frameCount:3,
  bones:[{name:'root',parent:-1,...transform()},{name:'child',parent:0,...transform([10,0,0])}],
  frames:[[transform(),transform([10,0,0])],[transform([0,0,10],[0,0,Math.SQRT1_2,Math.SQRT1_2]),transform([10,0,0])],[transform(),transform([10,0,0])]],
});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
test('native axes, hierarchy and noncommuting root rotation use the glTF convention',()=>{
  const c=new NativeClip(fixture()).sample(1);c.world[1].p.toArray().forEach((x,i)=>near(x,[0,10,10][i]));
  near(c.world[1].q.length(),1);
});
test('interpolation, endpoint and reverse seeking do not accumulate transforms',()=>{
  const c=new NativeClip(fixture()).sample(.5),before=c.world[1].p.toArray();
  near(before[0],Math.sqrt(50));near(before[1],5);near(before[2],Math.sqrt(50));
  c.sample(2);near(c.world[1].p.x,10);c.sample(.5);assert.deepEqual(c.world[1].p.toArray(),before);
  c.sample(-1);near(c.time,0);c.sample(20);near(c.time,2);assert.throws(()=>c.sample(NaN),/Invalid playback/);
});
test('reject additive, incomplete, cyclic and corrupt clips',()=>{
  let f=fixture();f.additive=true;assert.throws(()=>new NativeClip(f),/Unsupported/);
  f=fixture();f.bones[0].parent=1;assert.throws(()=>new NativeClip(f),/topologically/);
  f=fixture();f.frames[0].pop();assert.throws(()=>new NativeClip(f),/Incomplete/);
  f=fixture();f.frames[0][0].p[0]=NaN;assert.throws(()=>new NativeClip(f),/Nonfinite/);
});
test('single-clip server exposes exact aliases, rejects unknown files, writes and foreign hosts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'aemeath-native-'));
  await writeFile(path.join(dir,'native-clip.json'),JSON.stringify(fixture()));
  await writeFile(path.join(dir,'private.txt'),'not served');
  const server=createNativeMotionServer({dataRoot:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,base=`http://127.0.0.1:${port}`;
  try{
    assert.equal((await fetch(base+'/native-data/clip.json')).status,200);
    assert.equal((await fetch(base+'/native-data/private.txt')).status,404);
    assert.equal((await fetch(base+'/native-data/clip.json',{method:'POST'})).status,405);
    const foreign=await new Promise((resolve,reject)=>{http.get(base+'/native-data/clip.json',{headers:{host:'example.com'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
    assert.equal(foreign,403);
    assert.equal((await fetch(base+'/outputs/native-motion-20261022/native-clip.json')).status,404);
  }finally{
    await new Promise(r=>server.close(r));
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('aemeath-native-'));
    await rm(dir,{recursive:true,force:true});
  }
});
