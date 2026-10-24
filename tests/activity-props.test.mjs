import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { ACTIVITY_PROP_LAYOUT as layout, ACTIVITY_PROP_IDS, readHandAnchor, propGripPair } from '../realtime/activities/prop-layout.mjs';

// Browser resolves the same dependency through its existing import map. Node
// resolves it to the project's installed copy without adding another package.
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { createActivityProps } = await import('../realtime/activities/props.mjs');
hooks.deregister();

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} ~= ${b}`);
const nearPoint = (a, b, eps = 1e-5) => a.forEach((n, i) => near(n, b[i], eps));
const bounds = object => new THREE.Box3().setFromObject(object);
const fixture = () => { const scene = new THREE.Scene(); return { scene, props: createActivityProps(scene) }; };
const palms = { anchors: { leftHand: { position: [1.55, 8.5, 3], quaternion: [0, 0, 0, 1] }, rightHand: { position: [-1.55, 8.5, 3], quaternion: [0, 0, 0, 1] } } };

test('chair seat, table clearance, exercise step and floor contacts match the real avatar scale', () => {
  const { props } = fixture(); props.update({ chair: true, table: true, platform: true, mat: true });
  const seat = bounds(props.objects.chair.getObjectByName('seat'));
  near(seat.max.y, 6.1); near(seat.getCenter(new THREE.Vector3()).z, -1.2);
  assert.ok(seat.max.x - seat.min.x > 6, 'a human-sized usable seat, not a decorative miniature');
  near(bounds(props.objects.table.getObjectByName('tabletop')).max.y, 8.9);
  const gap = bounds(props.objects.table.getObjectByName('tabletop')).min.y - seat.max.y;
  assert.ok(gap > 2 && gap < 3, 'seated lap clearance beneath table');
  near(bounds(props.objects.chair).min.y, 0); near(bounds(props.objects.mat.getObjectByName('exercise-mat')).min.y, 0);
  near(bounds(props.objects.platform.getObjectByName('nonslip-top')).max.y, 1.25);
  assert.ok(bounds(props.objects.chair).max.y > 12, 'back support reaches above the seated torso');
  props.dispose();
});

test('all ten requested props have finite renderable geometry and suitable standalone placement', () => {
  const { props } = fixture(); props.update(Object.fromEntries(ACTIVITY_PROP_IDS.map(id => [id, true])));
  assert.equal(ACTIVITY_PROP_IDS.length, 10);
  for (const id of ACTIVITY_PROP_IDS) {
    const object = props.objects[id], box = bounds(object), size = box.getSize(new THREE.Vector3());
    assert.ok(object.visible && [size.x, size.y, size.z].every(v => Number.isFinite(v) && v > 0), id);
    object.traverse(part => { if (part.geometry) assert.ok(Array.from(part.geometry.attributes.position.array).every(Number.isFinite), `${id} finite vertices`); });
  }
  const tabletop = bounds(props.objects.table.getObjectByName('tabletop')).max.y;
  for (const id of ['book', 'paper', 'laptop', 'mug']) near(bounds(props.objects[id]).min.y, tabletop, .04);
  props.dispose();
});

test('static props stay at the activity-start anchor while the avatar moves', () => {
  const { props } = fixture(), anchor = { position: [8, 0, -3], yaw: Math.PI / 2 };
  props.update({ chair: true, table: true }, { anchor, root: { position: [0, 0, 0] } });
  const before = props.snapshot();
  nearPoint(before.props.chair.position, [6.8, 0, -3]);
  nearPoint(before.props.table.position, [12.3, 0, -3]);
  props.update({ chair: true, table: true }, { anchor, root: { position: [12, 0, 18] } });
  assert.deepEqual(props.snapshot(), before);
  props.dispose();
});

test('furniture survives omitted activity props at its original anchor, but explicit reset clears it', () => {
  const { props } = fixture();
  props.update({ chair: true, table: true, mug: { visible: true, attachment: 'right' } }, palms);
  const before = props.snapshot().props;
  props.update({}, { anchor: { position: [8, 0, 4], yaw: .5 } });
  assert.equal(props.objects.chair.visible, true); assert.equal(props.objects.table.visible, true);
  nearPoint(props.snapshot().props.chair.position, before.chair.position);
  assert.equal(props.objects.mug.visible, false, 'omitted held props do not remain floating');
  props.update({ chair: true }, { anchor: { position: [8, 0, 4], yaw: 0 } });
  nearPoint(props.snapshot().props.chair.position, [8, 0, 2.8]);
  props.update({ chair: false }); assert.equal(props.objects.chair.visible, false); assert.equal(props.objects.table.visible, true);
  props.reset(); assert.ok(Object.values(props.objects).every(o => !o.visible));
  props.update({}); assert.ok(Object.values(props.objects).every(o => !o.visible));
  props.dispose();
});

test('a held book follows both real palm contact points through translations and turns', () => {
  const { props } = fixture();
  for (const [left, right] of [[[1.55, 8.5, 3], [-1.55, 8.5, 3]], [[4, 10, 1.55], [4, 10, -1.55]]]) {
    props.update({ book: { visible: true, attachment: 'both' } }, { anchors: { leftHand: left, rightHand: right } });
    const book = props.objects.book;
    nearPoint(book.localToWorld(new THREE.Vector3(...layout.book.grips.left)).toArray(), left);
    nearPoint(book.localToWorld(new THREE.Vector3(...layout.book.grips.right)).toArray(), right);
    assert.equal(props.snapshot().props.book.measured, true);
  }
  props.dispose();
});

test('mug handle and pencil grip remain exactly on the hand as wrist rotates', () => {
  const { props } = fixture(), quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.45, -.35, .28)).toArray();
  for (const id of ['mug', 'pencil']) {
    props.update({ [id]: { visible: true, attachment: 'right', orientation: 'hand' } }, { anchors: { rightHand: { position: [-2, 13, 3], quaternion } } });
    nearPoint(props.objects[id].localToWorld(new THREE.Vector3(...layout[id].grip)).toArray(), [-2, 13, 3]);
    nearPoint(props.objects[id].getWorldQuaternion(new THREE.Quaternion()).toArray(), quaternion);
  }
  props.dispose();
});

test('a cup stays upright despite PMX wrist axes and tilts only by the authored drinking amount', () => {
  const { props } = fixture(), wrist = { anchors: { rightHand: { position: [-1, 12, 1], quaternion: [1, 0, 0, 0] } } };
  props.update({ mug: { visible: true, attachment: 'right' } }, wrist);
  const mug = props.objects.mug, axis = new THREE.Vector3(0, 1, 0).applyQuaternion(mug.quaternion);
  nearPoint(axis.toArray(), [0, 1, 0]); assert.ok(mug.position.x > -1, 'cup body lies toward the midline from the right-hand handle');
  nearPoint(mug.localToWorld(new THREE.Vector3(...layout.mug.grip)).toArray(), [-1, 12, 1]);
  props.update({ mug: { visible: true, attachment: 'right', rotation: [-.35, 0, 0] } }, wrist);
  const tilted = new THREE.Vector3(0, 1, 0).applyQuaternion(mug.quaternion);
  assert.ok(tilted.y > .9 && tilted.z < -.3, 'a small drink tilt, not an inverted cup'); props.dispose();
});

test('partly open and closed books keep real edge contacts rather than hovering above hands', () => {
  const { props } = fixture();
  for (const openness of [0, .2, .4, .8, 1]) {
    const grips = propGripPair('book', openness), position = new THREE.Vector3(0, 8.5, 3);
    const left = new THREE.Vector3(...grips.left).add(position).toArray(), right = new THREE.Vector3(...grips.right).add(position).toArray();
    props.update({ book: { visible: true, attachment: 'both', openness } }, { anchors: { leftHand: left, rightHand: right } });
    const book = props.objects.book;
    nearPoint(book.localToWorld(new THREE.Vector3(...grips.left)).toArray(), left);
    nearPoint(book.localToWorld(new THREE.Vector3(...grips.right)).toArray(), right);
    assert.deepEqual(book.scale.toArray(), [1, 1, 1], 'cover, pages and spine keep their authored dimensions');
    near(props.snapshot().props.book.gripError, 0);
    props.update({ book: { visible: true, attachment: 'both', openness } }, { anchors: { leftHand: [4, 8.5, 3], rightHand: [-4, 8.5, 3] } });
    assert.deepEqual(book.scale.toArray(), [1, 1, 1], 'wrong hand spacing cannot stretch a book');
    assert.ok(props.snapshot().props.book.gripError > 2, 'incompatible contacts are measured explicitly');
    assert.equal(book.visible, true, 'report the bad grip; hiding is not a trajectory fix');
  }
  props.dispose();
});

test('missing, degenerate or revoked hand anchors cannot leave hovering held objects', () => {
  const { props } = fixture(), state = { book: { visible: true, attachment: 'both' }, mug: { visible: true, attachment: 'right' } };
  props.update(state, palms); assert.equal(props.objects.book.visible, true);
  props.update(state, {}); assert.equal(props.objects.book.visible, false); assert.equal(props.objects.mug.visible, false);
  props.update({ book: state.book }, { anchors: { leftHand: [0, 0, 0], rightHand: [0, 0, 0] } });
  assert.equal(props.objects.book.visible, false);
  props.update(state, palms); props.update({ book: false, mug: false }, palms);
  assert.equal(props.objects.book.visible, false); assert.equal(props.objects.mug.visible, false);
  props.update({ mug: { visible: true, attachment: 'unknown' } }, palms); assert.equal(props.objects.mug.visible, false);
  props.dispose();
});

test('writing keeps the pencil grip on the hand and touches paper when the contact is reachable', () => {
  const { props } = fixture(), hand = [-1, 9.68, 2.4];
  props.update({ paper: true, pencil: { visible: true, attachment: 'right', tipSurface: 'paper' } }, { anchors: { rightHand: hand } });
  nearPoint(props.objects.pencil.localToWorld(new THREE.Vector3(...layout.pencil.grip)).toArray(), hand);
  const contact = props.snapshot().props.pencil.surfaceContact;
  assert.equal(contact.reachable, true); near(contact.error, 0); near(props.objects.pencil.position.y, bounds(props.objects.paper.getObjectByName('sheet')).max.y);
  props.update({ pencil: { visible: true, attachment: 'right', tipSurface: 'paper' } }, { anchors: { rightHand: [-1, 12, 2.4] } });
  assert.equal(props.snapshot().props.pencil.surfaceContact.reachable, false, 'impossible reach is reported, not hidden by stretching the pencil');
  props.dispose();
});

test('palm fallback is measured from real wrist and finger bones, not a fixed world guess', () => {
  const anchor = readHandAnchor({ bones: { leftWrist: [2, 8, 3], leftMiddle1: [2, 8, 5] }, rotations: { leftWrist: [0, 1, 0, 0] } }, 'left');
  nearPoint(anchor.position, [2, 8, 3.9]); assert.equal(anchor.measured, true); assert.deepEqual(anchor.quaternion, [0, 1, 0, 0]);
  assert.equal(readHandAnchor({ bones: { rightWrist: [NaN, 8, 3] } }, 'right'), null);
});

test('page turning and laptop hinges are driven only by the supplied pose, so pause is deterministic', () => {
  const { props } = fixture();
  props.update({ book: { visible: true, openness: 1, pageTurn: .5 }, laptop: { visible: true, openness: 1 } });
  const a = props.objects.book.userData.articulation, hinge = props.objects.laptop.userData.articulation.hinge;
  near(a.turn.rotation.z, Math.PI / 2); assert.equal(a.turn.visible, true); assert.ok(hinge.rotation.x > 1.5);
  const before = props.snapshot();
  props.update({ book: { visible: true, openness: 1, pageTurn: .5 }, laptop: { visible: true, openness: 1 } });
  assert.deepEqual(props.snapshot(), before); near(a.turn.rotation.z, Math.PI / 2);
  props.update({ book: { visible: true, openness: 0 }, laptop: { visible: true, openness: 0 } });
  assert.equal(a.turn.visible, false); assert.ok(Math.abs(a.left.rotation.z) > 1.4); near(hinge.rotation.x, 0);
  props.dispose();
});

test('disposal releases shared render resources once and removes scene objects', () => {
  const { scene, props } = fixture(); let geometryEvents = 0, materialEvents = 0;
  const geometries = new Set(), materials = new Set();
  props.root.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
  geometries.forEach(g => g.addEventListener('dispose', () => geometryEvents++)); materials.forEach(m => m.addEventListener('dispose', () => materialEvents++));
  props.dispose(); props.dispose();
  assert.equal(geometryEvents, geometries.size); assert.equal(materialEvents, materials.size);
  assert.equal(scene.children.length, 0); assert.equal(props.snapshot().disposed, true);
});
