import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../scripts/character-center/audit-held-variants.mjs';
import { validateActivityRoute, needsActivityRouteCheck } from '../preview/core/activity-route-access.js';
import { ACTIVITY_LIBRARY } from '../preview/core/activity-library.js';
import { qeuler } from '../preview/core/motion-math.js';

function inspect(id, setup, options = {}) {
  const f = fixture(setup);
  try {
    // Build the isolated source for this module test. Public play/preparePlay
    // use the same preflight and must reject this negative route once wired.
    f.c.start({ id, options: { loop: false, speed: 1, context: {}, ...options } });
    const before = f.c.snapshot(), props = f.props.snapshot(), result = validateActivityRoute(f.c);
    assert.deepEqual(f.c.snapshot(), before, 'route inspection mutated controller');
    assert.deepEqual(f.props.snapshot(), props, 'route inspection moved physical furniture');
    return result;
  } finally { f.props.dispose(); }
}

test('actual PMX thigh crossing the retained tabletop is rejected before the live route starts', () => {
  const result = inspect('walk_forward', { table: true });
  assert.equal(result.accepted, false); assert.equal(result.reason, 'activity_route_blocked_by_table');
  assert.match(result.bodyPart, /thigh/); assert.match(result.part, /tabletop|table-edge/);
  assert.ok(result.sourceTime < 1.2); assert.equal(result.phase, 'source');
});

test('both public preparation and direct play reject a blocked route without changing ownership or furniture', () => {
  const f = fixture({ table: true });
  try {
    const before = f.c.snapshot(), props = f.props.snapshot();
    const result = f.c.preparePlay('walk_forward');
    assert.equal(result.accepted, false); assert.equal(result.reason, 'activity_route_blocked_by_table');
    assert.equal(f.c.routeAdmission('walk_forward').reason, result.reason);
    assert.equal(f.c.play('walk_forward'), false);
    assert.deepEqual(f.c.snapshot(), before); assert.deepEqual(f.props.snapshot(), props);
    assert.equal(f.c.play('walk_backward'), true, 'a rejected front route must not poison a safe next choice');
  } finally { f.props.dispose(); }
});

for (const [id, z] of [['chair', 8], ['box', 5], ['platform', 4]]) {
  test(`forward route checks actual ${id} solids at their measured location`, () => {
    const result = inspect('walk_forward', { [id]: { visible: true, attachment: 'floor', position: [0, 0, z] } });
    assert.equal(result.accepted, false); assert.equal(result.reason, `activity_route_blocked_by_${id}`);
    assert.ok(result.samples > 0); assert.match(result.bodyPart, /L:|R:|torso/);
    const clear = inspect('walk_forward', { [id]: { visible: true, attachment: 'floor', position: [14, 0, z] } });
    assert.equal(clear.accepted, true, JSON.stringify(clear));
  });
}

test('real table orientation and translation change collision, rather than assuming origin-aligned furniture', () => {
  const rotated = { visible: true, attachment: 'floor',
    worldTransform: { position: [0, 0, 7], quaternion: qeuler(0, Math.PI / 2, 0) } };
  assert.equal(inspect('walk_forward', { table: rotated }).reason, 'activity_route_blocked_by_table');
  rotated.worldTransform.position[0] = 14;
  assert.equal(inspect('walk_forward', { table: rotated }).accepted, true);
});

test('a clear backward exit beside the original table is preserved without changing its path', () => {
  const result = inspect('walk_backward', { table: true });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.ok(result.samples > 100);
});

test('all existing gait and jump sources remain callable in clear single-character space', () => {
  for (const [id, definition] of Object.entries(ACTIVITY_LIBRARY)) {
    if (!['gait', 'jump'].includes(definition.kind)) continue;
    assert.equal(needsActivityRouteCheck(definition), true);
    const result = inspect(id, { table: { visible: true, attachment: 'floor', position: [50, 0, 50] } });
    assert.equal(result.accepted, true, `${id}: ${JSON.stringify(result)}`);
  }
});

test('deliberate seated/desk contact and step-up do not use a generic route veto', () => {
  for (const id of ['sit_down', 'approach_desk_seated', 'stand_up_from_desk', 'read_seated', 'type_at_desk', 'step_up']) {
    if (ACTIVITY_LIBRARY[id]) assert.equal(needsActivityRouteCheck(ACTIVITY_LIBRARY[id]), false, id);
  }
});

test('visible but unmeasured furniture is refused, and hidden furniture is not invented', () => {
  const f = fixture({});
  try {
    assert.equal(f.c.play('walk_forward'), true);
    f.c.sceneProps.table = { visible: true, attachment: 'floor' };
    assert.equal(validateActivityRoute(f.c).reason, 'activity_route_unmeasured_obstacle');
    f.c.sceneProps.table.visible = false;
    assert.equal(validateActivityRoute(f.c).accepted, true);
  } finally { f.props.dispose(); }
});

test('safe completed desk retreat retains the existing side-step and turn route', () => {
  const f = fixture({ table: true, chair: true });
  try {
    f.run('sit_down'); f.run('approach_desk_seated');
    f.run('stand_up_from_desk', { context: { deskLayout: 'partitioned', deskRetreat: 7 } });
    for (const id of ['walk_left', 'turn_around', 'walk_forward']) {
      assert.equal(f.c.play(id), true);
      const result = validateActivityRoute(f.c);
      assert.equal(result.accepted, true, `${id}: ${JSON.stringify(result)}`);
      for (let n = 0; !f.c.done && n < 1200; n++) f.step();
      assert.equal(f.c.done, true);
    }
  } finally { f.props.dispose(); }
});

test('actual acquired box can retreat from its retained table without colliding with its own held object', () => {
  const f = fixture({ table: true, box: { visible: true, attachment: 'table', position: [0, 8.9, 3.8] } });
  try {
    f.run('pickup_box');
    const receipt = f.props.snapshot().acquisitionReceipts.box;
    assert.equal(receipt.released, true);
    const prepared = f.c.preparePlay('carry_box', { context: { deskLayout: 'partitioned' } });
    assert.equal(prepared.accepted, true, prepared.reason);
    f.run('carry_box');
    assert.equal(f.props.snapshot().props.box.attachment, 'both');
    assert.deepEqual(f.props.snapshot().acquisitionReceipts.box, receipt);
  } finally { f.props.dispose(); }
});
