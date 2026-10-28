import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterBodyDirector, resolveBodyDefinition, bodyAdmission } from '../realtime/character-center/body-director.mjs';
import { CHARACTER_ACTIONS } from '../realtime/character-center/catalog.mjs';

const owner = (id = 'activity:reading', requestId = 'reading-command') =>
  ({ sourceKey: id, sourceVersion: 1, semanticRevision: 1, requestId });
const command = (action, extra = {}) => ({ action, anchor: 'immediate', ...extra });
function setup() {
  const actor = { support: 'seated', seatSupported: true, hands: 'occupied', contacts: { L: true, R: true },
    props: { chair: { visible: true }, table: { visible: true }, book: { visible: true, attachment: 'both' } },
    activityToken: null, resumeToken: null };
  let paused = false, stable = false, activityDone = true, supportedDone = true, activeControl = null, time = 0;
  const calls = [], stale = new Set();
  const executors = {
    conversation: { canYield: () => true, start: () => true, status: () => ({ started: true, done: true }) },
    face: { start: () => true, status: () => ({ started: true, done: true }), cancel() {} },
    activity: {
      canYield: () => activityDone || stable,
      start(def, row) { calls.push(['activity.start', def.id, row.id]); activityDone = false;
        actor.activityToken = 'activity:7:' + def.name; actor.resumeToken = null; return true; },
      status: () => ({ started: true, done: activityDone }),
      cancel() { calls.push(['activity.cancel']); activityDone = true; paused = stable = false;
        actor.activityToken = actor.resumeToken = null; },
    },
    supported: {
      canYield: () => supportedDone,
      start(def, row) { calls.push(['supported.start', def.supportedKind ?? def.name, row.id]); supportedDone = false; return true; },
      status: () => ({ started: true, done: supportedDone }),
      cancel() { calls.push(['supported.cancel']); supportedDone = true; },
    },
    control: {
      check(def) { return ['resume_activity', 'finish_activity'].includes(def.name) && !supportedDone ? 'busy' : null; },
      start(def, row) {
        calls.push(['control.start', def.name, row.activity_token]); activeControl = def.name;
        if (def.name === 'pause_activity') { paused = true; return true; }
        if (def.name === 'resume_activity') { paused = stable = false; actor.resumeToken = null; return true; }
        if (def.name === 'finish_activity') { paused = stable = false; actor.resumeToken = null; return true; }
        return false;
      },
      status: () => ({ started: true, done: activeControl !== 'pause_activity' || stable }),
      cancel() { calls.push(['control.cancel']); },
    },
  };
  const director = new CharacterBodyDirector({ executors, getActorState: () => actor,
    isOwnerCurrent: value => !stale.has(value.sourceKey) });
  const tick = () => director.update(time += .1, .1);
  const submit = (actions, who = owner(), operation = 'append') => director.submit({ operation, actions }, who);
  const start = () => { assert.equal(submit([command('activity:sit_listen')]).accepted, true); tick(); tick(); return actor.activityToken; };
  const settlePause = () => { assert.equal(paused, true); stable = true; actor.resumeToken = actor.activityToken; tick(); };
  const pause = () => { const token = actor.activityToken;
    assert.equal(submit([command('control:pause_activity', { activity_token: token })], owner('user:one', 'pause')).accepted, true);
    tick(); settlePause(); return token; };
  return { director, actor, calls, stale, tick, submit, start, pause, settlePause,
    finishSupported() { supportedDone = true; }, finishActivity() { activityDone = true; actor.activityToken = actor.resumeToken = null; } };
}

test('explicit support-preserving permission selects its own requirements; a default gesture never gains it', () => {
  const definition = CHARACTER_ACTIONS['action:nod'];
  assert.equal(resolveBodyDefinition(definition, {}), definition);
  assert.equal(resolveBodyDefinition(definition, { performance: { variant_set: ['exact'] } }), definition);
  const row = { performance: { variant_set: ['support-preserving'] } }, before = structuredClone(definition);
  const resolved = resolveBodyDefinition(definition, row);
  assert.equal(resolved.executor, 'supported'); assert.equal(resolved.supportedKind, 'nod');
  assert.deepEqual(resolved.requires.support, ['standing', 'seated']); assert.deepEqual(resolved.requires.freeHands, []);
  const state = { support: 'seated', seatSupported: true, hands: 'occupied', props: { book: { visible: true, attachment: 'both' } } };
  assert.equal(bodyAdmission(resolved, state), null); assert.equal(bodyAdmission(definition, state), 'requires_standing');
  assert.equal(bodyAdmission(resolved, { ...state, seatSupported: false }), 'seat_support_unconfirmed');
  assert.equal(bodyAdmission(resolved, { ...state, support: 'standing', contacts: {} }), 'standing_support_unconfirmed');
  assert.deepEqual(definition, before);
});

test('pause bypasses the active activity lane but detaches only after actual stable support', () => {
  const f = setup(), token = f.start(), original = f.director.active;
  f.submit([command('control:pause_activity', { activity_token: token })], owner('user:one', 'pause'));
  f.tick(); assert.equal(f.director.active, original); assert.equal(f.director.suspended, null);
  assert.equal(f.director.controlActive.action, 'control:pause_activity');
  f.settlePause(); assert.equal(f.director.active, null); assert.equal(f.director.suspended.row, original);
  assert.equal(original.status, 'suspended'); assert.equal(f.director.suspended.token, token);
  assert.equal(f.director.events.filter(e => e.type === 'action_completed' && e.action === 'activity:sit_listen').length, 0);
  assert.equal(f.director.events.filter(e => e.type === 'action_completed' && e.action === 'control:pause_activity').length, 1);
});

test('pause, supported conversation and explicit resume preserve command order and never restart the old activity', () => {
  const f = setup(), token = f.start(), originalId = f.director.active.id;
  const newOwner = owner('user:one', 'pause-nod-resume');
  f.submit([
    command('control:pause_activity', { activity_token: token }),
    command('action:nod', { performance: { variant_set: ['support-preserving'] } }),
    command('control:resume_activity', { activity_token: token }),
  ], newOwner);
  f.tick(); f.settlePause();
  assert.equal(f.director.executor, 'supported'); assert.equal(f.director.active.action, 'action:nod');
  assert.equal(f.calls.filter(call => call[1] === 'resume_activity').length, 0);
  f.tick(); assert.equal(f.director.suspended.row.id, originalId);
  f.finishSupported(); f.tick(); assert.equal(f.director.active, null);
  f.tick(); assert.equal(f.director.controlActive.action, 'control:resume_activity');
  f.tick(); assert.equal(f.director.active.id, originalId); assert.equal(f.director.suspended, null);
  assert.equal(f.director.executor, 'activity'); assert.deepEqual(f.director.active.owner, newOwner);
  assert.deepEqual(f.director.active.receiptOwner, owner());
  assert.equal(f.calls.filter(call => call[0] === 'activity.start').length, 1);
  assert.equal(f.director.events.find(e => e.type === 'action_resumed').replayed, false);
  f.finishActivity(); f.tick();
  const completed = f.director.events.find(e => e.type === 'action_completed' && e.action === 'activity:sit_listen');
  assert.deepEqual(completed.owner, owner()); assert.deepEqual(completed.executionOwner, newOwner);
});

test('finishing an overlay does not resume a suspended task; stale old ownership needs a new explicit current owner', () => {
  const f = setup(), token = f.start(); f.pause(); f.stale.add('activity:reading');
  f.submit([command('action:nod', { performance: { variant_set: ['support-preserving'] } })], owner('user:two', 'nod'));
  f.tick(); f.tick(); f.finishSupported(); f.tick(); f.tick();
  assert.equal(f.director.active, null); assert.equal(f.director.suspended.token, token);
  assert.equal(f.calls.filter(call => call[1] === 'resume_activity').length, 0);
  f.submit([command('control:resume_activity', { activity_token: token })], owner('user:two', 'resume'));
  f.tick(); f.tick(); assert.equal(f.director.active.action, 'activity:sit_listen');
  assert.equal(f.director.active.owner.sourceKey, 'user:two');
  assert.equal(f.calls.filter(call => call[0] === 'activity.start').length, 1);
});

test('explicit revocation retires the suspended task and its token, so even a new owner cannot revive it', () => {
  const f = setup(), token = f.start(); f.pause();
  f.director.cancel(owner(), 'source_revoked');
  assert.equal(f.director.suspended, null); assert.equal(f.actor.activityToken, null);
  f.submit([command('control:resume_activity', { activity_token: token })], owner('user:new', 'resume'));
  f.tick();
  assert.equal(f.director.active, null); assert.equal(f.director.events.at(-1).reason, 'activity_token_mismatch');
  assert.equal(f.calls.filter(call => call[1] === 'resume_activity').length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'activity.cancel').length, 1);
});

test('a guessed token never reaches the control executor and prevents dependent supported actions', () => {
  const f = setup(); f.start();
  f.submit([command('control:pause_activity', { activity_token: 'invented' }),
    command('action:nod', { performance: { variant_set: ['support-preserving'] } })], owner('user:one', 'wrong-token'));
  f.tick(); assert.equal(f.calls.filter(call => call[0] === 'control.start').length, 0);
  assert.equal(f.director.active.action, 'activity:sit_listen'); assert.equal(f.director.pending.length, 0);
  assert.ok(f.director.events.some(e => e.type === 'action_rejected' && e.reason === 'activity_token_mismatch'));
});

test('finish restores only the actual task lease, waits for its exit, and tolerates its token disappearing on completion', () => {
  const f = setup(), token = f.start(); f.pause();
  f.submit([command('control:finish_activity', { activity_token: token })], owner('user:one', 'finish'));
  f.tick(); assert.ok(f.director.suspended);
  f.tick(); assert.equal(f.director.active.action, 'activity:sit_listen'); assert.equal(f.director.suspended, null);
  assert.equal(f.director.events.filter(e => e.type === 'action_completed' && e.action === 'activity:sit_listen').length, 0);
  f.finishActivity(); f.tick();
  assert.equal(f.director.active, null);
  assert.equal(f.calls.filter(call => call[0] === 'activity.start').length, 1);

  const g = setup(), immediateToken = g.start(); g.pause();
  g.submit([command('control:finish_activity', { activity_token: immediateToken })], owner('user:one', 'finish'));
  g.tick(); g.finishActivity(); g.tick();
  assert.equal(g.director.suspended, null); assert.equal(g.director.active, null);
  assert.ok(g.director.events.some(e => e.type === 'action_completed' && e.action === 'control:finish_activity'));
  assert.ok(g.director.events.some(e => e.type === 'action_completed' && e.action === 'activity:sit_listen'));
});

test('source retirement during control settling cannot detach or revive a task for that old control', () => {
  const f = setup(), token = f.start(), caller = owner('user:one', 'pause');
  f.submit([command('control:pause_activity', { activity_token: token })], caller); f.tick();
  f.director.cancel(caller, 'user_interrupt'); f.settlePause();
  assert.equal(f.director.controlActive, null); assert.equal(f.director.suspended, null);
  assert.equal(f.director.active.action, 'activity:sit_listen');
  assert.ok(f.director.events.some(e => e.type === 'action_cancelled' && e.action === 'control:pause_activity'));
});

test('task revocation during an unfinished pause retires the control instead of leaving it waiting forever', () => {
  const f = setup(), token = f.start();
  f.submit([command('control:pause_activity', { activity_token: token })], owner('user:one', 'pause'));
  f.tick(); assert.ok(f.director.controlActive);
  f.director.cancel(owner(), 'material_revoked'); f.tick();
  assert.equal(f.director.controlActive, null); assert.equal(f.director.suspended, null); assert.equal(f.director.active, null);
  assert.ok(f.director.events.some(e => e.type === 'action_failed' && e.reason === 'activity_token_changed'));
});
