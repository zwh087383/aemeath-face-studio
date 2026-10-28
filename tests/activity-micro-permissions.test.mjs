import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, CONTINUATIONS, sourceHashes, measuredGrip } from '../scripts/character-center/audit-held-variants.mjs';
import { sampleActivity } from '../preview/core/activity-library.js';
import { PARTITIONED_DESK } from '../preview/core/activity-desk-layout.js';
import { createActivityContinuation, sampleActivityContinuation } from '../preview/core/activity-continuation.js';
import { heldPropSides } from '../preview/core/activity-continuity.js';

const output = 'outputs/library-expansion-20261027/activity-micro-permissions.json';
const report = { at: new Date().toISOString(), sourceHashes: sourceHashes(), rows: [],
  evidence: 'Actual controller and PMX/prop contact execution, permission matrix at sampled times; no GPU or cloud' };
fs.mkdirSync('outputs/library-expansion-20261027', { recursive: true });
const copy = value => structuredClone(value);

for (const d of CONTINUATIONS) test(`${d.id}: explicit micro permissions preserve all real grips and source exits`, () => {
  const setup = Object.fromEntries(d.requires.map(id => [id, copy(PARTITIONED_DESK.setupProps[id] ?? true)]));
  const held = d.reading ? 'book' : d.kind === 'write' ? 'pencil' : null;
  if (held) setup.table = true;
  const f = fixture(setup), { c, props } = f;
  const result = { id: d.id, pass: false, physicalFrames: 0, permissionSamples: 0, suppression: [], applied: [] };
  try {
    if (d.initialSupport === 'seated') f.run('sit_down');
    if (d.initialSupport === 'seated' && setup.table && c.seatAccess('approach_desk_seated').accepted) f.run('approach_desk_seated');
    if (held) f.run(`take_${held}_${d.initialSupport}`);
    f.run(d.id, { targetDuration: d.duration + 6.37, microSet: ['gaze_shift', 'finger_release'] }, measured => {
      result.physicalFrames++;
      if (held) { assert.ok(['both', 'right', 'left'].includes(measured.props[held].attachment)); assert.ok(measuredGrip(f, held, measured.props[held]) < .025); }
      if (c.bridge || c.elapsed < d.continuation.start + .5 || c.elapsed > c.duration - d.duration + d.continuation.end - .5) return;
      const sampler = time => sampleActivity(d.id, time, c.sampleContext);
      const occupiedHands = Object.values(c.sampleContext.initialPose.props ?? {}).flatMap(heldPropSides);
      const sample = set => sampleActivityContinuation(createActivityContinuation(d, { targetDuration: d.duration + 6.37, microSet: set }), c.elapsed, sampler, { occupiedHands });
      const plain = sample([]), gaze = sample(['gaze_shift']), fingers = sample(['finger_release']), both = sample(['gaze_shift', 'finger_release']);
      assert.deepEqual(plain.continuation.micro, { applied: [], suppressed: [] });
      assert.deepEqual(gaze.hands, plain.hands); assert.deepEqual(fingers.body, plain.body);
      assert.deepEqual(both.hands, fingers.hands); assert.deepEqual(both.body, gaze.body);
      assert.ok(Math.abs((gaze.body.gazeYaw ?? 0) - (plain.body.gazeYaw ?? 0)) <= .028000001);
      const occupied = new Set([...occupiedHands, ...Object.values(plain.props ?? {}).flatMap(heldPropSides),
        ...Object.values(plain.propContactPlans ?? {}).flatMap(plan => plan.hands ?? [])]);
      for (const side of ['L', 'R']) {
        if (occupied.has(side)) {
          assert.equal(both.hands[side].curl, plain.hands[side].curl);
          assert.ok(both.continuation.micro.suppressed.includes(`finger_release:${side}:contact`));
        } else assert.ok(both.hands[side].curl <= plain.hands[side].curl + 1e-10);
      }
      for (const channel of ['root', 'pelvis', 'feet', 'props', 'propContactPlans']) assert.deepEqual(both[channel], plain[channel]);
      result.suppression.push(...both.continuation.micro.suppressed); result.applied.push(...both.continuation.micro.applied);
      result.permissionSamples++;
    });
    assert.ok(result.permissionSamples > 60);
    const old = c.snapshot(); assert.equal(c.play(d.id, { microSet: ['unknown_micro'] }), false); assert.deepEqual(c.snapshot(), old);
    assert.deepEqual(c.pose.continuation.micro, { applied: [], suppressed: [] });
    // The two otherwise free seated middles must also honor ownership inherited
    // from a real prior take, not only objects declared by their own sampler.
    if (['sit_listen', 'sit_relax'].includes(d.id)) {
      const setupHeld = { chair: true, table: true, book: copy(PARTITIONED_DESK.setupProps.book) };
      const heldFixture = fixture(setupHeld);
      try {
        heldFixture.run('sit_down'); heldFixture.run('take_book_seated');
        const acquisition = copy(heldFixture.props.snapshot().acquisitionReceipts.book);
        let heldSamples = 0;
        heldFixture.run(d.id, { targetDuration: d.duration + 2.37, microSet: ['gaze_shift', 'finger_release'] }, measured => {
          const h = heldFixture.c; assert.equal(measured.props.book.attachment, 'both');
          assert.deepEqual(measured.acquisitionReceipts.book, acquisition); assert.ok(measured.props.book.gripError < .025);
          if (h.bridge || h.elapsed < d.continuation.start + .5 || h.elapsed > h.duration - d.duration + d.continuation.end - .5) return;
          for (const side of ['L', 'R']) assert.ok(h.pose.continuation.micro.suppressed.includes(`finger_release:${side}:contact`));
          assert.ok(!h.pose.continuation.micro.applied.includes('finger_release')); heldSamples++;
        });
        assert.ok(heldSamples > 30); result.inheritedBookSamples = heldSamples;
      } finally { heldFixture.props.dispose(); }
    }
    result.suppression = [...new Set(result.suppression)]; result.applied = [...new Set(result.applied)]; result.pass = true;
  } catch (error) { result.error = error.stack; throw error; }
  finally { props.dispose(); report.rows.push(result); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
});
