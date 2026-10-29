import test from 'node:test';
import assert from 'node:assert/strict';
import {CharacterClient} from '../realtime/character-center/client.mjs';
import {CharacterCenter} from '../realtime/character-center/center.mjs';
import {CharacterBodyDirector} from '../realtime/character-center/body-director.mjs';

const loud=()=>new Int16Array(1600).fill(2000);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({settled=true,status='ended'}={}){
  let time=100;
  const sent=[],events=[],starts=[],stops=[];
  const executor={live:null,canYield(){return !this.live;},start(_,row){this.live=row;starts.push(row.id);return true;},
    status:()=>({started:true,done:false}),cancel(row){this.live=null;stops.push(row.id);}};
  const body=new CharacterBodyDirector({executors:{conversation:executor,face:executor},
    getActorState:()=>({support:'standing',hands:'free',contacts:{L:true,R:true},props:{}})});
  const center=new CharacterCenter({body,face:{cancel(){},snapshot:()=>({})},clock:()=>time/1000});
  body.isOwnerCurrent=owner=>center.current(owner);
  center.setConnection('connection');center.beginTurn({turnId:'turn-1'});
  const owner={connectionId:'connection',responseId:'response-1',epoch:1};
  const audio={status,time:status==='ended'?2:.5,epoch:1,sourceCount:status==='playing'?2:0,
    sourceActive:status==='playing',queuedSeconds:status==='playing'?1.5:0};
  const session={owner,audio:{snapshot:()=>({...audio})},motion:{snapshot:()=>({gestures:[]})},
    sync:()=>({...audio}),pause(){if(audio.status==='ended')return false;audio.status='paused';audio.sourceCount=0;audio.sourceActive=false;return true;},
    async resume(){audio.status='playing';audio.sourceCount=2;audio.sourceActive=true;return true;},
    cancel(){audio.status='cancelled';audio.sourceCount=0;audio.sourceActive=false;this.owner=null;}};
  const client=new CharacterClient({session,director:center,clock:()=>time,onEvent:event=>events.push(event)});
  Object.assign(client,{ready:true,connectionId:'connection',variant:'qwen-direct',socket:{readyState:1,send:value=>sent.push(JSON.parse(value))}});
  const turn={id:'turn-1',owner,frames:48000,variant:'qwen-direct',revoked:false,
    segments:[{index:0,connectionId:'provider-1',responseId:'response-1',startFrame:0,frames:48000}],
    pendingTools:[],historySettled:settled,...(settled?{settledAt:50}:{}),driver:{cancel:()=>center.cancel({turnId:'turn-1'})}};
  client.current=turn;client.trials=[turn];
  let revision=0;
  const offer=(actions=['gesture:comfort'])=>center.message({type:'character_actions',connectionId:'connection',
    sourceScope:'assistant',sourceKey:'assistant:turn-1:0',sourceVersion:String(++revision),semanticRevision:revision,
    requestId:'decision-'+revision,commandId:'command-'+revision,turnId:'turn-1',
    command:{operation:'replace',actions:actions.map(action=>({action,anchor:'immediate'}))}});
  return {client,center,body,session,audio,turn,sent,events,starts,stops,offer,setTime:n=>{time=n;}};
}

test('settled voice history does not prevent immediate body-only pause and queued-step hold',()=>{
  const f=fixture();f.offer(['gesture:comfort','gesture:listen']);f.body.update(0,0);f.body.update(.1,.1);
  const current=f.body.active;assert.equal(current.status,'playing');
  assert.equal(f.client.sendAudio(loud()),true);
  assert.equal(f.center.paused,true);assert.equal(f.body.paused,true);
  f.body.update(2,1.9);assert.equal(f.body.active,current);assert.equal(f.starts.length,1);
  assert.equal(f.events.find(e=>e.type==='body_provisional_pause').audioPauseAccepted,false);
  assert.equal(f.turn.historySettled,true);assert.equal(f.turn.settledAt,50);assert.equal(f.turn.revoked,false);
});

test('input hold also blocks late old model actions when no body existed at onset',()=>{
  const f=fixture();f.client.sendAudio(loud());assert.equal(f.body.paused,true);
  f.offer();f.body.update(.1,.1);assert.equal(f.starts.length,0);assert.equal(f.body.pending.length,1);
  f.client.message({type:'speech_stopped',connectionId:'connection',itemId:'input',valid:true});
  assert.equal(f.body.pending.length,0);assert.equal(f.offer(),false,'late old commands remain retired');
  assert.equal(f.turn.historySettled,true);assert.equal(f.turn.revoked,false);
});

test('confirmed body-only interruption retires active and pending without changing delivered history',()=>{
  const f=fixture();f.offer(['gesture:comfort','gesture:listen']);f.body.update(0,0);f.body.update(.1,.1);
  f.client.sendAudio(loud());f.client.message({type:'speech_started',connectionId:'connection',itemId:'input'});
  f.client.message({type:'speech_stopped',connectionId:'connection',itemId:'input',valid:true});
  assert.equal(f.body.active,null);assert.equal(f.body.pending.length,0);assert.equal(f.stops.length,1);
  assert.equal(f.body.paused,false);assert.equal(f.center.paused,false);
  assert.equal(f.turn.settledAt,50);assert.equal(f.turn.historySettled,true);assert.equal(f.turn.revoked,false);
  assert.equal(f.sent.some(s=>s.type==='playback_complete'),false);
});

test('unconfirmed short noise resumes held body after 1800ms and retains its action',async()=>{
  const f=fixture();f.offer();f.body.update(0,0);const current=f.body.active;f.client.sendAudio(loud());
  f.setTime(1800);f.client.sync();await flush();assert.equal(f.body.paused,true);
  f.setTime(1901);f.client.sync();await flush();assert.equal(f.body.paused,false);assert.equal(f.body.active,current);
  assert.equal(f.events.filter(e=>e.type==='body_pause_resumed').length,1);
});

test('server-confirmed speech cannot resume merely because the local noise timer elapsed',async()=>{
  const f=fixture();f.offer();f.client.sendAudio(loud());
  f.client.message({type:'speech_started',connectionId:'connection',itemId:'input'});
  f.setTime(3000);f.client.sync();await flush();assert.equal(f.body.paused,true);
  f.client.message({type:'speech_stopped',connectionId:'connection',itemId:'input',valid:false});
  await flush();assert.equal(f.body.paused,false);assert.equal(f.body.pending.length,1);
});

test('old connection validity result cannot release the current body hold',async()=>{
  const f=fixture();f.client.sendAudio(loud());
  f.client.message({type:'speech_stopped',connectionId:'old-connection',itemId:'input',valid:false});
  await flush();assert.equal(f.body.paused,true);
});

test('new local speech during asynchronous resume reinstates pause before another packet is needed',async()=>{
  const f=fixture({settled:false,status:'playing'});f.offer();f.body.update(0,0);f.client.sendAudio(loud());
  let release;f.session.resume=()=>new Promise(resolve=>{release=()=>{f.audio.status='playing';f.audio.sourceCount=2;f.audio.sourceActive=true;resolve(true);};});
  const restoring=f.client.resumeInvalid();f.setTime(200);f.client.sendAudio(loud());release();await restoring;
  assert.equal(f.body.paused,true);assert.equal(f.audio.status,'paused');assert.equal(f.audio.sourceCount,0);
  assert.ok(f.client.bodyHold);assert.equal(f.events.filter(e=>e.type==='body_pause_resumed').length,0);
});

test('invalid stopped input cannot leave a newer local noise hold permanently confirmed',async()=>{
  const f=fixture({settled:false,status:'playing'});f.offer();f.body.update(0,0);f.client.sendAudio(loud());
  f.client.message({type:'speech_started',connectionId:'connection',itemId:'input-old'});
  const resume=f.session.resume;let release;
  f.session.resume=()=>new Promise(resolve=>{release=()=>{f.audio.status='playing';f.audio.sourceActive=true;resolve(true);};});
  f.client.message({type:'speech_stopped',connectionId:'connection',itemId:'input-old',valid:false});
  assert.equal(f.client.bodyHold.serverSpeechPending,undefined);
  f.setTime(200);f.client.sendAudio(loud());release();await flush();
  assert.equal(f.body.paused,true);assert.equal(f.audio.status,'paused');
  f.session.resume=resume;f.setTime(2001);f.client.sync();await flush();
  assert.equal(f.client.bodyHold,null);assert.equal(f.body.paused,false);assert.equal(f.audio.status,'playing');
});

test('invalid result for a different server input cannot release a confirmed hold',async()=>{
  const f=fixture();f.client.sendAudio(loud());
  f.client.message({type:'speech_started',connectionId:'connection',itemId:'input-current'});
  f.client.message({type:'speech_stopped',connectionId:'connection',itemId:'input-old',valid:false});
  await flush();assert.equal(f.body.paused,true);assert.equal(f.client.bodyHold.serverSpeechPending,'input-current');
  f.client.message({type:'speech_stopped',connectionId:'connection',itemId:'input-current',valid:false});
  await flush();assert.equal(f.body.paused,false);
});

test('manual pause survives automatic noise recovery',async()=>{
  const f=fixture();f.offer();f.client.setManualPause(true);f.client.sendAudio(loud());
  f.setTime(2100);f.client.sync();await flush();
  assert.equal(f.client.bodyHold,null);assert.equal(f.body.paused,true);assert.equal(f.center.paused,true);
  f.client.setManualPause(false);assert.equal(f.body.paused,false);
});

test('disconnect cancels settled body and pending work, then late old actions cannot resurrect',()=>{
  const f=fixture();f.offer(['gesture:comfort','gesture:listen']);f.body.update(0,0);f.client.sendAudio(loud());
  f.client.close();assert.equal(f.body.active,null);assert.equal(f.body.pending.length,0);
  assert.equal(f.body.paused,false);assert.equal(f.client.ready,false);assert.equal(f.offer(),false);
  assert.equal(f.turn.historySettled,true);
});

test('new turn synchronizes body pause and accepts only its new action ownership',()=>{
  const f=fixture();f.offer();f.body.update(0,0);f.client.sendAudio(loud());
  f.client.message({type:'turn_started',connectionId:'connection',turnId:'turn-2',itemId:'input',text:'next',variant:'qwen-direct'});
  assert.equal(f.body.paused,false);assert.equal(f.center.paused,false);assert.equal(f.body.active,null);
  assert.equal(f.center.turnId,'turn-2');assert.equal(f.offer(),false);assert.equal(f.turn.historySettled,true);
});

test('playback evidence reports real owner and ended status without inventing a history ACK',()=>{
  const f=fixture();assert.equal(f.client.reportPlaybackState(),true);
  const msg=f.sent.at(-1);assert.equal(msg.type,'character_playback_state');assert.equal(msg.status,'ended');
  assert.equal(msg.playedFrame,48000);assert.equal(msg.responseId,'response-1');assert.equal(msg.providerConnectionId,'provider-1');
  assert.equal(msg.sequence,1);assert.equal(msg.sourceActive,false);assert.equal(f.client.reportPlaybackState(),false);
  assert.equal(f.turn.historySettled,true);
});

test('playback status changes send immediately and periodic receipts do not flood unchanged playback',()=>{
  const f=fixture({settled:false,status:'playing'});f.client.reportPlaybackState();
  f.setTime(200);f.audio.time=.6;assert.equal(f.client.reportPlaybackState(),false);
  f.setTime(351);assert.equal(f.client.reportPlaybackState(),true);assert.equal(f.sent.at(-1).sequence,2);
  f.audio.status='paused';f.audio.sourceActive=false;assert.equal(f.client.reportPlaybackState(),true);
  assert.equal(f.sent.at(-1).status,'paused');assert.equal(f.sent.at(-1).sequence,3);
  f.session.owner={...f.turn.owner,epoch:2};assert.equal(f.client.reportPlaybackState(),false);
});

test('playback evidence selects the actually playing segment rather than a later generated segment',()=>{
  const f=fixture({settled:false,status:'playing'});f.turn.frames=72000;
  f.turn.segments.push({index:1,connectionId:'provider-2',responseId:'response-2',startFrame:48000,frames:24000});
  f.client.reportPlaybackState();assert.equal(f.sent.at(-1).segmentIndex,0);
  f.audio.time=2.25;f.client.reportPlaybackState();assert.equal(f.sent.at(-1).segmentIndex,1);
  assert.equal(f.sent.at(-1).playedFrame,54000);
});
