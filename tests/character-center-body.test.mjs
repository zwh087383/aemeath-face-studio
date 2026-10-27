import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CharacterBodyDirector, bodyAdmission, withAuthoredSkeleton, syncIdleMotionClock } from '../realtime/character-center/body-director.mjs';
import { MotionController } from '../preview/core/motion-controller.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { CHARACTER_ACTIONS, CHARACTER_CATALOG, validateCharacterCommands } from '../realtime/character-center/catalog.mjs';
import { MODEL_ACTIONS } from '../realtime/model-director/catalog.mjs';

const owner = (version = 1, scope = 'interaction') => ({ sourceKey: `${scope}:test`, sourceScope: scope,
  sourceVersion: version, semanticRevision: 1, ...(scope === 'activity' ? { activityId: 'test' } : { turnId: 'test' }) });
const command = (actions, operation = 'append', anchor = 'immediate') => ({ operation,
  actions: actions.map(action => ({ action, anchor, delay_ms: 0 })) });
const standing = () => ({ support: 'standing', posture: 'standing', contacts: { L: true, R: true },
  hands: 'free', props: {}, root: { position: [0, 0, 0], yaw: 0 }, canYield: true });

test('a real dormant gesture player can accept a wave after a long foreign-body activity', () => {
  const skeleton = skeletonFromInspection(JSON.parse(fs.readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url))));
  const motion = new MotionController({ skeleton }); motion.setOptions({ natural: true, continuity: true, intensity: 1, speed: 1 });
  motion.update(1, 0, { speech: 0 });
  const profile = JSON.stringify(motion.profile.gestures.wave);
  const cue = { id: 'after-long-reading', kind: 'gesture', gesture: 'wave', clock: 'wall', at: 125, strength: .65 };
  assert.equal(motion.enqueue(cue), false, 'reproduces the dormant player lookahead rejection');
  syncIdleMotionClock(motion, 125, { speech: 0, actions: [], paused: false });
  assert.equal(motion.enqueue(cue), true);
  motion.update(125.05, .05, { speech: 0 });
  assert.ok(motion.gestures.some(row => row.id === cue.id));
  assert.equal(JSON.stringify(motion.profile.gestures.wave), profile, 'authored wave trajectory is unchanged');
});

test('an executor refusal is retained in the row receipt as well as the event', () => {
  const { director, adapters } = setup(); adapters.conversation.start = () => false;
  director.submit(command(['gesture:wave']), owner()); director.update(0, 0);
  assert.equal(director.rows[0].reason, 'executor_refused');
  assert.equal(director.events.at(-1).reason, 'executor_refused');
});
function setup(initial = standing()) {
  let state = structuredClone(initial), live = true;
  const calls = [], adapters = {};
  for (const name of ['conversation', 'native', 'activity', 'face']) adapters[name] = {
    busy: false, current: null, cancelPending: false,
    canYield() { return !this.busy; },
    start(def, row, actor, oldExecutor) { calls.push({ type: 'start', executor: name, action: def.id, row, actor, oldExecutor });
      this.current = row; this.busy = true; return true; },
    status(row) { return { started: this.current === row && this.busy, done: !this.busy }; },
    cancel(row) { calls.push({ type: 'cancel', executor: name, row }); this.cancelPending = true; },
  };
  const director = new CharacterBodyDirector({ executors: adapters, getActorState: () => state,
    isOwnerCurrent: () => live });
  return { director, calls, adapters, setState(value) { state = value; }, setLive(value) { live = value; } };
}

test('failed actual step stops its model-selected continuation without fabricating a replacement',()=>{
 const {director:d,adapters,calls}=setup();const source={...owner(),requestId:'decision-1'};
 assert.equal(d.submit(command(['gesture:wave','gesture:curious']),source).accepted,true);d.update(0,0);
 adapters.conversation.status=()=>({started:true,done:true,failed:true,reason:'actual_executor_failure'});
 d.update(.1,.1);
 assert.deepEqual(d.rows.map(r=>r.status),['failed','cancelled']);assert.equal(d.pending.length,0);
 assert.equal(calls.filter(x=>x.type==='start').length,1);
 assert.equal(d.events.find(e=>e.type==='action_failed').index,0);
 assert.equal(d.events.find(e=>e.type==='action_cancelled').index,1);
});

test('missed voice command cancels dependent steps but not a different request',()=>{
 const {director:d}=setup();d.setMedia({audioStatus:'playing',audioTime:.2,mediaOwner:{turnId:'test'}});
 d.submit({operation:'append',actions:[{action:'gesture:wave',anchor:'voice',late:'reconsider'},
 {action:'gesture:curious',anchor:'immediate'}]},{...owner(),requestId:'one'});
 d.submit(command(['gesture:curious']),{...owner(1,'activity'),requestId:'other'});
 d.update(.2,.2);assert.deepEqual(d.rows.map(r=>r.status),['expired','cancelled','admitted']);
 assert.equal(d.active.action,'gesture:curious');
});

test('model keep preserves the moving executor and does not fabricate a completion',()=>{
 const {director:d,calls}=setup();const source={...owner(),requestId:'one'};
 d.submit(command(['gesture:wave']),source);d.update(0,0);const id=d.active.id;
 d.submit({operation:'keep',actions:[]},{...source,requestId:'two'});d.update(.1,.1);
 assert.equal(d.active.id,id);assert.equal(calls.length,1);assert.equal(d.events.some(e=>e.type==='action_completed'),false);
});

test('the wire catalogue contains existing 73 choices unchanged plus the exact two native and eight activity entries', () => {
  assert.equal(Object.keys(MODEL_ACTIONS).length, 73);
  assert.equal(Object.keys(CHARACTER_ACTIONS).length, 83);
  for (const [id, old] of Object.entries(MODEL_ACTIONS)) {
    assert.equal(CHARACTER_ACTIONS[id].duration, old.duration);
    assert.equal(CHARACTER_ACTIONS[id].name, old.name);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../realtime/character-center/catalog.json', import.meta.url))), CHARACTER_CATALOG);
  assert.equal(Object.values(CHARACTER_ACTIONS).some(row => /stand2|attack/i.test(JSON.stringify(row))), false);
});

test('unknown action and malformed batch are rejected atomically without clearing a running body', () => {
  const { director: d, calls } = setup();
  assert.equal(d.submit(command(['native:stand01']), owner()).accepted, true); d.update(0, 0);
  assert.equal(d.submit(command(['native:stand2'], 'replace'), owner()).accepted, false);
  assert.equal(d.executor, 'native'); assert.equal(d.active.action, 'native:stand01');
  assert.equal(calls.filter(call => call.type === 'cancel').length, 0);
  assert.throws(() => validateCharacterCommands({ operation: 'clear', actions: [{ action: 'native:stand01' }] }));
});

test('activity owner starts without a media response id or an audio clock', () => {
  const { director: d, calls } = setup();
  assert.equal(d.submit(command(['native:thinking01']), owner(1, 'activity')).accepted, true);
  d.update(0, 0, { audioStatus: 'idle' });
  assert.equal(calls.length, 1); assert.equal(d.active.action, 'native:thinking01');
  assert.equal(d.active.owner.responseId, undefined);
});

test('repeated model choices remain queued without per-turn count, repetition or cooldown limits', () => {
  const { director: d, adapters } = setup();
  const actions = Array(160).fill('native:stand01');
  assert.equal(d.submit(command(actions), owner()).count, 160); d.update(0, 0);
  adapters.native.busy = false; d.update(.1, .1);
  assert.equal(d.active.action, 'native:stand01'); assert.equal(d.pending.length, 158);
});

test('physical held-book state rejects a stand-only native choice while preserving the current owner', () => {
  const state = { ...standing(), support: 'seated', seatSupported: true, hands: 'occupied',
    props: { book: { visible: true, attachment: 'both' }, chair: { visible: true, attachment: 'floor' } } };
  const { director: d, calls } = setup(state);
  d.submit(command(['native:thinking01']), owner()); d.update(0, 0);
  assert.equal(calls.length, 0); assert.equal(d.rows[0].reason, 'requires_standing');
  assert.equal(d.snapshot().actorState.props.book.attachment, 'both'); assert.equal(d.executor, 'conversation');
});

test('reading requires actual seat, book acquisition and scene objects rather than relying on a filename', () => {
  const def = CHARACTER_ACTIONS['activity:read_seated'];
  const state = { ...standing(), support: 'seated', seatSupported: true,
    props: { chair: { visible: true, attachment: 'floor' }, book: { visible: true, attachment: 'table' } } };
  assert.equal(bodyAdmission(def, state), 'must_hold_book');
  state.props.book.attachment = 'both'; state.hands = 'occupied'; assert.equal(bodyAdmission(def, state), null);
  state.seatSupported = false; assert.equal(bodyAdmission(def, state), 'seat_support_unconfirmed');
});

test('taking or putting a book cannot invent a missing tabletop or source object', () => {
  const state = { ...standing(), support: 'seated', seatSupported: true,
    props: { chair: { visible: true, attachment: 'floor' } } };
  assert.equal(bodyAdmission(CHARACTER_ACTIONS['activity:take_book_seated'], state), 'missing_table');
  state.props.table = { visible: true }; state.props.book = { visible: true, attachment: 'floor' };
  assert.equal(bodyAdmission(CHARACTER_ACTIONS['activity:take_book_seated'], state), 'missing_table_source_book');
  assert.equal(bodyAdmission(CHARACTER_ACTIONS['activity:put_book_seated'], state), 'must_hold_book');
});

test('voice anchor waits for actual playback and cannot bind to a different owner', () => {
  const { director: d, calls } = setup();
  d.submit(command(['native:stand01'], 'append', 'voice'), owner());
  d.update(0, 0, { audioStatus: 'buffering', audioTime: 0 }); assert.equal(calls.length, 0);
  d.update(.1, .1, { audioStatus: 'playing', audioTime: .1, mediaOwner: { turnId: 'old-turn' } }); assert.equal(calls.length, 0);
  d.update(.2, .1, { audioStatus: 'playing', audioTime: .1, mediaOwner: { turnId: 'test' } }); assert.equal(calls.length, 1);
});

test('a late voice gesture expires after its matching playback ends so an immediate activity can proceed', () => {
  const { director: d, calls } = setup();
  d.submit(command(['gesture:listen'], 'append', 'voice'), owner());
  d.submit(command(['gesture:curious']), owner(1, 'activity'));
  d.update(5, .1, { audioStatus: 'ended', audioTime: 4.5, mediaOwner: { turnId: 'test' } });
  assert.equal(d.rows[0].status, 'expired'); assert.equal(d.rows[0].reason, 'voice_anchor_missed');
  assert.equal(d.rows[0].expiredAt, 5); assert.equal(d.rows[0].displayedAt, undefined);
  assert.equal(d.active.action, 'gesture:curious'); assert.equal(d.active.owner.sourceScope, 'activity');
  assert.deepEqual(calls.filter(call => call.type === 'start').map(call => call.action), ['gesture:curious']);
  assert.equal(d.events.filter(e => e.type === 'action_expired').length, 1);
});

test('another turn ending, generation completion, buffering and absent media evidence cannot expire a voice anchor', () => {
  const { director: d } = setup(); d.submit(command(['gesture:wave'], 'append', 'voice'), owner());
  for (const media of [
    { audioStatus: 'ended', audioTime: 2, mediaOwner: { turnId: 'different' } },
    { audioStatus: 'ended', audioTime: 2 },
    { audioStatus: 'ended', mediaOwner: { turnId: 'test' } },
    { audioStatus: 'buffering', audioTime: 2, segmentEnded: true, mediaOwner: { turnId: 'test' } },
    { audioStatus: 'paused', audioTime: 2, mediaOwner: { turnId: 'test' } },
  ]) { d.update(3, .01, media); assert.equal(d.pending.length, 1); assert.equal(d.rows[0].status, 'queued'); }
});

test('missed voice anchors expire across lanes and delays while ongoing bodies and segment-end anchors remain valid', () => {
  const { director: d, adapters, calls } = setup();
  d.submit(command(['native:thinking01'], 'append', 'voice'), owner());
  d.update(0, 0, { audioStatus: 'playing', audioTime: .1, mediaOwner: { turnId: 'test' } });
  d.submit({ operation: 'append', actions: [
    { action: 'gesture:wave', anchor: 'voice', delay_ms: 9000 },
    { action: 'action:blink', anchor: 'voice', delay_ms: 9000 },
    { action: 'native:stand01', anchor: 'segment_end', delay_ms: 0 },
  ] }, owner());
  d.update(1, 1, { audioStatus: 'ended', audioTime: .8, segmentEnded: true, mediaOwner: { turnId: 'test' } });
  assert.equal(d.active.action, 'native:thinking01');
  assert.deepEqual(d.rows.slice(1, 3).map(row => row.status), ['expired', 'expired']);
  assert.deepEqual(d.pending.map(row => row.action), ['native:stand01']);
  assert.equal(calls.some(call => call.type === 'cancel'), false);
  adapters.native.busy = false;
  d.update(2, 1, { audioStatus: 'ended', audioTime: .8, segmentEnded: true, mediaOwner: { turnId: 'test' } });
  assert.equal(d.active.action, 'native:stand01');
});

test('segment-end anchor requires explicit delivered end, not response generation done', () => {
  const { director: d, calls } = setup();
  d.submit(command(['native:stand01'], 'append', 'segment_end'), owner());
  d.update(0, 0, { audioStatus: 'ended' }); assert.equal(calls.length, 0);
  d.update(1, 1, { segmentEnded: true, mediaOwner: owner() }); assert.equal(calls.length, 1);
});

test('pure blink proceeds beside native body while head-bone actions wait for the body owner', () => {
  const { director: d, calls } = setup();
  d.submit(command(['native:thinking01']), owner()); d.update(0, 0);
  d.submit(command(['action:nod', 'action:blink']), owner()); d.update(.1, .1);
  assert.deepEqual(calls.filter(c => c.type === 'start').map(c => c.action), ['native:thinking01', 'action:blink']);
  assert.equal(d.pending[0].action, 'action:nod'); assert.equal(d.executor, 'native');
});

test('replacement retires the old intent and waits for its real mechanical exit', () => {
  const { director: d, adapters, calls } = setup();
  d.submit(command(['native:thinking01', 'native:stand01']), owner()); d.update(0, 0);
  d.submit(command(['gesture:wave'], 'replace'), owner()); d.update(.2, .2);
  assert.equal(d.active, null); assert.equal(d.pending.length, 1); assert.equal(d.executor, 'native');
  assert.equal(calls.filter(c => c.type === 'start').length, 1);
  adapters.native.busy = false; d.update(1, .8);
  assert.equal(d.executor, 'conversation'); assert.equal(d.active.action, 'gesture:wave');
});

test('cancelled source cannot resurrect through a late command while a new version remains usable', () => {
  const { director: d, adapters } = setup();
  d.submit(command(['native:stand01', 'native:thinking01']), owner()); d.update(0, 0);
  d.cancel(owner()); assert.equal(d.pending.length, 0);
  assert.equal(d.submit(command(['native:thinking01']), owner()).accepted, false);
  assert.equal(d.submit(command(['native:stand01']), owner(2)).accepted, true);
  d.update(.1, .1); assert.equal(d.active, null);
  adapters.native.busy = false; d.update(.2, .1); assert.equal(d.active.owner.sourceVersion, 2);
});

test('invalidated backing material retires queued and running actions before another executor can start', () => {
  const { director: d, setLive, calls } = setup();
  d.submit(command(['native:thinking01', 'native:stand01']), owner(1, 'activity')); d.update(0, 0);
  setLive(false); d.update(.1, .1);
  assert.equal(d.pending.length, 0); assert.equal(d.active, null);
  assert.equal(calls.filter(c => c.type === 'cancel').length, 1);
});

test('old completion is never accepted as completion of a different newly admitted action', () => {
  const { director: d, adapters } = setup();
  d.submit(command(['native:stand01', 'native:thinking01']), owner()); d.update(0, 0);
  const firstId = d.active.id; adapters.native.busy = false; d.update(.1, .1);
  const secondId = d.active.id; assert.notEqual(firstId, secondId); d.update(.2, .1);
  assert.equal(d.active.id, secondId);
  assert.deepEqual(d.events.filter(e => e.type === 'action_completed').map(e => e.id), [firstId]);
});

test('manual pause does not expire delayed queued actions or dispatch new work', () => {
  const { director: d, calls } = setup();
  d.submit({ operation: 'append', actions: [{ action: 'native:stand01', anchor: 'immediate', delay_ms: 1000 }] }, owner());
  d.pause(); d.update(5, 5); assert.equal(calls.length, 0); d.pause(false);
  d.update(5.5, .5); assert.equal(calls.length, 0); d.update(6.1, .6); assert.equal(calls.length, 1);
});

test('duplicate model packet does not repeat actions but distinct calls in the same turn can repeat', () => {
  const { director: d } = setup(), source = { ...owner(), requestId: 'one' };
  assert.equal(d.submit(command(['native:stand01']), source).accepted, true);
  assert.equal(d.submit(command(['native:stand01']), source).reason, 'duplicate_request');
  assert.equal(d.submit(command(['native:stand01']), { ...source, requestId: 'two' }).accepted, true);
  assert.equal(d.pending.length, 2);
});

test('MMD helper sees authored bones while native skinning keeps the complete palette, including exception recovery', () => {
  const authored = [{ name: 'jaw', userData: {} }, { name: 'head', userData: {} }];
  const virtual = { name: 'NativeCloth::skirt', userData: { nativeClothVirtual: true } };
  const all = [...authored, virtual], mesh = { skeleton: { bones: all },
    geometry: { userData: { MMD: { bones: [{ flag: 0 }, { flag: 0 }] } } }, morphTargetInfluences: [-.45, .6] };
  withAuthoredSkeleton(mesh, () => { assert.deepEqual(mesh.skeleton.bones, authored); assert.equal(mesh.morphTargetInfluences[0], -.45); });
  assert.equal(mesh.skeleton.bones, all);
  assert.throws(() => withAuthoredSkeleton(mesh, () => { throw Error('test failure'); }), /test failure/);
  assert.equal(mesh.skeleton.bones, all);
  mesh.geometry.userData.MMD.bones.pop();
  assert.throws(() => withAuthoredSkeleton(mesh, () => {}), /metadata_mismatch/);
  assert.equal(mesh.skeleton.bones, all);
});
