import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterBodyDirector } from '../realtime/character-center/body-director.mjs';
import { CharacterCenter } from '../realtime/character-center/center.mjs';

const owner = requestId => ({ sourceKey: 'assistant:turn:0', sourceScope: 'assistant',
  sourceVersion: 1, semanticRevision: 1, turnId: 'turn', requestId });
const command = (names, operation = 'replace') => ({ operation,
  actions: names.map(action => ({ action, anchor: 'immediate' })) });
function fixture() {
  const cancelled = [], executors = {};
  for (const name of ['conversation', 'face']) executors[name] = {
    live: null, finish: false, canYield() { return !this.live || this.finish; },
    start(def, row) { this.live = row; this.finish = false; return true; },
    status() { return { started: true, done: this.finish }; },
    cancel(row) { cancelled.push(row.id); this.live = null; },
  };
  const director = new CharacterBodyDirector({ executors,
    getActorState: () => ({ support: 'standing', hands: 'free', contacts: { L: true, R: true }, props: {} }) });
  return { director, executors, cancelled };
}

test('queue revision preserves an admitted body even before its visible-start receipt', () => {
  const { director: d, executors, cancelled } = fixture();
  d.submit(command(['gesture:comfort', 'gesture:listen']), owner('old')); d.update(0, 0);
  const current = d.active;
  assert.equal(current.status, 'admitted');
  d.submit(command(['gesture:curious', 'action:nod']), owner('new'));
  assert.equal(d.active, current); assert.deepEqual(cancelled, []);
  assert.deepEqual(d.pending.map(r => r.action), ['gesture:curious', 'action:nod']);
  assert.equal(d.rows[1].reason, 'model_replace_pending');
  d.update(.1, .1); assert.equal(current.status, 'playing');
  executors.conversation.finish = true; d.update(2, .1);
  assert.equal(current.status, 'completed'); assert.equal(d.active.action, 'gesture:curious');
  assert.equal(d.events.filter(e => e.type === 'action_retained').length, 1);
});

test('expired later sibling cannot cancel an already executing earlier step', () => {
  const { director: d, cancelled } = fixture();
  d.submit({ operation: 'replace', actions: [{ action: 'gesture:comfort', anchor: 'immediate' },
    { action: 'gesture:offer_turn', anchor: 'voice', late: 'reconsider' }] }, owner('old'));
  assert.ok(d.rows.length, 'recorded capabilities must remain available');
  d.update(0, 0); const current = d.active;
  d.update(.1, .1, { audioStatus: 'ended', audioTime: 2, mediaOwner: { turnId: 'turn' } });
  assert.equal(d.rows[1].status, 'expired'); assert.equal(d.active, current);
  d.submit(command(['gesture:curious']), owner('new')); d.update(.2, .1);
  assert.equal(d.active, current); assert.deepEqual(cancelled, []);
});

test('ordinary revision preserves concurrent blink; explicit clear cancels both lanes', () => {
  const { director: d, cancelled } = fixture();
  d.submit(command(['gesture:comfort', 'action:blink']), owner('old')); d.update(0, 0);
  const active = d.active, blink = d.faceActive[0];
  d.submit(command(['action:nod']), owner('new'));
  assert.equal(d.active, active); assert.equal(d.faceActive[0], blink); assert.equal(cancelled.length, 0);
  d.submit(command([], 'clear'), owner('stop'));
  assert.equal(d.active, null); assert.equal(d.pending.length, 0); assert.equal(d.faceActive.length, 0);
  assert.deepEqual(new Set(cancelled), new Set([active.id, blink.id]));
});

test('user barge-in cancels retained body immediately and fences old late commands', () => {
  const { director: d, cancelled } = fixture();
  d.submit(command(['gesture:comfort']), owner('old')); d.update(0, 0); d.update(.1, .1);
  const active = d.active;
  d.submit(command(['action:nod']), owner('revision'));
  d.cancel(null, 'barge_in');
  assert.equal(d.active, null); assert.equal(d.pending.length, 0);
  assert.deepEqual(cancelled, [active.id]);
  assert.equal(active.reason, 'barge_in');
  assert.equal(d.submit(command(['gesture:wave']), owner('late')).accepted, false);
});

test('source retirement overrides preservation on the next update', () => {
  const { director: d, cancelled } = fixture();
  d.submit(command(['gesture:comfort']), owner('old')); d.update(0, 0);
  d.submit(command(['action:nod']), owner('revision'));
  d.isOwnerCurrent = () => false; d.update(.1, .1);
  assert.equal(d.active, null); assert.equal(d.pending.length, 0); assert.equal(cancelled.length, 1);
  assert.equal(d.rows[0].reason, 'source_retired');
});

test('queue revision affects only its own source and changes neither action choice nor order', () => {
  const { director: d } = fixture();
  d.submit(command(['gesture:comfort']), owner('old')); d.update(0, 0);
  d.submit(command(['action:nod'], 'append'), { ...owner('other'), sourceKey: 'user:turn' });
  d.submit(command(['gesture:wave', 'action:nod', 'gesture:wave']), owner('new'));
  assert.deepEqual(d.pending.map(r => r.action), ['action:nod', 'gesture:wave', 'action:nod', 'gesture:wave']);
});

test('real center subtitle revisions retain the physical lease; explicit turn cancellation still wins', () => {
  const { director: body, cancelled } = fixture();
  const center = new CharacterCenter({ body, face: { cancel() {}, snapshot: () => ({}) }, clock: () => 1 });
  body.isOwnerCurrent = source => center.current(source); center.beginTurn({ turnId: 'turn' });
  const event = { type: 'character_actions', sourceScope: 'assistant', sourceKey: 'assistant:turn:0',
    sourceVersion: '44', semanticRevision: 1, requestId: 'decision-1', commandId: 'old', turnId: 'turn',
    command: command(['gesture:comfort']) };
  center.message(event); body.update(0, 0); const current = body.active;
  center.message({ ...event, requestId: 'decision-2', commandId: 'new', sourceVersion: '88',
    semanticRevision: 2, command: command(['action:nod']) }); body.update(.1, .1);
  assert.equal(body.active, current); assert.equal(cancelled.length, 0);
  center.cancel({ turnId: 'turn', reason: 'confirmed_barge_in' });
  assert.equal(cancelled.length, 1); assert.equal(body.pending.length, 0);
  assert.equal(center.message({ ...event, requestId: 'late', semanticRevision: 99 }), false);
});
