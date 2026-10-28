import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { ActivityDirector, initializeEmptyActivityScene } from '../realtime/activities/director.mjs';
import { ACTIVITY_LIBRARY, ACTIVITY_SEQUENCES, sampleActivity } from '../preview/core/activity-library.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { quinticBoundary } from '../preview/core/activity-continuity.js';
import { toWorld } from '../preview/core/full-body-ik.js';
import { ACTIVITY_PROP_LAYOUT, propGripPair } from '../preview/core/activity-prop-layout.js';
import { PARTITIONED_DESK } from '../preview/core/activity-desk-layout.js';
import { pulledOutDeskEntryFixture } from '../preview/core/activity-seat-access.js';
import { qrotate } from '../preview/core/motion-math.js';
import { fingerprintDependencies, verifyFingerprints } from '../scripts/action-preparation/source-fingerprints.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createActivityProps } = await import('../realtime/activities/props.mjs');
hooks.deregister();
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const delta = (a, b, dt) => a.map((v, i) => (v - b[i]) / dt);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const dependencies = fingerprintDependencies(['preview/core/full-body-controller.js', 'realtime/activities/director.mjs',
  'realtime/activities/props.mjs', 'realtime/activities/scene.mjs', 'tests/activity-continuity-preparation.test.mjs',
  'assets/Aemeath-inspection.json', 'preview/node_modules/three/package.json'], repositoryRoot);
const evidence = { schema: 1, runId: `${Date.now()}-${process.pid}`, startedAt: new Date().toISOString(), dependencies,
  expectedCoverage: { activities: Object.keys(ACTIVITY_LIBRARY).length, activityCancellations: Object.keys(ACTIVITY_LIBRARY).length * 3,
    sequences: Object.keys(ACTIVITY_SEQUENCES).length, sequenceCancellations: Object.keys(ACTIVITY_SEQUENCES).length * 3,
    receiptFrameRaces: Object.values(ACTIVITY_LIBRARY).filter(def=>def.kind==='take_prop').length*3+Object.values(ACTIVITY_LIBRARY).filter(def=>def.kind==='put_prop').length,
    crossRecipeEntries: 4*Object.keys(ACTIVITY_SEQUENCES).length*2, heldTransitions: 5, velocityProbes: 4, reusedSceneEntries: 1, farRetreatCancellations: 2, seatedDeskEntries: 10 },
  sampling: 'actual inspection PMX FK plus actual Three.js prop placement gate; not rendered skin acceptance',
  activities: [], cancellations: [], sequences: [], sequenceCancellations: [], velocityProbes: [], heldTransitions: [], receiptFrameRaces: [], crossRecipeEntries: [], reusedSceneEntries: [], farRetreatCancellations: [], seatedDeskEntries: [], holdingMetrics: {}, surfaceContactMetrics: {} };
const evidenceDirectory = process.env.ACTIVITY_PREPARATION_EVIDENCE ? resolve(process.env.ACTIVITY_PREPARATION_EVIDENCE) : null;
if(evidenceDirectory){mkdirSync(evidenceDirectory,{recursive:true});appendFileSync(resolve(evidenceDirectory,'continuity-checkpoints.jsonl'),JSON.stringify({kind:'run-start',runId:evidence.runId,at:evidence.startedAt,dependencies,expectedCoverage:evidence.expectedCoverage})+'\n');}
function coverageCounts(){return Object.fromEntries(['activities','cancellations','sequences','sequenceCancellations','velocityProbes','heldTransitions','receiptFrameRaces','crossRecipeEntries','reusedSceneEntries','farRetreatCancellations','seatedDeskEntries'].map(key=>[key,evidence[key].length]));}
function addEvidence(category,result){
  evidence[category].push(result);
  if(evidenceDirectory)appendFileSync(resolve(evidenceDirectory,'continuity-checkpoints.jsonl'),JSON.stringify({kind:'completed-case',runId:evidence.runId,at:new Date().toISOString(),category,result,counts:coverageCounts(),completeRun:false})+'\n');
}

function observeHolding(body, reports) {
  const anchors = body.handAnchors(), armReach = Math.max(...['L', 'R'].map(side => body.diagnostics.arms[side].reach));
  for (const [id, contact] of Object.entries(body.diagnostics.propContacts?.props ?? {})) {
    let maximumGap = 0;
    for (const [side, target] of Object.entries(contact.targets ?? {})) maximumGap = Math.max(maximumGap, anchors[side] ? distance(anchors[side].position, target) : Infinity);
    const key = `${body.activeId ?? 'idle'}:${body.status}:${id}`, metric = evidence.surfaceContactMetrics[key] ??= {
      activity: body.activeId, status: body.status, propId: id, samples: 0, maximumTargetGap: 0, maximumArmReach: 0, allReady: true, firstBadPhase: null };
    metric.samples++; metric.maximumTargetGap = Math.max(metric.maximumTargetGap, maximumGap); metric.maximumArmReach = Math.max(metric.maximumArmReach, armReach);
    metric.allReady &&= contact.ready === true;
    if (!metric.firstBadPhase && (maximumGap > .025 || armReach > .995001 || contact.ready !== true)) metric.firstBadPhase = {
      phase: body.pose.phase, elapsed: body.elapsed, gap: maximumGap, armReach, ready: contact.ready, counts: coverageCounts(),
      root: structuredClone(body.root), contact: structuredClone(contact), pose: structuredClone(body.pose) };
  }
  for (const [id, report] of Object.entries(reports.props ?? {})) {
    if (!report.visible || !['both', 'left', 'right'].includes(report.attachment)) continue;
    const state = body.pose.props[id] ?? {}, pair = propGripPair(id, report.openness);
    const targets = report.attachment === 'both' ? [['L', pair?.left], ['R', pair?.right]]
      : [[report.attachment === 'left' ? 'L' : 'R', state.grip ?? ACTIVITY_PROP_LAYOUT[id]?.grip]];
    let maximumError = 0;
    for (const [side, grip] of targets) {
      if (!grip || !anchors[side]) { maximumError = Infinity; continue; }
      const worldGrip = qrotate(report.quaternion, grip.map((value, i) => value * report.scale[i])).map((value, i) => value + report.position[i]);
      maximumError = Math.max(maximumError, distance(worldGrip, anchors[side].position));
    }
    const key = `${body.activeId ?? 'idle'}:${body.status}:${id}`, metric = evidence.holdingMetrics[key] ??= {
      activity: body.activeId, status: body.status, propId: id, samples: 0, maximumGripError: 0, maximumArmReach: 0,
      maximumScaleChange: 0, allMeasured: true, firstBadPhase: null };
    metric.samples++; metric.maximumGripError = Math.max(metric.maximumGripError, maximumError);
    metric.maximumArmReach = Math.max(metric.maximumArmReach, armReach);
    metric.maximumScaleChange = Math.max(metric.maximumScaleChange, ...report.scale.map(value => Math.abs(value - 1)));
    metric.allMeasured &&= report.measured === true;
    if (!metric.firstBadPhase && (maximumError > .025 || armReach > .995001 || metric.maximumScaleChange > 1e-8 || report.measured !== true)) {
      metric.firstBadPhase = { phase: body.pose.phase, elapsed: body.elapsed, gripError: maximumError, armReach, scale: report.scale, measured: report.measured };
    }
  }
}

function makeRun(hz = 60) {
  const body = new FullBodyController({ skeleton }), director = new ActivityDirector(body), props = createActivityProps(new THREE.Scene());
  let wall = 0;
  const run = { body, director, props, dt: 1 / hz, tick(dt = 1 / hz) {
    wall += dt; const clock = director.tick(wall); body.update(clock.now, clock.dt, { paused: clock.paused });
    const anchors = body.handAnchors();
    props.update(body.pose.props, { anchors: { leftHand: anchors.L, rightHand: anchors.R }, root: body.root,
      anchor: body.pose.anchor ?? body.anchor, pose: body.pose, snapshot: body.snapshot(), time: body.now });
    body.setRenderedPropsSnapshot(props.snapshot());
    body.setPropTransferReceipts(props.snapshot());
    observeHolding(body, props.snapshot());
    return body.snapshot();
  }, until(predicate, limit = 180) {
    for (let frame = 0; frame < limit * hz; frame++) { run.tick(); if (predicate()) return frame + 1; }
    const propId = ACTIVITY_LIBRARY[body.activeId]?.propId;
    throw Error(`timeout: ${body.activeId}/${body.status}/${body.pose.phase}/${JSON.stringify({ blocker: body.pose.preparationBlocker,
      gate: propId ? props.snapshot().props[propId]?.transfer : null, contacts: body.diagnostics.propContacts })}`);
  }, dispose() { props.dispose(); } };
  return run;
}
function acceptedPlay(run, id, options = {}) {
  assert.equal(run.director.play(id, { ...options, context: { deskLayout: 'partitioned',
    ...(id === 'stand_up_from_desk' ? { deskRetreat: 7 } : {}), ...options.context } }), true,
  `${id}: ${JSON.stringify(run.director.lastRejection)}`);
}
function finishedPlay(run, id, options = {}) {
  acceptedPlay(run, id, options); run.until(() => run.body.done, 40);
  assert.equal(run.body.activeId, id, 'preparation must finish the requested real clip');
}
function freshRecipe(run, id) {
  const definition = ACTIVITY_SEQUENCES[id];
  initializeEmptyActivityScene(run.body, run.props, definition);
  assert.equal(run.director.playSequence(id), true, `${id}: ${JSON.stringify(run.director.lastRejection)}`);
}
function arrangeSource(run, activity, { atDesk = activity !== 'read_seated' } = {}) {
  const def = ACTIVITY_LIBRARY[activity];
  const held = def.reading ? 'book' : ({ drink: 'mug', write: 'pencil', carry: 'box' })[def.kind];
  const propId = def.propId ?? held;
  const required = new Set(def.requires ?? []);
  if (propId) { required.add(propId); required.add('table'); }
  if (def.initialSupport === 'seated') required.add('chair');
  const setup = Object.fromEntries([...required].map(id => [id, structuredClone(PARTITIONED_DESK.setupProps[id] ?? true)]));
  if (required.has('box')) setup.box = { visible: true, attachment: 'table', position: [0, 8.9, 3.8] };
  const fixture = required.has('chair') ? pulledOutDeskEntryFixture(run.body.context, { props: setup }) : { sceneProps: setup, initialRoot: { position: [0, 0, 0], yaw: 0 } };
  assert.equal(Object.values(run.props.snapshot().props).some(prop => prop.visible), false, 'only a fresh scene may be initialized');
  run.props.update(fixture.sceneProps, { anchor: { position: [0, 0, 0], yaw: 0 }, time: run.director.time });
  run.body.setRenderedPropsSnapshot(run.props.snapshot());
  assert.equal(run.body.adoptSupportedState({ pose: run.body.standing(fixture.initialRoot), sceneProps: run.body.sceneProps }), true);
  if (def.initialSupport === 'seated') {
    finishedPlay(run, 'sit_down');
    if (activity !== 'stand_up' && activity !== 'approach_desk_seated' && required.has('table')) finishedPlay(run, 'approach_desk_seated');
  }
  if (held) finishedPlay(run, held === 'box' ? 'pickup_box' : `take_${held}_${def.initialSupport === 'seated' ? 'seated' : 'standing'}`);
  if (activity === 'read_seated' && !atDesk) {
    finishedPlay(run, 'stand_up_from_desk'); finishedPlay(run, 'sit_down');
  }
}
function arrangePlacement(run, id) {
  const def = ACTIVITY_LIBRARY[id];
  if (def.kind !== 'put_prop') { arrangeSource(run, id); return; }
  const predecessor = def.propId === 'book' ? def.initialSupport === 'seated' ? 'study_at_desk' : 'read_standing'
    : def.propId === 'mug' ? def.initialSupport === 'seated' ? 'drink_seated' : 'drink_standing' : 'write_at_desk';
  arrangeSource(run, predecessor, { atDesk: true }); finishedPlay(run, predecessor);
  run.body.setRenderedPropsSnapshot(run.props.snapshot());
}

test('quintic bridge retains nonzero measured boundary velocities', () => {
  const epsilon = 1e-6, duration = .42, a = 2, b = -1, va = 3.7, vb = -.6;
  assert.equal(quinticBoundary(a, b, va, vb, 0, duration), a);
  assert.ok(Math.abs((quinticBoundary(a, b, va, vb, epsilon, duration) - a) / epsilon - va) < .0001);
  assert.ok(Math.abs((b - quinticBoundary(a, b, va, vb, duration - epsilon, duration)) / epsilon - vb) < .0001);
});

test('nonstationary actual PMX wrist velocity survives replacement and seated cancellation', () => {
  for (const operation of ['replace', 'stop']) {
    const run = makeRun(240); arrangeSource(run, 'sit_talk'); acceptedPlay(run, 'sit_talk');
    run.until(() => run.body.activeId === 'sit_talk' && run.body.elapsed >= 2.137);
    const previous = run.body.handAnchors().R.position; run.tick();
    const current = run.body.handAnchors().R.position, before = delta(current, previous, run.dt);
    assert.ok(Math.hypot(...before) > .03, 'probe must interrupt real nonzero hand velocity');
    const poseBefore = structuredClone(run.body.pose);
    if (operation === 'replace') acceptedPlay(run, 'sit_listen'); else run.director.stop();
    for (const key of ['root', 'pelvis', 'hands', 'feet', 'body']) assert.deepEqual(run.body.pose[key], poseBefore[key], 'command itself must not alter displayed transforms');
    run.tick(.0001); const after = delta(run.body.handAnchors().R.position, current, .0001);
    const gap = distance(before, after);
    addEvidence('velocityProbes',{ operation, actualWristVelocityBefore: before, actualWristVelocityAfter: after, gap });
    // The finite-difference input is 240Hz; .05 units/s is below a visible PMX
    // displacement of .001 per display frame and rejects a zero-speed restart.
    assert.ok(gap < .05, `${operation}: actual wrist velocity gap ${gap}`);
    run.until(() => run.body.done);
    assert.equal(run.body.pose.support, 'seated'); run.dispose();
  }
});

test('a body owner changed outside the director cannot resume an old sequence', () => {
  const run = makeRun(); assert.equal(run.director.playSequence('carry_delivery'), true); run.tick();
  assert.equal(run.body.play('walk_backward'), true); run.tick();
  assert.equal(run.director.sequence, null); run.until(() => run.body.done);
  assert.equal(run.body.activeId, 'walk_backward');
  assert.ok(run.director.events.some(event => event.type === 'sequence-retired' && event.reason === 'body-owner-changed'));
  run.dispose();
});

test('a held fixed-size book retains its grip in declared variants and atomically rejects a main hand gesture', () => {
  for (const next of ['stand_up', 'turn_left', 'sit_talk', 'stretch_up', 'walk_forward']) {
    const run = makeRun(60); arrangeSource(run, 'read_seated'); acceptedPlay(run, 'read_seated'); run.until(() => run.body.done);
    const source = run.props.snapshot().props.book;
    assert.equal(source.visible, true); assert.equal(source.attachment, 'both');
    let maximumGripError = source.gripError ?? 0;
    if (['turn_left', 'walk_forward'].includes(next)) finishedPlay(run, 'stand_up');
    if (next === 'walk_forward') finishedPlay(run, 'walk_left');
    const before = run.body.snapshot(), accepted = run.director.play(next);
    if (ACTIVITY_LIBRARY[next].freeHands?.length) {
      assert.equal(accepted, false); assert.equal(run.director.snapshot().lastRejection.reason, 'free-hands-required');
      assert.deepEqual(run.body.snapshot(), before, 'rejected speech hand gesture changed the held book/body');
      assert.equal(run.body.activeId, 'read_seated', 'rejected main arm motion replaced the actual owner');
      assert.equal(run.director.events.filter(event => event.type === 'activity' && event.id === next).length, 0);
      addEvidence('heldTransitions',{ from: 'read_seated', to: next, accepted, reason: 'free-hands-required' }); run.dispose(); continue;
    }
    assert.equal(accepted, true, `${next}: ${JSON.stringify(run.director.lastRejection)}`);
    run.until(() => {
      const book = run.props.snapshot().props.book;
      assert.equal(book.visible, true, `${next}: held book disappeared`); assert.equal(book.attachment, 'both');
      assert.deepEqual(book.scale, [1, 1, 1], `${next}: changed book size to hide hand mismatch`);
      maximumGripError = Math.max(maximumGripError, book.gripError ?? Infinity);
      return run.body.done;
    });
    addEvidence('heldTransitions',{ from: 'read_seated', to: next, accepted, variant: run.body.snapshot().variant, maximumGripError, finalGripError: run.props.snapshot().props.book.gripError });
    assert.ok(maximumGripError <= .025, `${next}: actual palm/book grip gap ${maximumGripError}`);
    run.dispose();
  }
});

test('a moving held book and its measured palm continue their nonzero velocity when interrupted', () => {
  for (const operation of ['replace', 'stop']) {
    const run = makeRun(240); arrangeSource(run, 'read_seated'); acceptedPlay(run, 'read_seated');
    run.until(() => run.body.activeId === 'read_seated' && run.body.elapsed >= .373);
    const previousPalm = run.body.handAnchors().R.position, previousBook = run.props.snapshot().props.book.position;
    run.tick(); const palm = run.body.handAnchors().R.position, book = run.props.snapshot().props.book.position;
    const beforePalm = delta(palm, previousPalm, run.dt), beforeBook = delta(book, previousBook, run.dt);
    assert.ok(Math.hypot(...beforeBook) > .03, 'held-object probe must not start at zero velocity');
    if (operation === 'replace') acceptedPlay(run, 'sit_listen'); else run.director.stop();
    run.tick(.0001);
    const afterPalm = delta(run.body.handAnchors().R.position, palm, .0001);
    const afterBook = delta(run.props.snapshot().props.book.position, book, .0001);
    assert.ok(distance(beforePalm, afterPalm) < .05, `${operation}: palm velocity restarted ${distance(beforePalm, afterPalm)}`);
    assert.ok(distance(beforeBook, afterBook) < .05, `${operation}: rigid object velocity restarted ${distance(beforeBook, afterBook)}`);
    assert.ok(run.props.snapshot().props.book.gripError < .025);
    addEvidence('velocityProbes',{ kind: 'held-book', operation, actualPalmVelocityBefore: beforePalm,
      actualPalmVelocityAfter: afterPalm, actualBookVelocityBefore: beforeBook, actualBookVelocityAfter: afterBook,
      palmGap: distance(beforePalm, afterPalm), objectGap: distance(beforeBook, afterBook) });
    run.dispose();
  }
});

test('a placement clock never fabricates a receipt and cancelled transfer owners cannot release later', () => {
  const run = makeRun(30), { body } = run;
  arrangeSource(run, 'read_standing'); acceptedPlay(run, 'read_standing'); run.until(() => body.done);
  body.play('put_book_standing');
  for (let frame = 0; frame < 400; frame++) body.update(body.now + 1 / 30, 1 / 30);
  assert.equal(body.done, false); assert.equal(body.status, 'awaiting-prop-release');
  assert.equal(body.pose.props.book.attachment, 'both');
  const oldOwner = body.pose.props.book.transfer.id;
  body.stop();
  assert.equal(body.pose.props.book.transfer, undefined, 'cancel left a live release request');
  assert.equal(body.setPropTransferReceipts({ props: { book: { transfer: { owner: oldOwner, operation: 'place', released: true,
    transform: { position: [0, 9.08, 3.7], quaternion: [0, 0, 0, 1] } } } } }), 0, 'cancelled owner accepted a late release');
  for (let frame = 0; frame < 100; frame++) body.update(body.now + 1 / 30, 1 / 30);
  assert.equal(body.pose.props.book.attachment, 'both'); assert.equal(body.done, true);
  run.dispose();
});

test('all six actual takes preserve acquired ownership when stopped, replaced or placed in the receipt frame', () => {
  for (const [id, def] of Object.entries(ACTIVITY_LIBRARY).filter(([, def]) => def.kind === 'take_prop')) for (const operation of ['stop', 'replace', 'transfer']) {
    const run = makeRun(30); arrangeSource(run, id); acceptedPlay(run, id);
    run.until(() => run.body.propTransferReceipts[def.propId]?.released === true, 30);
    const receipt = run.body.propTransferReceipts[def.propId];
    assert.equal(receipt.operation, 'take');
    assert.ok(['both', 'left', 'right'].includes(run.body.pose.props[def.propId].attachment), 'receipt frame still claims table ownership');
    const before = run.props.snapshot().props[def.propId].position;
    const next = operation === 'transfer' ? def.propId === 'box' ? 'carry_box' : `put_${def.propId}_${def.initialSupport === 'seated' ? 'seated' : 'standing'}`
      : def.initialSupport === 'seated' ? 'sit_listen' : 'turn_left';
    if (operation === 'stop') run.director.stop(); else assert.equal(run.director.play(next), true);
    assert.ok(['both', 'left', 'right'].includes(run.body.pose.props[def.propId].attachment));
    assert.equal(run.body.pose.props[def.propId].transfer, undefined, 'old acquisition request remains live');
    assert.equal(run.body.setPropTransferReceipts({ props: { [def.propId]: { transfer: receipt } } }), 0, 'retired take owner accepted twice');
    run.tick(); assert.ok(distance(run.props.snapshot().props[def.propId].position, before) < .1, `${id}/${operation}: receipt-frame interruption jumped the object`);
    run.until(() => run.body.done, 20);
    assert.equal(run.props.snapshot().props[def.propId].visible, true);
    if (operation === 'transfer' && def.propId !== 'box') assert.equal(run.props.snapshot().props[def.propId].attachment, 'table');
    else assert.ok(['both', 'left', 'right'].includes(run.props.snapshot().props[def.propId].attachment));
    addEvidence('receiptFrameRaces',{ acquisition: id, operation, next: operation === 'stop' ? null : next,
      acquiredOwner: receipt.owner, finalAttachment: run.props.snapshot().props[def.propId].attachment,
      finalReceipt: run.body.propTransferReceipts[def.propId] ?? null });
    run.dispose();
  }
});

test('every real placement permits an immediate new take in the same receipt frame', () => {
  for (const [id, def] of Object.entries(ACTIVITY_LIBRARY).filter(([, def]) => def.kind === 'put_prop')) {
    const run = makeRun(30); arrangePlacement(run, id); acceptedPlay(run, id);
    run.until(() => run.body.propTransferReceipts[def.propId]?.released === true, 30);
    const receipt = run.body.propTransferReceipts[def.propId];
    assert.equal(receipt.operation, 'place'); assert.equal(run.body.pose.props[def.propId].attachment, 'table');
    assert.equal(run.body.sceneProps[def.propId].attachment, 'table');
    const next = `take_${def.propId}_${def.initialSupport === 'seated' ? 'seated' : 'standing'}`;
    assert.equal(run.director.play(next), true, 'real placed ownership was still considered hand-held');
    run.until(() => run.body.done, 30);
    assert.equal(run.body.propTransferReceipts[def.propId].operation, 'take');
    addEvidence('receiptFrameRaces',{ placement: id, operation: 'take-immediately-after-place', next,
      placedOwner: receipt.owner, finalAttachment: run.props.snapshot().props[def.propId].attachment,
      finalReceipt: run.body.propTransferReceipts[def.propId] });
    run.dispose();
  }
});

test('all published activities and three different-phase cancellation probes preserve real FK and ownership', () => {
  for (const [id, def] of Object.entries(ACTIVITY_LIBRARY)) {
    const run = makeRun(30); arrangePlacement(run, id); acceptedPlay(run, id);
    let maximumAnkleError = 0, frames = 0;
    run.until(() => {
      frames++; assert.equal(run.body.diagnostics.finite, true, id);
      for (const side of ['L', 'R']) maximumAnkleError = Math.max(maximumAnkleError, run.body.diagnostics.legs[side].error);
      return run.body.done;
    });
    assert.equal(run.body.activeId, id); assert.equal(run.body.pose.support, def.endSupport);
    assert.ok(maximumAnkleError < .03, `${id}: ankle FK error ${maximumAnkleError}`);
    const operation = run.body.transferOperation(def);
    if (operation) {
      assert.equal(run.body.propTransferReceipts[def.propId]?.released, true, `${id}: no renderer handoff`);
      assert.equal(run.body.propTransferReceipts[def.propId]?.operation, operation);
    }
    addEvidence('activities',{ id, frames, support: run.body.pose.support, maximumAnkleError,
      transfer: operation ? run.body.propTransferReceipts[def.propId] : null });
    run.dispose();
    for (const probe of ['preparing', .47, .91]) {
      const r = makeRun(30); arrangePlacement(r, id); acceptedPlay(r, id);
      if (probe === 'preparing') { r.tick(); r.tick(.1); }
      else r.until(() => r.body.activeId === id && r.body.elapsed >= def.duration * probe);
      const at = r.body.snapshot(), previousRevision = r.body.revision;
      r.director.stop(); assert.equal(r.director.sequence, null);
      r.until(() => r.body.done, 12);
      assert.equal(r.body.snapshot().queued, null); assert.ok(r.body.revision > previousRevision);
      assert.ok(['idle', 'seated'].includes(r.body.status), `${id}/${probe}: ${r.body.status}`);
      const held = Object.entries(at.pose.props).filter(([, p]) => p?.visible && ['both', 'left', 'right'].includes(p.attachment));
      for (const [propId] of held) assert.equal(r.body.pose.props[propId]?.visible, true, `${id}/${probe}: held prop vanished`);
      const stopped = structuredClone(r.body.pose);
      for (let f = 0; f < 30; f++) r.tick();
      assert.deepEqual(r.body.pose, stopped, `${id}/${probe}: stale activity resumed`);
      addEvidence('cancellations',{ id, probe, interruptedPhase: at.phase, support: r.body.pose.support, queued: r.body.snapshot().queued }); r.dispose();
    }
  }
});

test('all seven complete recipes use real placement receipts and do not drop persistent objects between steps', () => {
  assert.equal(Object.keys(ACTIVITY_SEQUENCES).length, 7);
  for (const [id, definition] of Object.entries(ACTIVITY_SEQUENCES)) {
    const run = makeRun(30), completed = [];
    freshRecipe(run, id);
    // The explicit initialScene helper creates only a fresh fixture. Sit-down
    // and chair approach still execute with real support and renderer receipts.
    let maximumAnkleError = 0, previousProps = {}, maximumPlacedMovement = 0;
    for (let frame = 0; frame < 12000 && run.director.sequence; frame++) {
      run.tick();
      const props = run.props.snapshot().props;
      for (const [propId, report] of Object.entries(previousProps)) if (report.visible) {
        assert.equal(props[propId]?.visible, true, `${id}: ${propId} disappeared between steps`);
        if (report.attachment === 'table' && props[propId].attachment === 'table' && propId !== 'chair') {
          maximumPlacedMovement = Math.max(maximumPlacedMovement, distance(report.position, props[propId].position));
        }
      }
      previousProps = props;
      for (const side of ['L', 'R']) maximumAnkleError = Math.max(maximumAnkleError, run.body.diagnostics.legs[side].error);
    }
    completed.push(...run.director.events.filter(event => event.type === 'step-completed').map(event => event.id));
    assert.equal(run.director.sequence, null, `${id}: sequence stalled at ${run.body.activeId}/${run.body.status}`);
    const expected = definition.steps.map(step => typeof step === 'string' ? step : step.activity);
    assert.deepEqual(completed, expected, `${id}: missing actual completion`);
    assert.ok(maximumAnkleError < .03, `${id}: ankle error ${maximumAnkleError}`);
    assert.ok(maximumPlacedMovement < .001, `${id}: scene-owned object moved ${maximumPlacedMovement}`);
    const receipts = Object.entries(run.props.snapshot().props).filter(([, report]) => report.transfer?.released).map(([propId, report]) => ({ propId, transfer: report.transfer }));
    addEvidence('sequences',{ id, expected, completed, maximumAnkleError, maximumPlacedMovement, receipts }); run.dispose();
  }
});

test('all seven recipes cancel during preparation, a live middle activity, and the final recovery without reviving later steps', () => {
  for (const [id, definition] of Object.entries(ACTIVITY_SEQUENCES)) for (const phase of ['preparing', 'middle', 'recovery']) {
    const run = makeRun(30), expected = definition.steps.map(step => typeof step === 'string' ? step : step.activity);
    freshRecipe(run, id);
    if (phase === 'preparing') { run.tick(); run.tick(.1); }
    else {
      const index = phase === 'middle' ? Math.floor(expected.length / 2) : expected.length - 1;
      const activity = expected[index], fraction = phase === 'middle' ? .37 : .86;
      run.until(() => run.director.sequence?.index === index && run.body.activeId === activity && run.body.elapsed >= ACTIVITY_LIBRARY[activity].duration * fraction, 300);
    }
    const before = run.body.snapshot(), oldGeneration = run.director.generation;
    const countBefore = run.director.events.filter(event => event.type === 'step').length;
    run.director.stop(); assert.equal(run.director.sequence, null); assert.equal(run.director.generation, oldGeneration + 1);
    run.until(() => run.body.done, 15);
    assert.ok(['seated', 'idle'].includes(run.body.status));
    if (before.support === 'seated') assert.equal(run.body.pose.support, 'seated', 'conversation interruption automatically stood up');
    const settled = structuredClone(run.body.pose);
    for (let frame = 0; frame < 90; frame++) run.tick();
    assert.deepEqual(run.body.pose, settled); assert.equal(run.director.sequence, null);
    assert.equal(run.director.events.filter(event => event.type === 'step').length, countBefore);
    addEvidence('sequenceCancellations',{ id, phase, activity: before.activeId, activityPhase: before.phase,
      elapsed: before.elapsed, supportAtInterrupt: before.support, supportAfter: run.body.pose.support, laterStepCount: 0 });
    run.dispose();
  }
});

test('the farther reading desk retreat retains default clips and stops safely during seated retreat and rising', () => {
  const probe = makeRun(30), def = ACTIVITY_LIBRARY.stand_up_from_desk;
  const normal = sampleActivity(def.id, def.duration, probe.body.context), farther = sampleActivity(def.id, def.duration, { ...probe.body.context, deskRetreat: 5.5 });
  assert.ok(Math.abs(normal.root.position[2] - .9052941083908079) < 1e-9, 'default 3.5-unit clip was changed');
  assert.ok(Math.abs(farther.root.position[2] - normal.root.position[2] + 2) < 1e-9); probe.dispose();
  for (const cutAt of [1.3, 4.6]) {
    const run = makeRun(30); freshRecipe(run, 'reading_break');
    run.until(() => run.director.sequence?.index === 8 && run.body.activeId === 'stand_up_from_desk' && run.body.elapsed >= cutAt);
    const before = run.body.snapshot(), placed = run.props.snapshot().props, generation = run.director.generation;
    assert.equal(run.body.sampleContext.deskRetreat, 7);
    assert.equal(before.support, cutAt < 3.35 ? 'seated' : 'standing', 'probe did not reach the actual intended support stage');
    run.director.stop(); assert.equal(run.director.sequence, null); assert.equal(run.director.generation, generation + 1);
    let previousFeet = structuredClone(run.body.pose.feet), maximumLegError = 0, maximumPlacedMovement = 0;
    run.until(() => {
      for (const side of ['L', 'R']) {
        maximumLegError = Math.max(maximumLegError, run.body.diagnostics.legs[side].error);
        if (previousFeet[side].contact && run.body.pose.feet[side].contact) assert.ok(distance(previousFeet[side].position, run.body.pose.feet[side].position) < 1e-8, 'farther retreat cancellation slid a planted foot');
      }
      for (const [id, report] of Object.entries(placed)) if (report.visible && ['table', 'floor'].includes(report.attachment) && id !== 'chair') {
        const current = run.props.snapshot().props[id]; assert.equal(current.visible, true);
        maximumPlacedMovement = Math.max(maximumPlacedMovement, distance(report.position, current.position));
      }
      previousFeet = structuredClone(run.body.pose.feet); return run.body.done;
    }, 12);
    assert.ok(maximumLegError < .03); assert.ok(maximumPlacedMovement < .001); assert.equal(run.body.snapshot().queued, null);
    assert.equal(run.body.pose.support, before.support, 'a seated interruption was converted to standing');
    const settled = structuredClone(run.body.pose); for (let frame = 0; frame < 30; frame++) run.tick();
    assert.deepEqual(run.body.pose, settled); assert.equal(run.director.sequence, null);
    addEvidence('farRetreatCancellations',{ cutAt, phaseAtCancel: before.phase, supportAtCancel: before.support,
      finalSupport: run.body.pose.support, maximumLegError, maximumPlacedMovement, queued: run.body.snapshot().queued }); run.dispose();
  }
});

test('all four real held objects enter or atomically reject all seven recipes without scene setup stealing ownership', () => {
  for (const [source, propId] of [['read_standing', 'book'], ['drink_standing', 'mug'], ['write_at_desk', 'pencil'], ['carry_box', 'box']]) {
    for (const recipe of Object.keys(ACTIVITY_SEQUENCES)) for (const cancel of [false, true]) {
      const run = makeRun(30); arrangeSource(run, source); acceptedPlay(run, source); run.until(() => run.body.done);
      const beforeBody = run.body.snapshot(), beforeProps = run.props.snapshot(), generation = run.director.generation;
      const accepted = run.director.playSequence(recipe);
      if (!accepted) {
        assert.deepEqual(run.body.snapshot(), beforeBody, 'rejected recipe changed the current body owner');
        assert.equal(run.director.generation, generation); assert.equal(run.director.sequence, null);
        assert.ok(['hands-occupied', 'free-hands-required', 'existing-desk-object-outside-supported-zone', 'existing-desk-object-orientation-not-supported',
          'close-existing-object-before-partitioned-desk', 'missing-measured-initial-scene', 'seated-desk-entry-not-supported', 'seat_entry_requires_front_approach', 'seat_entry_space_blocked', 'seat_exit_space_blocked', 'activity_requires_explicit_prerequisite', 'activity_route_blocked_by_table', 'activity_route_blocked_by_chair'].includes(run.director.snapshot().lastRejection?.reason));
        run.tick(); assert.equal(run.props.snapshot().props[propId].visible, true);
        assert.deepEqual(run.props.snapshot().props[propId].position, beforeProps.props[propId].position, 'atomic rejection moved a real held object');
        addEvidence('crossRecipeEntries',{ source, propId, recipe, cancel, accepted, rejection: run.director.snapshot().lastRejection });
        run.dispose(); continue;
      }
      const recipeGeneration = run.director.generation;
      let previous = run.props.snapshot(), cancelled = false, maximumSceneMotion = 0;
      for (let frame = 0; frame < 12000 && (run.director.sequence || !run.body.done); frame++) {
        run.tick(); const current = run.props.snapshot(), prop = current.props[propId], old = previous.props[propId];
        assert.equal(prop.visible, true, `${source}->${recipe}: lost the real held object`);
        if (['left', 'right', 'both'].includes(old.attachment) && prop.attachment === 'table') {
          assert.equal(current.placementReceipts[propId]?.released, true, 'scene setup released without a measured placement');
          assert.equal(current.placementReceipts[propId]?.operation, 'place');
        }
        for (const [id, prior] of Object.entries(previous.props)) if (prior.visible && prior.attachment === 'table'
          && current.props[id]?.visible && current.props[id].attachment === 'table' && id !== 'chair') {
          maximumSceneMotion = Math.max(maximumSceneMotion, distance(prior.position, current.props[id].position));
        }
        if (cancel && !cancelled && run.director.sequence && run.director.sequence.index >= 1 && run.body.elapsed > .37 * run.body.duration) {
          run.director.stop(); cancelled = true;
        }
        previous = current;
      }
      assert.equal(run.director.sequence, null); assert.equal(run.body.done, true, `${source}->${recipe}: stalled`);
      assert.ok(maximumSceneMotion <= .001, `${source}->${recipe}: scene-owned object moved ${maximumSceneMotion}`);
      if (cancel) { assert.equal(cancelled, true); assert.equal(run.director.generation, recipeGeneration + 1); }
      const satisfied = run.director.events.filter(event => event.type === 'step-satisfied' && event.generation === recipeGeneration);
      for (const event of satisfied) assert.ok(['already-held', 'already-seated-at-same-desk'].includes(event.reason));
      addEvidence('crossRecipeEntries',{ source, propId, recipe, cancel, accepted, cancelled, maximumSceneMotion, satisfied,
        actualAcquisitions: currentReceiptOwners(run.props.snapshot().acquisitionReceipts), actualPlacements: currentReceiptOwners(run.props.snapshot().placementReceipts) });
      run.dispose();
    }
  }
});

function currentReceiptOwners(receipts = {}) { return Object.fromEntries(Object.entries(receipts).map(([id, receipt]) => [id, receipt.owner])); }

test('a real previously placed book keeps its attained world pose or atomically rejects an incompatible desk recipe', () => {
  const run = makeRun(30); arrangePlacement(run, 'put_book_standing'); acceptedPlay(run, 'put_book_standing'); run.until(() => run.body.done);
  const oldAcquisition = run.props.snapshot().acquisitionReceipts.book?.owner, placed = run.props.snapshot().props.book;
  const beforeBody = run.body.snapshot(), beforeScene = run.props.snapshot(), generation = run.director.generation;
  assert.equal(placed.attachment, 'table'); const accepted = run.director.playSequence('quiet_afternoon');
  if (!accepted) {
    assert.ok(['existing-desk-object-outside-supported-zone', 'existing-desk-object-orientation-not-supported', 'missing-measured-initial-scene'].includes(run.director.snapshot().lastRejection.reason));
    assert.deepEqual(run.body.snapshot(), beforeBody); assert.deepEqual(run.props.snapshot(), beforeScene);
    assert.equal(run.director.generation, generation); run.tick();
    assert.deepEqual(run.props.snapshot().props.book.position, placed.position, 'a refused layout silently re-staged the placed book');
    addEvidence('reusedSceneEntries',{ source:'real-put-book-standing',recipe:'quiet_afternoon',accepted,
      rejection:run.director.snapshot().lastRejection,maximumSceneMotion:0 });run.dispose();return;
  }
  let previous = placed, maximumSceneMotion = 0, newAcquisition = null;
  for (let frame = 0; frame < 12000 && run.director.sequence; frame++) {
    run.tick(); const report = run.props.snapshot(), book = report.props.book;
    assert.equal(book.visible, true);
    if (previous.attachment === 'table' && book.attachment === 'table') maximumSceneMotion = Math.max(maximumSceneMotion, distance(previous.position, book.position));
    if (previous.attachment === 'table' && ['both', 'left', 'right'].includes(book.attachment)) {
      newAcquisition = report.acquisitionReceipts.book?.owner;
      assert.ok(newAcquisition && newAcquisition !== oldAcquisition, 'a placed object changed ownership without a new real acquisition');
      assert.ok(distance(previous.position, book.position) < .03, 'new acquisition snapped the attained book pose');
    }
    previous = book;
  }
  assert.equal(run.director.sequence, null); assert.equal(run.body.done, true); assert.ok(newAcquisition);
  assert.ok(maximumSceneMotion <= .001, 'setup changed the world pose of an existing placed book');
  addEvidence('reusedSceneEntries',{ source: 'real-put-book-standing', recipe: 'quiet_afternoon', accepted, maximumSceneMotion, oldAcquisition, newAcquisition });
  run.dispose();
});

test('a stable real seated desk entry satisfies the introduction explicitly and preserves actual acquisition ownership', () => {
  for (const held of [true, false]) for (const cancel of [false, true]) {
    const run = makeRun(30), { body, director, props } = run;
    if (held) { arrangeSource(run, 'read_seated', { atDesk: true }); acceptedPlay(run, 'read_seated'); }
    else { initializeEmptyActivityScene(body, props, ACTIVITY_SEQUENCES.reading_break); finishedPlay(run, 'sit_down'); finishedPlay(run, 'approach_desk_seated'); }
    run.until(() => body.done); run.tick();
    const beforeBody = body.snapshot(), beforeScene = props.snapshot(), generation = director.generation;
    assert.equal(beforeBody.support, 'seated');
    assert.equal(director.playSequence('reading_break'), true, JSON.stringify(director.lastRejection));
    assert.equal(director.sequence.index, held ? 3 : 2); assert.equal(director.generation, generation + 1);
    for (const channel of ['root', 'pelvis', 'feet']) assert.deepEqual(body.pose[channel], beforeBody.pose[channel], `${channel} changed in the admission call`);
    assert.deepEqual(props.snapshot(), beforeScene, 'admission mutated an actual scene object before display');
    const recipeGeneration = director.generation, satisfied = director.events.filter(event => event.type === 'step-satisfied' && event.generation === recipeGeneration);
    assert.deepEqual(satisfied.map(event => [event.id, event.reason]), [
      ['sit_down', 'already-seated-at-same-desk'], ['approach_desk_seated', 'already-seated-at-same-desk'],
      ...(held ? [['take_book_seated', 'already-held']] : []),
    ]);
    const entered = new Set(); let cancelled = false, maximumRootMotionBeforeRise = 0, maximumPlacedMotion = 0, previous = beforeScene;
    for (let frame = 0; frame < 10000 && (director.sequence || !body.done); frame++) {
      run.tick(); entered.add(body.activeId);
      const current = props.snapshot();
      if (director.sequence && director.sequence.index < 8) {
        assert.equal(body.pose.support, 'seated', 'a satisfied seated entry automatically stood up');
        maximumRootMotionBeforeRise = Math.max(maximumRootMotionBeforeRise, distance(body.root.position, beforeBody.root.position));
      }
      for (const [id, report] of Object.entries(previous.props)) if (id !== 'chair' && report.visible && report.attachment === 'table'
        && current.props[id]?.visible && current.props[id].attachment === 'table') maximumPlacedMotion = Math.max(maximumPlacedMotion, distance(report.position, current.props[id].position));
      if (held) assert.equal(current.acquisitionReceipts.book?.owner, beforeScene.acquisitionReceipts.book.owner, 'already-held satisfaction fabricated another acquisition');
      if (cancel && !cancelled && body.activeId === 'read_seated' && body.elapsed > 2) { director.stop(); cancelled = true; }
      previous = current;
    }
    assert.equal(director.sequence, null); assert.equal(body.done, true); assert.equal(cancelled, cancel);
    for (const id of ['stand_up', 'approach_desk_seated', 'sit_down']) assert.equal(entered.has(id), false, `satisfied introduction still performed ${id}`);
    assert.ok(maximumRootMotionBeforeRise < 1e-8); assert.ok(maximumPlacedMotion < .001);
    assert.equal(director.events.some(event => event.type === 'step-completed' && event.generation === recipeGeneration && ['approach_desk_seated', 'sit_down'].includes(event.id)), false,
      'satisfied introductory steps were falsely reported as executed');
    if (cancel) { assert.equal(body.pose.support, 'seated'); assert.ok(['left', 'both'].includes(props.snapshot().props.book.attachment)); }
    else { assert.ok(distance(body.root.position, [10, 0, -20.594705891609192]) < 1e-7); assert.equal(props.snapshot().props.book.attachment, 'table'); }
    addEvidence('seatedDeskEntries', { held, cancel, accepted: true, satisfied, maximumRootMotionBeforeRise, maximumPlacedMotion,
      finalRoot: body.root, finalSupport: body.pose.support, actualAcquisitionOwner: props.snapshot().acquisitionReceipts.book?.owner }); run.dispose();
  }
});

test('unmatched or unfinished actual seated desk entries reject atomically without reenacting a standing introduction', () => {
  for (const condition of ['missing-table', 'missing-chair', 'shifted-table', 'shifted-chair', 'rotated-table', 'unfinished-seated-action']) {
    const run = makeRun(30), { body, director, props } = run; arrangeSource(run, 'read_seated', { atDesk: true }); acceptedPlay(run, 'read_seated'); run.until(() => body.done); run.tick();
    if (condition === 'unfinished-seated-action') { acceptedPlay(run, 'sit_listen'); run.until(() => body.elapsed >= .3); }
    else {
      const id = condition.endsWith('chair') ? 'chair' : 'table', actual = props.snapshot().props[id];
      let update;
      if (condition.startsWith('missing')) update = false;
      else update = { visible: true, attachment: 'floor', worldTransform: { position: actual.position.map((value, index) => value + (index === 0 && condition.startsWith('shifted') ? .25 : 0)),
        quaternion: condition === 'rotated-table' ? [0, Math.sin(.1), 0, Math.cos(.1)] : actual.quaternion } };
      props.update({ [id]: update }, { anchor: body.anchor, time: body.now }); body.setRenderedPropsSnapshot(props.snapshot());
    }
    const beforeBody = body.snapshot(), beforeScene = props.snapshot(), generation = director.generation, sequence = director.sequence;
    assert.equal(director.playSequence('reading_break'), false, condition);
    assert.equal(director.lastRejection.reason, 'seated-desk-entry-not-supported', `${condition}: ${JSON.stringify(director.lastRejection)}`);
    assert.deepEqual(body.snapshot(), beforeBody); assert.deepEqual(props.snapshot(), beforeScene); assert.equal(director.generation, generation); assert.equal(director.sequence, sequence);
    addEvidence('seatedDeskEntries', { condition, accepted: false, atomic: true, rejection: director.lastRejection }); run.dispose();
  }
});

test.after(() => {
  let dependencyError = null;
  try { verifyFingerprints(dependencies, repositoryRoot); evidence.sourceStable = true; }
  catch (error) { evidence.sourceStable = false; dependencyError = error; evidence.sourceError = error.message; }
  evidence.finishedAt = new Date().toISOString();
  evidence.counts=coverageCounts(); evidence.runFinished=true;
  const aliases={activityCancellations:'cancellations'};
  evidence.coverageComplete=Object.entries(evidence.expectedCoverage).every(([key,count])=>evidence.counts[aliases[key]??key]===count);
  evidence.holdingFailures = Object.values(evidence.holdingMetrics).filter(metric => metric.firstBadPhase);
  evidence.surfaceContactFailures = Object.values(evidence.surfaceContactMetrics).filter(metric => metric.firstBadPhase);
  if (evidenceDirectory) {
    writeFileSync(resolve(evidenceDirectory, 'continuity-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    appendFileSync(resolve(evidenceDirectory,'continuity-checkpoints.jsonl'),JSON.stringify({kind:'after-hook',runId:evidence.runId,at:evidence.finishedAt,sourceStable:evidence.sourceStable,coverageComplete:evidence.coverageComplete,counts:evidence.counts,
      note:'After-hook data is not a successful Node test exit. Check runner result separately.'})+'\n');
  }
  if (dependencyError) throw dependencyError;
  assert.equal(evidence.holdingFailures.length, 0, `actual hand-held contact/reach/size failed: ${JSON.stringify(evidence.holdingFailures)}`);
  assert.equal(evidence.surfaceContactFailures.length, 0, `actual surface hand-target/reach failed: ${JSON.stringify(evidence.surfaceContactFailures)}`);
});
