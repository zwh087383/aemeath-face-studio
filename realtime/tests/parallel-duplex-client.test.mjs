import test from 'node:test';
import assert from 'node:assert/strict';
import {ParallelDuplexClient,framePreflightVerdict,attemptedFixtureIds,replayTurnEvents} from '../parallel-duplex/client.mjs';

test('foreground preflight rejects throttled, hidden, timed-out or undersampled rendering',()=>{
  assert.equal(framePreflightVerdict(Array(80).fill(10)).valid,true);
  assert.equal(framePreflightVerdict(Array(8).fill(1000)).valid,false);
  assert.equal(framePreflightVerdict([10,10]).valid,false);
  assert.equal(framePreflightVerdict(Array(80).fill(10),{hidden:true}).valid,false);
  assert.equal(framePreflightVerdict(Array(80).fill(10),{timedOut:true}).valid,false);
});
test('fixture retry protection includes partially transmitted recordings',()=>{
  assert.deepEqual([...attemptedFixtureIds([{id:'partial',sentPackets:1},{id:'unsent',sentPackets:0},{id:'done',sentPackets:12}])],['partial','done']);
});
test('replay retains real revocation and input pause, but cannot acknowledge real history',()=>{
  const events=[{type:'turn_started',turnId:'a',serverMs:1},{type:'speech_started',serverMs:2},
    {type:'revoked',turnId:'a',serverMs:3},{type:'delivery',turnId:'a',serverMs:4},
    {type:'settled',turnId:'a',serverMs:5},{type:'speech_started',serverMs:6}];
  assert.deepEqual(replayTurnEvents({events},{id:'a'}).map(e=>e.type),['turn_started','speech_started','revoked']);
});

test('individually revoked audio and subtitles cannot contaminate marker or director',()=>{
  const f=fixture(),s=f.segment();
  f.event('audio',{...s.fields,revoked:true,pcm:Buffer.from([0,16,0,16]).toString('base64')});
  f.event('subtitle',{...s.fields,revoked:true,delta:'我同意。'});
  assert.equal(f.markers.length,0);assert.equal(f.appended.length,0);
  assert.equal(f.directorEvents.filter(e=>e.method==='subtitle').length,0);
});
test('already settled turn is not falsely reported as a new director cancellation',()=>{
  const f=fixture();f.segment();f.client.current.settledAt=1200;
  f.client.cancel('new_user_turn',false);
  assert.equal(f.directorEvents.filter(e=>e.method==='cancel').length,0);
});

function fixture({visualFailure=false}={}){
  let now=1000;const sent=[],directorEvents=[],cues=[],appended=[],markers=[];
  const audio={status:'buffering',time:0,receivedDuration:0,queuedSeconds:0,sourceCount:0,sourceActive:false,sampleRate:24000,finished:false,epoch:1};
  const session={owner:null,motion:{snapshot:()=>({gestures:[]})},audio:{snapshot:()=>({...audio}),setPlaybackMarker:time=>{markers.push(time);return true;}},
    setConnection:()=>true,beginResponse:o=>(session.owner={...o,epoch:1}),appendPcm:({samples})=>{appended.push(samples);audio.receivedDuration+=samples.length/24000;audio.sourceCount++;return true;},
    finishAudio:()=>{audio.finished=true;return true;},providerDone:()=>true,enqueue:cue=>{cues.push(cue);return {accepted:true};},
    pause:()=>{audio.status='paused';audio.sourceCount=0;return true;},resume:async()=>{audio.status='playing';return true;},
    cancel:()=>{audio.status='cancelled';audio.sourceCount=0;audio.queuedSeconds=0;return true;},sync:()=>({...audio})};
  const director=Object.fromEntries(['setConnection','beginTurn','updateContext','bindOwner','offerPlan','subtitle','cancel'].map(method=>[method,(...args)=>{
    directorEvents.push({method,args:structuredClone(args)});if(visualFailure&&method==='offerPlan')throw Error('visual_only');return {accepted:true};
  }]));
  director.snapshot=()=>({mode:'test',decisions:[]});
  const client=new ParallelDuplexClient({session,director,clock:()=>now});client.socket={readyState:1,send:s=>sent.push(JSON.parse(s))};
  const event=(type,fields={})=>client.message({type,connectionId:'browser',turnId:'turn',...fields});
  event('ready',{variant:'qwen-direct',actionMode:'parallel',budget:{blocked:false,unknown:0},listenerConfiguration:{}});
  event('turn_started',{text:'请比较两种方案'});
  const segments=[];
  function segment(index=0){
    const startFrame=segments.reduce((sum,s)=>sum+s.frames,0),phase=index?'full':'direct';
    const record={index,connectionId:'provider'+index,responseId:'response'+index,frames:0,startFrame,phase,audioDone:true,transcriptDone:true,status:'completed'};
    const fields={segmentIndex:index,phase,startFrame,providerConnectionId:record.connectionId,responseId:record.responseId};
    event('request_sent',fields);event('response_created',fields);segments.push(record);let transcript='';
    return {record,fields,audio(samples){record.frames+=samples.length;const bytes=Buffer.alloc(samples.length*2);samples.forEach((x,i)=>bytes.writeInt16LE(x,i*2));event('audio',{...fields,pcm:bytes.toString('base64')});},
      subtitle(text){transcript+=text;event('subtitle',{...fields,delta:text});},
      done(){event('audio_done',fields);event('response_done',{...fields,result:{...record,transcript}});},
      handoff(){event('handoff_requested',{...fields,callId:'handoff',reason:'long_answer'});}};
  }
  const plan=fields=>event('action_plan',{planId:'plan1',plannerConnectionId:'planner',plannerResponseId:'planner-response',sourceRole:'planner',outputFinal:true,
    arguments:'{"intent":"explain"}',intent:'explain',expiresInMs:3500,...fields});
  function finish(text){
    const last=segments.at(-1),frames=segments.reduce((sum,s)=>sum+s.frames,0);
    const result={connectionId:last.connectionId,responseId:last.responseId,frames,transcript:text,status:'completed',audioDone:true,transcriptDone:true,segments:structuredClone(segments)};
    event('turn_output_done',{providerConnectionId:last.connectionId,responseId:last.responseId,result});
    event('delivery',{deliveryId:'delivery',responseId:last.responseId,providerConnectionId:last.connectionId,expectedFrames:frames,segments:structuredClone(segments)});
    return result;
  }
  return {client,session,director,directorEvents,audio,sent,cues,appended,markers,event,segment,plan,finish,advance:ms=>now+=ms};
}

test('planner can arrive before voice owner but never enters the legacy voice tool path',()=>{
  const f=fixture();f.plan();assert.equal(f.client.current.owner,null);
  assert.equal(f.directorEvents.filter(e=>e.method==='offerPlan').length,1);assert.equal(f.cues.length,0);
  f.segment();assert.equal(f.directorEvents.filter(e=>e.method==='bindOwner').length,1);
  assert.equal(f.client.current.actionPlans[0].event.plannerResponseId,'planner-response');
});
test('first voiced marker is exact across leading silent chunks and never delays PCM append',()=>{
  const f=fixture(),s=f.segment();s.audio(new Int16Array(120));const second=new Int16Array(120);second[17]=300;s.audio(second);
  assert.equal(f.appended.length,2);assert.equal(f.client.current.frames,240);assert.deepEqual(f.markers,[(120+17)/24000]);
  s.audio(new Int16Array(120).fill(2000));assert.equal(f.markers.length,1);
});
test('stale or incomplete planner identity is refused without changing current voice ownership',()=>{
  const f=fixture();f.segment();f.plan({connectionId:'old'});f.plan({sourceRole:'voice'});f.plan({outputFinal:false});f.plan({plannerResponseId:'bad id'});
  assert.equal(f.directorEvents.filter(e=>e.method==='offerPlan').length,0);
  assert.equal(f.client.current.owner.responseId,'response0');assert.equal(f.client.blocked,false);
});
test('legacy avatar tool cannot bypass director, while the speech stream still works',()=>{
  const f=fixture(),s=f.segment();f.event('tool',{...s.fields,name:'perform_avatar',callId:'bad-route',arguments:'{"expression":"happy","gesture":"wave"}'});
  s.audio(new Int16Array(120).fill(300));assert.equal(f.cues.length,0);assert.equal(f.client.current.rejectedVoiceTools.length,1);assert.equal(f.appended.length,1);
});
test('handoff subtitles are authenticated as physical segments before trusted playback owner mapping',()=>{
  const f=fixture(),a=f.segment();a.audio(new Int16Array(120));a.subtitle('先看速度。');a.done();a.handoff();
  const b=f.segment(1);b.audio(new Int16Array(120));b.subtitle('还需要看质量。');
  const last=f.directorEvents.filter(e=>e.method==='subtitle').at(-1).args[0];
  assert.equal(last.responseId,'response0');assert.equal(last.providerResponseId,'response1');assert.equal(last.segmentIndex,1);
  assert.throws(()=>f.event('subtitle',{...b.fields,responseId:'foreign',delta:'不可信'}),/segment_owner_conflict/);
});
test('valid barge-in revokes both preparation and audio; later planner cannot revive the turn',()=>{
  const f=fixture(),s=f.segment();s.audio(new Int16Array(120).fill(300));f.plan();f.audio.status='playing';
  f.event('speech_started',{itemId:'input'});assert.equal(f.audio.status,'paused');
  f.event('speech_stopped',{itemId:'input',valid:true});assert.equal(f.client.current.revoked,true);assert.equal(f.audio.status,'cancelled');
  const prior=f.directorEvents.filter(e=>e.method==='offerPlan').length;f.plan({planId:'late'});assert.equal(f.directorEvents.filter(e=>e.method==='offerPlan').length,prior);
  assert.ok(f.directorEvents.some(e=>e.method==='cancel'));assert.equal(f.audio.sourceCount,0);
});
test('planner failure cannot stop completed speech or replace exact playback history ACK',()=>{
  const f=fixture({visualFailure:true}),s=f.segment();f.plan();s.audio(new Int16Array(240).fill(300));s.subtitle('可以。');s.done();const result=f.finish('可以。');
  assert.equal(f.client.current.visualErrors.length,1);assert.equal(f.sent.filter(x=>x.type==='playback_complete').length,0);
  Object.assign(f.audio,{status:'ended',finished:true,time:.01,receivedDuration:.01,sourceCount:0,sourceActive:false,queuedSeconds:0});
  f.client.sync();f.client.sync();const ack=f.sent.filter(x=>x.type==='playback_complete');assert.equal(ack.length,1);assert.equal(ack[0].frames,result.frames);
  assert.equal(f.client.blocked,false);
});
test('mathematical context reaches director without assigning emotion from planner parameters',()=>{
  const f=fixture();f.event('action_context',{emotion:{V:.2,A:.3},effectiveEnergy:.7,authority:'mathematical',contextGeneration:'ctx'});
  const context=f.directorEvents.find(e=>e.method==='updateContext').args[0];assert.equal(context.authority,'mathematical');assert.equal(context.effectiveEnergy,.7);
  f.plan({arguments:'{"intent":"explain","emotion":"happy"}'});assert.equal(f.directorEvents.filter(e=>e.method==='offerPlan').at(-1).args[0].arguments,'{"intent":"explain","emotion":"happy"}');
  // Strict plan fields belong to the director; the adapter never translates them into facial state.
  assert.equal(f.cues.length,0);
});
