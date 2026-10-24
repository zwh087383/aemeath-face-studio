import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createIdleActivityServer} from '../realtime/idle-activity-demo/server.mjs';
test('independent routes require same-origin mutations and never accept arbitrary actions',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'idle-demo-http-'));let mutations=0,closed=false;
  const backend={call:async row=>{if(row.action!=='snapshot')mutations++;return{revision:1};},close:()=>closed=true};
  const server=await createIdleActivityServer({backend,outputRoot:temp});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/idle-activity-demo/')).status,200);
    const send=(headers,action='start')=>fetch(base+'/idle-activity-demo/command',{method:'POST',headers,body:JSON.stringify({action})});
    assert.equal((await send({'Content-Type':'application/json'})).status,403);
    assert.equal((await send({'Content-Type':'application/json',Origin:'https://other.invalid'})).status,403);
    assert.equal((await send({'Content-Type':'application/json',Origin:base},'read-private-file')).status,400);
    assert.equal((await send({'Content-Type':'application/json',Origin:base})).status,200);
    assert.equal(mutations,1);
    assert.equal((await fetch(base+'/idle-activity-demo/backend.py')).status,404);
  }finally{await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});}
  assert.equal(closed,true);
});
