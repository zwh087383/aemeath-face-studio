import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterCenter } from '../realtime/character-center/center.mjs';
import { CharacterBodyDirector } from '../realtime/character-center/body-director.mjs';
import { CharacterClient } from '../realtime/character-center/client.mjs';

function setup(scope = 'user') {
  let center, time = 0, stable = false, control = null, taskDone = true, safeWindow = true;
  const calls = [], actor = { support: 'seated', seatSupported: true, contacts: { L: true, R: true },
    hands: 'occupied', props: { chair: { visible: true }, table: { visible: true }, book: { visible: true, attachment: 'both' } },
    activityToken: null, resumeToken: null };
  const body = new CharacterBodyDirector({ getActorState: () => actor, isOwnerCurrent: owner => center.current(owner), executors: {
    conversation: { canYield: () => true, start: () => true, status: () => ({ started: true, done: true }), cancel() {} },
    face: { start: () => true, status: () => ({ started: true, done: true }), cancel() {} },
    activity: { canYield: () => taskDone || stable,
      start(def) { calls.push('activity.start'); taskDone = false; actor.activityToken = 'activity:5:' + def.name; return true; },
      status: () => ({ started: true, done: taskDone }),
      cancel() { calls.push('activity.cancel'); taskDone = true; actor.activityToken = actor.resumeToken = null; } },
    control: { check(def, state, row) { return def.name === 'pause_activity' && row.owner.sourceScope === 'mechanical' && !safeWindow ? {wait:true,reason:'safe_window_pending'} : null; },
      start(def) { control = def.name; calls.push(control); if(control==='resume_activity'){stable=false;actor.resumeToken=null;}return true; },
      status: () => ({ started: true, done: control !== 'pause_activity' || stable }), cancel() { calls.push('control.cancel'); } },
  } });
  const face = { snapshot: () => ({}), cancel: command => calls.push(['face.cancel', command.source]), setAttitude: () => true };
  center = new CharacterCenter({ body, face, clock: () => time }); center.setConnection('connection-1'); center.beginTurn({ turnId: 'old-turn' });
  const sourceKey = scope === 'user' ? 'user:old-turn' : 'activity:reading';
  const event = { type: 'character_actions', connectionId: 'connection-1', sourceKey, sourceScope: scope,
    sourceVersion: '1', semanticRevision: 1, requestId: 'start-reading', turnId: scope === 'user' ? 'old-turn' : null,
    command: { operation: 'append', actions: [{ action: 'activity:sit_listen', anchor: 'immediate' }] } };
  assert.equal(center.message(event), true);
  const tick = () => body.update(time += .1, .1);
  tick(); tick();
  return { center, body, actor, calls, event, tick,
    attention() { return center.message({ type: 'character_attention', connectionId: 'connection-1', itemId: 'actual-user-audio', reason: 'user_speech_started', semanticUnderstanding: false }); },
    settle() { stable = true; actor.resumeToken = actor.activityToken; tick(); },
    setWindow(value) { safeWindow = value; },
    finish() { taskDone = true; actor.activityToken = actor.resumeToken = null; tick(); },
  };
}

for (const scope of ['user', 'activity']) test(`real user attention preserves the ${scope}-owned task but retires old queued turn actions`, () => {
  const f = setup(scope), original = f.body.active.id, token = f.actor.activityToken;
  f.center.message({ ...f.event, sourceKey: 'user:old-turn', sourceScope: 'user', turnId: 'old-turn',
    requestId: 'old-future', semanticRevision: 2,
    command: { operation: 'append', actions: [{ action: 'gesture:wave', anchor: 'voice' }] } });
  assert.equal(f.body.pending.length, 1);
  assert.equal(f.attention(), true); assert.equal(f.calls.includes('activity.cancel'), false);
  assert.ok(f.body.pending.every(row => row.owner.sourceScope === 'mechanical'));
  assert.equal(f.body.pending[0].activity_token, token); assert.equal(f.body.pending[0].owner.modelChosen, false);
  f.tick(); f.settle();
  assert.equal(f.body.active, null); assert.equal(f.body.suspended.row.id, original);
  assert.equal(f.body.suspended.token, token); assert.equal(f.body.attentionLease.rowId, original);
  assert.equal(f.center.message({ ...f.event, semanticRevision: 999, requestId: 'old-turn-late', turnId: 'old-turn' }), false);
  assert.equal(f.calls.filter(call => call === 'activity.start').length, 1);
  f.attention(); f.tick(); assert.equal(f.calls.filter(call => call === 'pause_activity').length, 1);
  assert.equal(f.center.hasWork(), false, 'a paused task does not pretend to keep actively executing');
});

test('real voice cancel and its driver callback do not erase the attention-paused task or restart audio', () => {
  const f = setup(); f.attention(); f.tick(); f.settle();
  const session = { owner: {}, audio: { snapshot: () => ({ status: 'playing', time: .4, sourceCount: 1, queuedSeconds: .2 }) },
    motion: { snapshot: () => ({ gestures: [] }) }, cancel() { f.calls.push('audio.cancel'); } };
  const client = new CharacterClient({ session, director: f.center, clock: () => 500 });
  client.current = { id: 'old-turn', owner: session.owner, revoked: false,
    driver: { cancel: () => f.center.cancel({ turnId: 'old-turn', reason: 'voice_owner_revoked' }) } };
  assert.equal(client.cancel('confirmed_voice_barge_in', false), true);
  assert.ok(f.body.suspended); assert.equal(f.calls.includes('activity.cancel'), false);
  assert.equal(f.calls.filter(call => call === 'audio.cancel').length, 1);
  f.center.beginTurn({ turnId: 'new-turn' });
  f.center.message({ ...f.event, sourceKey: 'user:new-turn', turnId: 'new-turn', semanticRevision: 4,
    requestId: 'explicit-resume', command: { operation: 'append', actions: [{ action: 'control:resume_activity',
      anchor: 'immediate', activity_token: f.actor.resumeToken }] } });
  f.tick(); f.tick(); assert.equal(f.body.active.action, 'activity:sit_listen'); assert.equal(f.body.suspended, null);
  assert.equal(f.body.attentionLease, null); assert.equal(f.calls.filter(call => call === 'activity.start').length, 1);
});

for (const global of [false, true]) test(`explicit ${global ? 'global' : 'source'} revoke clears the preserved activity and cannot reuse its token`, () => {
  const f = setup('activity'); f.attention(); f.tick(); f.settle(); const token = f.actor.resumeToken;
  f.center.message({ type: 'character_revoke', connectionId: 'connection-1',
    ...(global ? {} : { sourceKey: 'activity:reading' }), reason: 'source_withdrawn' });
  assert.equal(f.body.suspended, null); assert.equal(f.body.attentionLease, null); assert.equal(f.actor.activityToken, null);
  assert.equal(f.calls.filter(call => call === 'activity.cancel').length, 1);
  f.center.beginTurn({ turnId: 'new-turn' });
  f.center.message({ ...f.event, sourceKey: 'user:new-turn', sourceScope: 'user', turnId: 'new-turn', requestId: 'stale-resume',
    semanticRevision: 9, command: { operation: 'append', actions: [{ action: 'control:resume_activity', anchor: 'immediate', activity_token: token }] } });
  f.tick(); assert.equal(f.body.active, null); assert.equal(f.calls.includes('resume_activity'), false);
});

test('stale connection attention is ignored, and an unknown activity cannot get a fabricated token', () => {
  const f = setup();
  assert.equal(f.center.message({ type: 'character_attention', connectionId: 'old-connection' }), false);
  assert.equal(f.body.pending.length, 0);
  f.actor.activityToken = null;
  assert.equal(f.attention(), false); assert.equal(f.body.pending.length, 0);
  assert.equal(f.calls.includes('pause_activity'), false);
});

test('attention during entry waits for actual safe support while old audio turn is already retired', () => {
  const f=setup(), row=f.body.active;
  f.setWindow(false);assert.equal(f.attention(),true);
  for(let i=0;i<12;i++)f.tick();
  assert.equal(f.body.active,row);assert.equal(f.calls.includes('activity.cancel'),false);
  assert.equal(f.calls.includes('pause_activity'),false);assert.equal(f.body.pending.length,1);
  assert.equal(f.center.current(row.owner),false,'old semantic owner is retired already');
  f.center.cancel({turnId:'old-turn',reason:'voice_owner_revoked'});
  f.setWindow(true);f.tick();f.settle();
  assert.equal(f.body.suspended.row,row);assert.equal(f.calls.filter(x=>x==='pause_activity').length,1);
});

test('an activity that finishes before its safe pause window cannot leave a resumable phantom task', () => {
  const f=setup();f.setWindow(false);f.attention();f.tick();f.finish();f.tick();
  assert.equal(f.body.active,null);assert.equal(f.body.suspended,null);assert.equal(f.body.controlActive,null);
  assert.equal(f.body.attentionLease,null);assert.equal(f.body.pending.length,0);
  assert.equal(f.calls.includes('pause_activity'),false);
  assert.ok(f.body.events.some(e=>e.type==='action_completed'&&e.action==='activity:sit_listen'));
});

test('explicit source revocation after resume retains the original task provenance and stops it', () => {
  const f=setup('activity');f.attention();f.tick();f.settle();
  f.center.beginTurn({turnId:'new-turn'});
  f.center.message({...f.event,sourceKey:'user:new-turn',sourceScope:'user',turnId:'new-turn',semanticRevision:4,requestId:'resume',
    command:{operation:'append',actions:[{action:'control:resume_activity',anchor:'immediate',activity_token:f.actor.resumeToken}]}});
  f.tick();f.tick();assert.equal(f.body.active.receiptOwner.sourceKey,'activity:reading');
  f.center.message({type:'character_revoke',sourceKey:'activity:reading',reason:'material_withdrawn'});
  assert.equal(f.body.active,null);assert.equal(f.body.suspended,null);assert.equal(f.actor.activityToken,null);
  assert.equal(f.calls.filter(x=>x==='activity.cancel').length,1);
});

test('server speech shifts attention locally and its duplicate backend item cannot cancel a newer turn', () => {
  const f=setup('activity');let audioStatus='playing';
  const session={owner:{},audio:{snapshot:()=>({status:audioStatus,time:.4,sourceCount:1})},pause(){audioStatus='paused';return true;}};
  const client=new CharacterClient({session,director:f.center,clock:()=>500});client.connectionId='connection-1';
  client.current={id:'old-turn',owner:session.owner,revoked:false};
  client.message({type:'speech_started',connectionId:'connection-1',itemId:'speech-one'});
  assert.equal(audioStatus,'paused');assert.equal(f.center.paused,false);assert.equal(f.body.paused,false);
  assert.equal(f.body.pending[0].owner.sourceScope,'mechanical');f.tick();f.settle();
  assert.ok(f.body.suspended);
  f.center.beginTurn({turnId:'next-turn'});
  client.message({type:'character_attention',connectionId:'connection-1',itemId:'speech-one',reason:'user_speech_started'});
  assert.equal(f.center.retiredTurns.has('next-turn'),false);assert.equal(f.calls.filter(x=>x==='pause_activity').length,1);
});

test('local provisional noise pauses and resumes audio without freezing the body or fabricating attention', async () => {
  const f=setup('activity');let audioStatus='playing';
  const session={owner:{},audio:{snapshot:()=>({status:audioStatus,time:.4,sourceCount:1})},
    pause(){audioStatus='paused';return true;},async resume(){audioStatus='playing';return true;}};
  const client=new CharacterClient({session,director:f.center,clock:()=>500});client.current={id:'old-turn',owner:session.owner,revoked:false};
  assert.equal(client.provisionalPause('local_voice_activity'),true);
  assert.equal(f.body.paused,false);assert.equal(f.body.pending.length,0);assert.equal(f.body.attentionLease,null);
  await client.resumeInvalid();assert.equal(audioStatus,'playing');assert.equal(f.body.active.action,'activity:sit_listen');
  assert.equal(f.calls.includes('pause_activity'),false);
});

test('attention adapter failure remains a visual error and does not become a voice protocol failure', () => {
  const client=new CharacterClient({session:{},director:{message(){throw Error('visual failure');}},clock:()=>1});
  client.connectionId='connection-1';
  assert.doesNotThrow(()=>client.message({type:'speech_started',connectionId:'connection-1',itemId:'speech-one'}));
  assert.equal(client.blocked,false);assert.ok(client.events.some(e=>e.type==='visual_error'));
});

test('attention fences an old background decision while allowing a genuinely newer semantic revision', () => {
  const f=setup('activity');f.attention();f.tick();f.settle();
  assert.equal(f.center.message({...f.event,requestId:'late-same-revision'}),false);
  assert.equal(f.center.message({...f.event,requestId:'new-revision',semanticRevision:2,
    command:{operation:'keep',actions:[]}}),true);
  assert.ok(f.body.suspended);assert.equal(f.calls.filter(x=>x==='activity.start').length,1);
  f.center.message({type:'character_revoke',sourceKey:'activity:reading',reason:'source_withdrawn'});
  assert.equal(f.body.suspended,null,'latest semantic version must not hide the older physical task');
  assert.equal(f.actor.activityToken,null);assert.equal(f.calls.filter(x=>x==='activity.cancel').length,1);
});
