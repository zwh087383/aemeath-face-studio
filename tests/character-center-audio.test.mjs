import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingAudioTransport} from '../realtime/stream-audio.mjs';
import {CHARACTER_AUDIO_OPTIONS} from '../realtime/character-center/audio-options.mjs';

function context(){return {currentTime:0,state:'suspended',destination:{},resume:async function(){this.state='running';},
  createBuffer:(_,length,sampleRate)=>({length,sampleRate,duration:length/sampleRate,getChannelData:()=>new Float32Array(length)}),
  createGain:()=>({gain:{value:1,cancelScheduledValues(){},setValueAtTime(){}},connect(){},disconnect(){}}),
  createBufferSource:()=>({connect(){},start(){},stop(){},disconnect(){}})};}

test('the actual old 20-second queue rejects a 22.8-second fast burst, the bounded character queue accepts it',()=>{
  const old=new StreamingAudioTransport(context()),fixed=new StreamingAudioTransport(context(),CHARACTER_AUDIO_OPTIONS);
  old.begin(1,{sampleRate:24000});fixed.begin(1,{sampleRate:24000});
  const samples=new Float32Array(24000*.4);
  let oldFailure=null;
  for(let sequence=0;sequence<57;sequence++){
    if(oldFailure===null&&!old.append({epoch:1,sequence,samples}))oldFailure=old.lastError;
    assert.equal(fixed.append({epoch:1,sequence,samples}),true);
  }
  assert.equal(oldFailure,'buffer_limit');assert.equal(fixed.receivedDuration,22.8);
  assert.equal(fixed.leadSeconds,.04);
});

test('the server-sized 35-second burst remains cancellable and the new queue remains finite',()=>{
  const player=new StreamingAudioTransport(context(),CHARACTER_AUDIO_OPTIONS);player.begin(1,{sampleRate:24000});
  assert.equal(player.append({epoch:1,sequence:0,samples:new Float32Array(35*24000)}),true);
  assert.equal(player.append({epoch:1,sequence:1,samples:new Float32Array(6*24000)}),false);
  assert.equal(player.lastError,'buffer_limit');player.cancel(1);
  const after=player.snapshot();assert.equal(after.queuedSeconds,0);assert.equal(after.sourceCount,0);
  assert.equal(player.append({epoch:1,sequence:1,samples:new Float32Array(100)}),false);
});
