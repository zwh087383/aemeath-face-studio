import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_IDS, ACTIVITY_LIBRARY, ACTIVITY_CATEGORIES, ACTIVITY_SEQUENCES, sampleActivity } from '../preview/core/activity-library.js';

const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
function allFinite(value, path = '') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${path}`);
  else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) allFinite(v, `${path}.${key}`);
}
const frames = id => Array.from({ length: Math.ceil(ACTIVITY_LIBRARY[id].duration * 120) + 1 }, (_, i) => sampleActivity(id, Math.min(i / 120, ACTIVITY_LIBRARY[id].duration)));

test('all public physical activities carry explicit support requirements and valid finite samples', () => {
  assert.ok(ACTIVITY_IDS.length >= 60);
  assert.equal(new Set(ACTIVITY_IDS).size, ACTIVITY_IDS.length);
  for (const id of ACTIVITY_IDS) {
    const d = ACTIVITY_LIBRARY[id];
    assert.equal(d.id, id); assert.ok(ACTIVITY_CATEGORIES[d.category]); assert.ok(d.duration > 1 && d.duration <= 12);
    assert.ok(['standing', 'seated'].includes(d.initialSupport)); assert.ok(['standing', 'seated'].includes(d.endSupport));
    assert.ok(Object.isFrozen(d));
    for (const p of frames(id)) {
      allFinite(p); assert.ok(['standing', 'seated', 'airborne'].includes(p.support));
      for (const side of ['L', 'R']) {
        assert.ok(Math.abs(Math.hypot(...p.feet[side].rotation) - 1) < 1e-6, `${id}: foot quaternion`);
        assert.equal(typeof p.feet[side].contact, 'boolean');
        assert.ok(p.feet[side].position[1] >= 1.41126 - 1e-6, `${id}: foot below floor`);
      }
    }
  }
});

test('plant contacts are world-fixed through translation, turns, sitting and exercises', () => {
  for (const id of ACTIVITY_IDS) {
    const seq = frames(id);
    for (let i = 1; i < seq.length; i++) for (const side of ['L', 'R']) {
      const a = seq[i - 1].feet[side], b = seq[i].feet[side];
      if (a.contact && b.contact) {
        assert.ok(distance(a.position, b.position) < 1e-7, `${id} ${side} slides while planted at ${seq[i].time}`);
        assert.ok(distance(a.rotation, b.rotation) < 1e-7, `${id} ${side} twists while planted at ${seq[i].time}`);
      }
    }
  }
});

test('directional locomotion physically translates root and finishes with both feet planted', () => {
  const expected = {
    walk_forward: [0, 0, 18], walk_backward: [0, 0, -11], walk_left: [10, 0, 0], walk_right: [-10, 0, 0],
    walk_forward_left: [10, 0, 12], walk_forward_right: [-10, 0, 12], walk_back_left: [7, 0, -8], walk_back_right: [-7, 0, -8],
  };
  for (const [id, endpoint] of Object.entries(expected)) {
    const d = ACTIVITY_LIBRARY[id], seq = frames(id), final = sampleActivity(id, d.duration);
    assert.ok(distance(final.root.position, endpoint) < 1e-9, id);
    assert.deepEqual(sampleActivity(id, d.duration + 100).root, final.root, `${id} must not snap back on completion`);
    for (const side of ['L', 'R']) {
      assert.equal(final.feet[side].contact, true);
      assert.ok(seq.some(p => !p.feet[side].contact));
      assert.ok(Math.max(...seq.map(p => p.feet[side].position[1])) > 1.8);
    }
    assert.ok(seq.some(p => p.feet.L.contact && !p.feet.R.contact));
    assert.ok(seq.some(p => p.feet.R.contact && !p.feet.L.contact));
  }
});

test('turning changes facing through separate planted steps instead of pivot-sliding both soles', () => {
  for (const [id, yaw] of [['turn_left', Math.PI / 2], ['turn_right', -Math.PI / 2], ['turn_around', Math.PI]]) {
    const d = ACTIVITY_LIBRARY[id], p = sampleActivity(id, d.duration);
    assert.ok(Math.abs(p.root.yaw - yaw) < 1e-9);
    assert.ok(frames(id).filter(f => !f.feet.L.contact || !f.feet.R.contact).length > 120);
    assert.equal(p.feet.L.contact, true); assert.equal(p.feet.R.contact, true);
  }
});

test('running includes alternating foot flight, body travel and a stable finishing stance', () => {
  for (const id of ['run_forward', 'jog_forward', 'jog_in_place']) {
    const d = ACTIVITY_LIBRARY[id], seq = frames(id), end = sampleActivity(id, d.duration);
    assert.ok(seq.some(p => p.support === 'airborne' && !p.feet.L.contact && !p.feet.R.contact), id);
    assert.ok(seq.some(p => p.support === 'standing' && (p.feet.L.contact || p.feet.R.contact)), id);
    assert.ok(Math.max(...seq.map(p => p.feet.L.position[1])) > 2.8);
    assert.equal(end.feet.L.contact, true); assert.equal(end.feet.R.contact, true);
    assert.equal(end.support, 'standing');
  }
  assert.equal(sampleActivity('run_forward', 4).root.position[2], 26);
  assert.equal(sampleActivity('jog_forward', 4.5).root.position[2], 18);
});

test('ordinary walking uses visible strides and running is faster without deep support crouches', () => {
  const peakSpeed = id => {
    const f = frames(id); let maximum = 0;
    for (let i = 1; i < f.length; i++) maximum = Math.max(maximum, distance(f[i].root.position, f[i - 1].root.position) / (f[i].time - f[i - 1].time));
    return maximum;
  };
  assert.ok(sampleActivity('walk_forward', 4.8).root.position[2] >= 16, 'six ordinary strides need substantial forward travel');
  assert.ok(peakSpeed('run_forward') > peakSpeed('walk_forward') * 1.8, 'running needs materially greater travel speed');
  for (const id of ['walk_forward', 'walk_left', 'walk_curve_right', 'jog_forward', 'run_forward']) {
    assert.ok(Math.min(...frames(id).map(p => p.pelvis.offset[1])) > -.8, `${id}: longer steps must not become a crouch walk`);
  }
});

test('every jump has anticipation, true root lift, two unplanted feet and absorption before rest', () => {
  for (const id of ACTIVITY_IDS.filter(id => ACTIVITY_LIBRARY[id].category === 'jumping')) {
    const d = ACTIVITY_LIBRARY[id], seq = frames(id), final = sampleActivity(id, d.duration);
    assert.ok(seq.some(p => p.phase === 'crouch' && p.pelvis.offset[1] < -.5), id);
    assert.ok(Math.max(...seq.map(p => p.root.position[1])) >= .99, id);
    const flying = seq.filter(p => p.support === 'airborne'); assert.ok(flying.length > 40, id);
    assert.ok(flying.every(p => !p.feet.L.contact && !p.feet.R.contact), id);
    assert.ok(seq.some(p => p.phase === 'absorb' && p.pelvis.offset[1] < -.4), id);
    assert.equal(final.support, 'standing'); assert.equal(final.root.position[1], 0);
    assert.equal(final.feet.L.contact, true); assert.equal(final.feet.R.contact, true);
  }
});

test('gait and chair approach stay inside measured PMX leg reach without sliding targets', () => {
  for (const id of ACTIVITY_IDS.filter(id => ['gait', 'carry', 'sit_down'].includes(ACTIVITY_LIBRARY[id].kind))) {
    for (const p of frames(id)) for (const [side, sign] of [['L', 1], ['R', -1]]) {
      const h = [sign * .9034266 + p.pelvis.offset[0], 11.178317 + p.pelvis.offset[1], -.118098 + p.pelvis.offset[2]], y = p.root.yaw;
      const hip = [h[0] * Math.cos(y) + h[2] * Math.sin(y), h[1], -h[0] * Math.sin(y) + h[2] * Math.cos(y)].map((v, i) => v + p.root.position[i]);
      assert.ok(distance(hip, p.feet[side].position) <= 9.82994, `${id} ${side} reach ${distance(hip, p.feet[side].position)} at ${p.time}`);
    }
  }
});

test('sitting remains seated at completion and standing transfers weight over fixed feet', () => {
  for (const id of ['sit_down', 'sit_down_carefully']) {
    const d = ACTIVITY_LIBRARY[id], p = sampleActivity(id, d.duration);
    assert.equal(p.support, 'seated'); assert.equal(p.endSupport, 'seated'); assert.ok(p.pelvis.offset[1] < -4);
    assert.equal(p.props.chair, true); assert.deepEqual(sampleActivity(id, d.duration + 100).pelvis, p.pelvis);
  }
  for (const id of ACTIVITY_IDS.filter(id => ACTIVITY_LIBRARY[id].initialSupport === 'seated')) assert.equal(sampleActivity(id, 0).support, 'seated');
  const up = sampleActivity('stand_up', ACTIVITY_LIBRARY.stand_up.duration);
  assert.equal(up.support, 'standing'); assert.equal(up.pelvis.offset[1], 0); assert.ok(up.root.position[2] > 4);
  assert.equal(up.feet.L.position[2], 3.3); assert.equal(up.feet.R.position[2], 3.3);
});

test('reading, writing, drinking and carrying provide explicit visible props and meaningful changes', () => {
  const reading = sampleActivity('read_seated', 2);
  assert.equal(reading.support, 'seated'); assert.equal(reading.props.book.attachment, 'both'); assert.ok(reading.body.headPitch > .1);
  assert.ok(sampleActivity('page_turn_seated', 3).props.book.pageTurn > .1);
  assert.ok(sampleActivity('close_book', 5).props.book.openness < .001);
  assert.ok(distance(sampleActivity('page_turn_seated', 2).hands.R.hand, sampleActivity('page_turn_seated', 2.7).hands.R.hand) > .6);
  assert.equal(sampleActivity('write_at_desk', 2).props.pencil.attachment, 'right');
  assert.equal(sampleActivity('type_at_desk', 2).props.laptop.visible, true);
  assert.ok(sampleActivity('drink_standing', 3).hands.R.hand[1] > 16);
  assert.equal(sampleActivity('carry_box', 2).props.box.attachment, 'both');
  assert.ok(sampleActivity('carry_box', 4.4).root.position[2] < -6);
});

test('carrying backs away on the safe side of the retained pickup table', () => {
  const pickupEnd = sampleActivity('pickup_box', ACTIVITY_LIBRARY.pickup_box.duration);
  const table = pickupEnd.props.table, tableFront = table.position[2] - 5 / 2;
  assert.equal(table.visible, true, 'pickup furniture must remain visible');
  let previousZ = 0;
  for (const p of frames('carry_box')) {
    assert.ok(p.root.position[2] <= previousZ + 1e-9, `carry must never advance toward the table at ${p.time}`);
    assert.ok(p.root.position[2] <= tableFront - 1.5, 'the body root must stay behind the near edge with clearance');
    assert.equal(p.props.box.attachment, 'both'); assert.equal(p.props.box.visible, true);
    assert.notEqual(p.props.table, false, 'carrying must not hide the table to conceal a collision');
    previousZ = p.root.position[2];
  }
  assert.equal(previousZ, -6.5);
});

test('exercise uses distinct leg and weight patterns with recovery', () => {
  assert.ok(sampleActivity('squat', 3).pelvis.offset[1] < -2);
  const left = sampleActivity('lunge_left', 3), right = sampleActivity('lunge_right', 3);
  assert.ok(left.feet.L.position[2] > 2.8 && left.feet.R.position[2] < 0);
  assert.ok(right.feet.R.position[2] > 2.8 && right.feet.L.position[2] < 0);
  assert.equal(sampleActivity('balance_left', 3).feet.L.contact, false);
  assert.equal(sampleActivity('balance_left', 3).feet.R.contact, true);
  for (const id of ACTIVITY_IDS.filter(id => ACTIVITY_LIBRARY[id].category === 'exercise')) {
    const p = sampleActivity(id, ACTIVITY_LIBRARY[id].duration);
    assert.equal(p.support, 'standing'); assert.ok(Math.abs(p.pelvis.offset[1]) < 1e-8);
    assert.ok(p.feet.L.contact && p.feet.R.contact);
  }
});

test('long activity sequences reference real clips and preserve explicit seat transitions', () => {
  assert.ok(Object.keys(ACTIVITY_SEQUENCES).length >= 7);
  for (const [name, sequence] of Object.entries(ACTIVITY_SEQUENCES)) {
    let support = 'standing';
    for (const id of sequence.steps) {
      const d = ACTIVITY_LIBRARY[id]; assert.ok(d, `${name}: ${id}`);
      assert.equal(d.initialSupport, support, `${name}: support transition into ${id}`); support = d.endSupport;
    }
  }
});

test('invalid sampler requests fail clearly and samples cannot mutate authored definitions', () => {
  assert.throws(() => sampleActivity('missing', 0), /Unknown activity/);
  for (const id of ['constructor', '__proto__', 'toString']) assert.throws(() => sampleActivity(id, 0), /Unknown activity/);
  assert.throws(() => sampleActivity('walk_forward', NaN), /finite/);
  const p = sampleActivity('walk_forward', 0); p.root.position[2] = 100;
  assert.equal(sampleActivity('walk_forward', 0).root.position[2], 0);
  assert.deepEqual(sampleActivity('sit_down', -4), sampleActivity('sit_down', 0));
});

test('table pickup meets the real PMX palm anchors before the box changes ownership', async () => {
  const { readFileSync } = await import('node:fs');
  const { skeletonFromInspection } = await import('../preview/core/motion-skeleton.js');
  const { buildFullBodyRig, solveFullBodyPose } = await import('../preview/core/full-body-ik.js');
  const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
  const rig = buildFullBodyRig(skeleton), mid = ACTIVITY_LIBRARY.pickup_box.duration / 2;
  const before = sampleActivity('pickup_box', mid - 1e-8, rig.context), after = sampleActivity('pickup_box', mid, rig.context);
  assert.equal(before.props.box.attachment, 'table'); assert.equal(after.props.box.attachment, 'both');
  assert.equal(after.props.box.fitToHands, false, 'taking ownership must not resize the box');
  const fk = new Map(); solveFullBodyPose(rig, after, new Map(), fk);
  for (const [prefix, sign] of [['左', 1], ['右', -1]]) {
    const wrist = fk.get(`${prefix}手首`).position, middle = fk.get(`${prefix}中指１`).position;
    const palm = wrist.map((v, i) => v + .45 * (middle[i] - v));
    const contact = before.props.box.position.map((v, i) => v + [2.15 * sign, 1.5, 0][i]);
    assert.ok(distance(palm, contact) < .02, `${prefix} pickup contact gap ${distance(palm, contact)}`);
  }
});

test('desk exit retreats the seat before standing and actual PMX legs stay clear of the retained tabletop and seat', async () => {
  const { readFileSync } = await import('node:fs');
  const { skeletonFromInspection } = await import('../preview/core/motion-skeleton.js');
  const { buildFullBodyRig, solveFullBodyPose, toWorld } = await import('../preview/core/full-body-ik.js');
  const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
  const rig = buildFullBodyRig(skeleton);
  const intersects = (a, b, low, high, radius = 0) => {
    let entry = 0, exit = 1;
    for (let axis = 0; axis < 3; axis++) {
      const min = low[axis] - radius, max = high[axis] + radius, direction = b[axis] - a[axis];
      if (Math.abs(direction) < 1e-10) { if (a[axis] <= min || a[axis] >= max) return false; continue; }
      const u = (min - a[axis]) / direction, v = (max - a[axis]) / direction;
      entry = Math.max(entry, Math.min(u, v)); exit = Math.min(exit, Math.max(u, v));
      if (entry >= exit - 1e-9) return false;
    }
    return exit > entry + 1e-9;
  };
  let sawLeftLift = false, sawRightLift = false;
  for (const p of frames('stand_up_from_desk')) {
    assert.equal(Object.hasOwn(p.props, 'table'), false, 'desk exit must neither remove nor reposition the existing table');
    assert.equal(p.props.chair.visible, true);
    assert.ok(Math.abs(p.props.chair.position[2] - (-1.2 + p.seatOffset[2])) < 1e-9);
    const fk = new Map(), diagnostic = solveFullBodyPose(rig, p, new Map(), fk);
    const tabletopMin = [-5, 8.35, 1.8], tabletopMax = [5, 8.9, 6.8];
    const chairZ = p.props.chair.position[2], chairMin = [-3.3, 5.5, chairZ - 2.6], chairMax = [3.3, 6.1, chairZ + 2.6];
    const pelvis = toWorld(p.root, fk.get(rig.support.root).position);
    assert.equal(intersects(pelvis, pelvis, tabletopMin, tabletopMax, .55), false, `pelvis enters table at ${p.time}`);
    for (const side of ['L', 'R']) {
      const names = rig.legs[side].names;
      const [hip, knee, ankle] = [names.hip, names.knee, names.ankle].map(name => toWorld(p.root, fk.get(name).position));
      assert.ok(diagnostic.legs[side].error < 1e-6, `${side} desk exit loses foot target at ${p.time}`);
      for (const [a, b] of [[hip, knee], [knee, ankle]]) {
        assert.equal(intersects(a, b, tabletopMin, tabletopMax, .35), false, `${side} leg enters table at ${p.time}`);
        if (p.support === 'standing') assert.equal(intersects(a, b, chairMin, chairMax, .12), false, `${side} standing leg enters seat at ${p.time}`);
      }
    }
    if (p.time < 3.35) {
      assert.equal(p.support, 'seated');
      sawLeftLift ||= !p.feet.L.contact && p.feet.R.contact;
      sawRightLift ||= !p.feet.R.contact && p.feet.L.contact;
    } else assert.equal(p.seatOffset[2], -3.5);
  }
  assert.ok(sawLeftLift && sawRightLift, 'seated retreat must move feet separately');
  const end = sampleActivity('stand_up_from_desk', ACTIVITY_LIBRARY.stand_up_from_desk.duration);
  assert.equal(end.support, 'standing'); assert.ok(Math.abs(end.root.position[2] - .905294) < 1e-6);
  assert.equal(end.props.chair.position[2], -4.7); assert.ok(end.feet.L.contact && end.feet.R.contact);
  assert.equal(ACTIVITY_SEQUENCES.desk_session.steps.at(-1), 'stand_up_from_desk');
  // Negative control: the original chair-only stand-up does enter this same
  // tabletop. Keep that clip unchanged, but prove this geometry gate catches it.
  const unsafe = sampleActivity('stand_up', 1.56, rig.context), oldFk = new Map();
  solveFullBodyPose(rig, unsafe, new Map(), oldFk);
  const oldHip = toWorld(unsafe.root, oldFk.get(rig.legs.L.names.hip).position);
  const oldKnee = toWorld(unsafe.root, oldFk.get(rig.legs.L.names.knee).position);
  assert.equal(intersects(oldHip, oldKnee, [-5, 8.35, 1.8], [5, 8.9, 6.8], .35), true);
});
