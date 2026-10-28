import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../scripts/character-center/audit-held-variants.mjs';
import { ACTIVITY_LIBRARY, ACTIVITY_SEQUENCES } from '../preview/core/activity-library.js';
import { PARTITIONED_DESK } from '../preview/core/activity-desk-layout.js';
import { ActivityDirector, initializeEmptyActivityScene } from '../realtime/activities/director.mjs';

for (const support of ['standing', 'seated']) test(`open book ${support} placement includes physical cover closure in measured preparation and receipt`, () => {
  const f = fixture({ table: true, book: structuredClone(PARTITIONED_DESK.setupProps.book), ...(support === 'seated' ? { chair: true } : {}) });
  try {
    if (support === 'seated') f.run('sit_down');
    f.run(`take_book_${support}`); f.run(`read_${support}`);
    const id = `put_book_${support}`, before = f.c.snapshot(), scene = f.props.snapshot();
    const prepared = f.c.preparePlay(id, { context: { deskLayout: 'partitioned' } });
    assert.equal(prepared.accepted, true, prepared.reason);
    assert.equal(prepared.bodySeconds, ACTIVITY_LIBRARY[id].duration + 1.4);
    assert.deepEqual(f.c.snapshot(), before); assert.deepEqual(f.props.snapshot(), scene);
    let closeFrames = 0, maximumGrip = 0, maximumReach = 0;
    f.run(id, {}, row => {
      if (f.c.pose.phase === 'placing-close-book') { closeFrames++; assert.equal(row.placementReceipts.book, undefined); }
      for (const contact of Object.values(f.c.diagnostics.propContacts?.props ?? {})) {
        assert.equal(contact.ready, true); maximumGrip = Math.max(maximumGrip, contact.maximumGripError);
        for (const side of Object.keys(contact.targets)) {
          maximumReach = Math.max(maximumReach, f.c.diagnostics.arms[side].reach);
          assert.ok(f.c.diagnostics.arms[side].reach <= .995001);
        }
      }
    });
    assert.ok(closeFrames >= 40); assert.ok(maximumGrip <= .025);
    const placed = f.props.snapshot(); assert.equal(placed.props.book.attachment, 'table'); assert.equal(placed.props.book.openness, 0);
    assert.equal(placed.placementReceipts.book.released, true);
    console.log(JSON.stringify({ acceptance: 'open-book-physical-placement', support, closeFrames, maximumGrip, maximumReach,
      preparedSeconds: prepared.totalSeconds, sourceSeconds: prepared.bodySeconds }));
  } finally { f.props.dispose(); }
});

test('legacy declared initial scene is created only while empty and existing stage is preserved', () => {
  const f = fixture({}), director = new ActivityDirector(f.c);
  try {
    assert.equal(director.playSequence('reading_break'), false);
    assert.equal(director.lastRejection.reason, 'missing-measured-initial-scene');
    const initialized = initializeEmptyActivityScene(f.c, f.props, ACTIVITY_SEQUENCES.reading_break);
    assert.equal(initialized.initialized, true); assert.equal(f.props.snapshot().props.chair.position[2], -8.2);
    assert.deepEqual(f.c.root, initialized.fixture.initialRoot);
    const before = f.c.snapshot(), scene = f.props.snapshot();
    assert.equal(initializeEmptyActivityScene(f.c, f.props, ACTIVITY_SEQUENCES.desk_session).reason, 'existing_scene_preserved');
    assert.deepEqual(f.c.snapshot(), before); assert.deepEqual(f.props.snapshot(), scene);
    assert.equal(director.playSequence('reading_break'), true, JSON.stringify(director.lastRejection));
  } finally { f.props.dispose(); }
});

test('legacy existing tight desk returns the actual entry obstruction without re-staging objects', () => {
  const f = fixture({ chair: true, table: true }, { safeSeat: false }), director = new ActivityDirector(f.c);
  try {
    const before = f.c.snapshot(), scene = f.props.snapshot();
    assert.equal(director.playSequence('reading_break'), false);
    assert.equal(director.lastRejection.reason, 'seat_entry_space_blocked');
    assert.deepEqual(f.c.snapshot(), before); assert.deepEqual(f.props.snapshot(), scene);
  } finally { f.props.dispose(); }
});
for (const cut of ['closing', 'placing', 'release']) test(`open book placement interruption during ${cut} preserves actual object ownership`, () => {
  const f = fixture({ table: true, book: structuredClone(PARTITIONED_DESK.setupProps.book) });
  try {
    f.run('take_book_standing'); f.run('read_standing');
    assert.equal(f.c.play('put_book_standing', { context: { deskLayout: 'partitioned' } }), true);
    const at = cut === 'closing' ? .7 : cut === 'placing' ? 3.4 : 5.7;
    for (let n = 0; f.c.elapsed < at && n < 600; n++) f.step();
    assert.ok(f.c.elapsed >= at); assert.equal(f.props.snapshot().props.book.attachment, 'both');
    const previousReceipt = f.props.snapshot().placementReceipts.book;
    f.c.stop();
    for (let n = 0; !f.c.done && n < 600; n++) {
      const report = f.step().props.book;
      assert.equal(report.visible, true); assert.equal(report.attachment, 'both');
      assert.deepEqual(report.scale, [1, 1, 1]); assert.ok(report.gripError <= .025);
    }
    assert.equal(f.c.done, true); assert.equal(f.c.queued, null);
    assert.deepEqual(f.props.snapshot().placementReceipts.book, previousReceipt);
    const stopped = f.c.snapshot(); for (let n = 0; n < 30; n++) f.step();
    assert.deepEqual(f.c.snapshot().pose, stopped.pose);
  } finally { f.props.dispose(); }
});
