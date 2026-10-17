import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorPlanner } from '../behavior-planner.mjs';

const owner = { connectionId: 'c1', responseId: 'r1', epoch: 1 };
const free = () => ({ gaze: 'available', head: 'available', torso: 'available', arms: { L: 'available', R: 'available' } });
const pose = (extra = {}) => ({ headYaw: 0, headPitch: 0, gazeYaw: 0, gazePitch: 0,
  handRest: 'low', handsSettled: true, headBusy: false, armsBusy: false, torsoBusy: false, ...extra });
function harness() {
  let now = 0;
  const planner = new BehaviorPlanner({ clock: () => now });
  planner.setConnection('c1');
  return { planner, time(value) { now = value; },
    observe(extra = {}, token = planner.snapshot()) { return planner.observeInteraction({
      connectionId: token.connectionId, interactionGeneration: token.interactionGeneration, ...extra }); },
    plan(action, parts, bodyBusy = false) {
      return planner.planCandidate({ behavior: { intent: 'agreement', reaction: { level: 'micro' } },
        cues: [{ kind: 'action', action, strength: .24 }] }, { owner,
        interactionGeneration: planner.interactionGeneration, anchor: now + .06, nowAudio: now,
        receivedAt: now, nowWall: now, bodyBusy, parts, candidateId: `${action}:${now}` });
    } };
}

test('listener executes only displaced-attention opportunity with generation and no invented response', () => {
  const h = harness();
  h.planner.userSpeechStarted('c1');
  assert.equal(h.observe({ pose: pose({ headYaw: .16, gazeYaw: .12 }), parts: free() }), true);
  const state = h.planner.snapshot();
  assert.equal(state.owner, null); assert.equal(state.partnerVoicing, true);
  assert.equal(state.reaction.kind, 'listen-adjust');
  assert.equal(state.reaction.owner, undefined);
  assert.equal(state.reaction.interactionGeneration, state.interactionGeneration);
  assert.equal(state.reaction.connectionId, 'c1');
  assert.deepEqual(state.acceptedHistory, []); assert.deepEqual(state.displayedHistory, []);
  const reactionId = state.reaction.id;
  for (let second = 1; second <= 30; second++) {
    h.time(second); h.observe({ partnerVoicing: true, pose: pose({ headYaw: .16 }), parts: free() });
    assert.equal(h.planner.snapshot().reaction.id, reactionId, 'no timer or repeated onset cue');
  }
});

test('already attentive continuous speech produces no automatic nod or hand gesture', () => {
  const h = harness(); h.planner.userSpeechStarted('c1');
  for (let second = 0; second <= 30; second++) {
    h.time(second); h.observe({ partnerVoicing: true, pose: pose(), parts: free() });
    assert.equal(h.planner.snapshot().reaction, null);
    assert.equal(h.planner.snapshot().body.rest, 'low');
  }
  assert.equal(h.planner.snapshot().continuity.attentionReason, 'already_attending');
});

test('silent microphone arming and text submission are not evidence of partner speech', () => {
  const h = harness(), p = h.planner;
  assert.equal(p.userSpeechStarted('c1', { voiced: false }), true);
  h.observe({ pose: pose({ headYaw: .16, gazeYaw: .12 }), parts: free() });
  assert.equal(p.snapshot().partnerVoicing, false); assert.equal(p.snapshot().reaction, null);
  assert.equal(p.userSpeechEnded(p.snapshot()), true);
  assert.equal(p.snapshot().state.uncertainty, 0);
  h.observe({ partnerVoicing: true });
  assert.equal(p.snapshot().reaction.kind, 'listen-adjust', 'actual later onset may use current displaced pose');
  const before = p.snapshot();
  assert.equal(p.userSpeechStarted('c1', { voiced: 'true' }), false);
  assert.deepEqual(p.snapshot(), before);
});

test('partner and actual self playback may overlap without observation revoking response', () => {
  const h = harness(), p = h.planner; p.begin(owner);
  p.media({ owner, status: 'playing', time: 0, sourceActive: true });
  h.observe({ partnerVoicing: true, selfVoicing: true, pose: pose(), parts: free() });
  assert.equal(p.snapshot().partnerVoicing, true); assert.equal(p.snapshot().selfVoicing, true);
  assert.deepEqual(p.snapshot().owner, owner);
  p.media({ owner, status: 'buffering', time: .1 });
  assert.equal(p.snapshot().selfVoicing, false); assert.equal(p.snapshot().partnerVoicing, true);
  assert.deepEqual(p.snapshot().owner, owner, 'only host cancellation has cancellation authority');
});

test('begin and cancellation discard old voiced facts until current-generation capture confirms them', () => {
  const h = harness(), p = h.planner;
  h.observe({ partnerVoicing: true, selfVoicing: true });
  const initial = p.snapshot();
  assert.equal(p.begin(owner), true);
  assert.equal(p.snapshot().partnerVoicing, false); assert.equal(p.snapshot().selfVoicing, false);
  assert.equal(h.observe({ partnerVoicing: true }, initial), false);
  h.observe({ partnerVoicing: true, selfVoicing: true });
  assert.equal(p.snapshot().partnerVoicing, true); assert.equal(p.snapshot().selfVoicing, true);
  const old = p.snapshot();
  assert.equal(p.cancel(owner), true);
  assert.equal(p.snapshot().partnerVoicing, false); assert.equal(p.snapshot().selfVoicing, false);
  h.time(10); assert.equal(p.snapshot().partnerVoicing, false, 'no new PCM cannot leave stale true state');
  assert.equal(h.observe({ partnerVoicing: true }, old), false);
  assert.equal(h.observe({ partnerVoicing: true }), true);
});

test('stale listener observations and execution records cannot be relabelled into new generation', () => {
  const h = harness(), p = h.planner; p.userSpeechStarted('c1');
  h.observe({ pose: pose({ headYaw: .2 }), parts: free() });
  const old = p.snapshot(), oldId = old.reaction.id;
  p.userSpeechStarted('c1');
  assert.equal(h.observe({ partnerVoicing: false, pose: pose() }, old), false);
  assert.equal(p.feedback(oldId, { accepted: true, displayed: true }), false);
  h.observe({ pose: pose(), parts: free(), execution: { lastDisplayed: { id: oldId } } });
  assert.equal(p.snapshot().reaction, null); assert.deepEqual(p.snapshot().displayedHistory, []);
});

test('accepted is distinct from displayed; repeated executor snapshots do not inflate history', () => {
  const h = harness(), p = h.planner; p.userSpeechStarted('c1');
  h.observe({ pose: pose({ headYaw: .12 }), parts: free() });
  const id = p.snapshot().reaction.id;
  assert.equal(p.feedback(id, { accepted: true }), true);
  assert.equal(p.snapshot().acceptedHistory.length, 1); assert.equal(p.snapshot().displayedHistory.length, 0);
  for (let i = 0; i < 5; i++) h.observe({ execution: { lastAccepted: { id }, lastDisplayed: { id } } });
  assert.equal(p.snapshot().acceptedHistory.length, 1); assert.equal(p.snapshot().displayedHistory.length, 1);
  assert.equal(p.snapshot().counts.displayed, 1);
});

test('only actual displayed refocus consumes short readiness, never an unshown proposal', () => {
  for (const displayed of [false, true]) {
    const h = harness(), p = h.planner;
    h.observe({ partnerVoicing: true, pose: pose({ headYaw: .12 }), parts: free() });
    const first = p.snapshot().reaction.id;
    if (displayed) p.feedback(first, { accepted: true, displayed: true });
    h.observe({ partnerVoicing: false }); h.time(.2);
    h.observe({ partnerVoicing: true, pose: pose({ headYaw: .12 }), parts: free() });
    assert.equal(p.snapshot().reaction.id === first, displayed);
  }
});

test('rejected proposal cannot later become displayed and feedback storage stays bounded', () => {
  const h = harness(), p = h.planner;
  let rejected;
  for (let index = 0; index < 40; index++) {
    h.observe({ partnerVoicing: false });
    h.time(index + 1); h.observe({ partnerVoicing: true, pose: pose({ headYaw: .15 }), parts: free() });
    const id = p.snapshot().reaction.id;
    if (index === 0) { rejected = id; p.feedback(id, { accepted: false }); }
    else p.feedback(id, { accepted: true, displayed: true });
  }
  assert.equal(p.feedback(rejected, { accepted: true, displayed: true }), false);
  assert.equal(p.snapshot().acceptedHistory.length, 32); assert.equal(p.snapshot().displayedHistory.length, 32);
});

test('compatible close rest survives sentence lifecycle and does not oscillate on a timer', () => {
  const h = harness(), p = h.planner;
  h.observe({ pose: pose({ handRest: 'ready', handsSettled: false }), parts: free() });
  const state = p.snapshot(); assert.equal(state.body.rest, 'ready'); assert.equal(state.reaction.kind, 'rest');
  p.feedback(state.reaction.id, { accepted: true, displayed: true });
  p.begin(owner); p.answerAvailable(owner);
  for (let second = 1; second <= 20; second++) {
    h.time(second); h.observe({ selfVoicing: true, pose: pose({ handRest: 'ready' }), parts: free() });
    assert.equal(p.snapshot().body.rest, 'ready');
    assert.equal(p.snapshot().reaction, null, 'new sentence does not replay a rest or gesture');
  }
});

test('world wrist movement from chest follow is not mistaken for a displaced hand', () => {
  const h = harness(), p = h.planner;
  h.observe({ pose: { ...pose({ handsSettled: false }), handPlacementNeeded: false }, parts: free() });
  assert.equal(p.snapshot().reaction, null);
  const revision = p.snapshot().body.restRevision;
  h.time(1); h.observe({ pose: { ...pose({ handsSettled: false }), handPlacementNeeded: false }, parts: free() });
  assert.equal(p.snapshot().body.restRevision, revision);
  h.time(2); h.observe({ pose: { ...pose({ handsSettled: false, handRest: 'ready' }), handPlacementNeeded: true }, parts: free() });
  assert.equal(p.snapshot().reaction.kind, 'rest'); assert.equal(p.snapshot().body.rest, 'ready');
});

test('part arbitration permits head or gaze during arm exit and blocks occupied head', () => {
  const h = harness(), p = h.planner; p.begin(owner);
  const armsExiting = { ...free(), arms: { L: 'exiting', R: 'exiting' } };
  assert.equal(h.plan('nod', armsExiting, true).cues.length, 1);
  h.time(1);
  const headBusy = { ...armsExiting, head: 'occupied' };
  const blocked = h.plan('nod', headBusy);
  assert.equal(blocked.cues.length, 0); assert.equal(blocked.plan.degraded, 'required_parts_busy');
  h.time(2); assert.equal(h.plan('glance', headBusy).cues.length, 1);
});

test('late observation does not replay an onset adjustment; invalid facts have no side effects', () => {
  const h = harness(), p = h.planner; p.userSpeechStarted('c1'); h.time(2);
  h.observe({ pose: pose({ headYaw: .2 }), parts: free() });
  assert.equal(p.snapshot().reaction, null);
  const before = p.snapshot();
  for (const bad of [{ partnerVoicing: 'yes' }, { pose: pose({ headYaw: Infinity }) }, { parts: { head: 'free' } }])
    assert.equal(h.observe(bad), false);
  assert.deepEqual(p.snapshot(), before);
});

test('semantic plans are not executed history, and previous accepted plan can receive actual feedback', () => {
  const h = harness(), p = h.planner; p.begin(owner);
  const first = h.plan('nod', free()); h.time(1); h.plan('glance', free());
  assert.deepEqual(p.snapshot().acceptedHistory, []); assert.deepEqual(p.snapshot().displayedHistory, []);
  assert.equal(p.feedback(first.plan.planId, { accepted: true, displayed: true }), true);
  assert.equal(p.snapshot().displayedHistory[0].id, first.plan.planId);
});
