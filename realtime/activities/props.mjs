import * as THREE from 'three';
import { ACTIVITY_PROP_LAYOUT, ACTIVITY_PROP_IDS, finiteVector, normalizePropState, readHandAnchor, propGripPair } from './prop-layout.mjs';

const UP = new THREE.Vector3(0, 1, 0);
const material = (color, roughness = .65, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
function mesh(parent, geometry, surface, position = [0, 0, 0], name = '') {
  const part = new THREE.Mesh(geometry, surface); part.name = name; part.position.set(...position);
  part.castShadow = true; part.receiveShadow = true; parent.add(part); return part;
}
function box(parent, size, surface, position, name) { return mesh(parent, new THREE.BoxGeometry(...size), surface, position, name); }
function softBox(parent, size, radius, surface, position = [0, 0, 0], name = '') {
  const [w, h, d] = size, r = Math.min(radius, w / 2, d / 2), x = -w / 2, y = -d / 2;
  const s = new THREE.Shape(); s.moveTo(x + r, y); s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d); s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -h / 2); g.rotateX(-Math.PI / 2); return mesh(parent, g, surface, position, name);
}
function beam(parent, start, end, radius, surface, name = '') {
  const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end), delta = b.clone().sub(a);
  const object = mesh(parent, new THREE.CylinderGeometry(radius * .9, radius, delta.length(), 12), surface, a.add(b).multiplyScalar(.5).toArray(), name);
  object.quaternion.setFromUnitVectors(UP, delta.normalize()); return object;
}
function lines(parent, color, x, y, z, widths, spacing = .18) {
  const ink = material(color, .95);
  widths.forEach((width, i) => box(parent, [width, .008, .025], ink, [x + width / 2, y, z + i * spacing], 'printed-line'));
}
function group(name) { const result = new THREE.Group(); result.name = name; return result; }
// Box3.setFromObject also includes hidden children (e.g. an idle turning page).
// Contact must use geometry that is actually present in the rendered object.
function visibleBounds(object, inverseFrame = null) {
  const bounds = new THREE.Box3();
  const visit = node => {
    if (!node.visible) return;
    if (node.geometry) {
      node.geometry.computeBoundingBox();
      const transform = inverseFrame ? inverseFrame.clone().multiply(node.matrixWorld) : node.matrixWorld;
      bounds.union(node.geometry.boundingBox.clone().applyMatrix4(transform));
    }
    for (const child of node.children) visit(child);
  };
  visit(object); return bounds;
}

/** Armless upholstered oak chair. The seat surface is the solver contract. */
export function createChair() {
  const result = group('chair'), oak = material(0x96765e), dark = material(0x594b44), fabric = material(0x829d91, .95);
  softBox(result, [6.6, .6, 5.2], .48, fabric, [0, 5.8, 0], 'seat');
  softBox(result, [6.35, .32, 4.95], .35, oak, [0, 5.34, 0], 'seat-frame');
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    beam(result, [x * 2.45, 5.2, z * 1.85], [x * 2.8, .15, z * 2.18], .22, oak, 'chair-leg');
    mesh(result, new THREE.CylinderGeometry(.25, .25, .16, 16), dark, [x * 2.8, .08, z * 2.18], 'leg-foot');
  }
  for (const x of [-2.65, 2.65]) beam(result, [x, 5.2, -1.9], [x, 12.75, -2.75], .2, oak, 'back-upright');
  const back = softBox(result, [6.1, .55, 4.6], .45, fabric, [0, 10.4, -2.35], 'backrest');
  back.rotation.x = Math.PI / 2 - .1;
  beam(result, [-2.72, 12.75, -2.75], [2.72, 12.75, -2.75], .17, oak, 'back-top');
  return result;
}

export function createTable() {
  const result = group('table'), wood = material(0xccac87), edge = material(0xa28164), steel = material(0x505e63, .4, .4);
  softBox(result, [10, .55, 5], .42, wood, [0, 8.625, 0], 'tabletop');
  softBox(result, [9.7, .2, 4.7], .3, edge, [0, 8.25, 0], 'table-edge');
  for (const x of [-3.95, 3.95]) {
    for (const z of [-1.7, 1.7]) beam(result, [x, .18, z], [x, 8.15, z], .15, steel, 'table-leg');
    beam(result, [x, .22, -1.85], [x, .22, 1.85], .16, steel, 'table-foot');
    beam(result, [x, 7.5, -1.7], [x, 7.5, 1.7], .13, steel, 'table-brace');
  }
  beam(result, [-3.95, 7.65, 1.7], [3.95, 7.65, 1.7], .12, steel, 'rear-crossbar');
  return result;
}

/** A real spine and hinged halves/page. No texture download or fixed sprite. */
export function createBook() {
  const result = group('book'), cover = material(0x315e68), gilding = material(0xd0af72, .38, .3), paper = material(0xf5e9cf, .92);
  const left = group('left-leaves'), right = group('right-leaves'); result.add(left, right);
  for (const [part, sign] of [[left, -1], [right, 1]]) {
    softBox(part, [1.68, .09, 2.6], .07, cover, [sign * .86, -.12, 0], 'book-cover');
    softBox(part, [1.57, .15, 2.43], .02, paper, [sign * .84, 0, 0], 'page-block');
    const start = sign < 0 ? -1.48 : .22;
    lines(part, 0x8d8271, start, .081, -.96, [1.1, 1.12, 1.04, .84, 1.1, .93, 1.12, .64], .22);
    box(part, [1.18, .008, .05], gilding, [sign * .84, .082, -1.12], 'chapter-mark');
  }
  box(result, [.12, .2, 2.65], cover, [0, -.08, 0], 'spine');
  const turn = group('turning-page'); result.add(turn);
  const pageSurface = material(0xfff3d9, .92); pageSurface.side = THREE.DoubleSide;
  box(turn, [1.57, .018, 2.43], pageSurface, [.84, .102, 0], 'turning-sheet');
  lines(turn, 0x938876, .22, .113, -.96, [1.08, .97, 1.1, .6, 1.09, .8], .25);
  turn.visible = false; result.userData.articulation = { left, right, turn };
  return result;
}

export function createMug() {
  const result = group('mug'), ceramic = material(0xe4a78d, .25), inner = material(0xf7e6d5, .3), tea = material(0x6b4930, .22);
  mesh(result, new THREE.CylinderGeometry(.55, .48, 1.2, 32, 1, true), ceramic, [0, .65, 0], 'cup-wall');
  mesh(result, new THREE.CylinderGeometry(.48, .48, .1, 32), ceramic, [0, .05, 0], 'cup-base');
  const rim = mesh(result, new THREE.TorusGeometry(.515, .045, 10, 32), inner, [0, 1.25, 0], 'cup-rim'); rim.rotation.x = Math.PI / 2;
  mesh(result, new THREE.CylinderGeometry(.49, .49, .015, 32), tea, [0, 1.14, 0], 'tea-surface');
  const handle = mesh(result, new THREE.TorusGeometry(.37, .105, 10, 24), ceramic, [.68, .72, 0], 'handle'); handle.scale.x = .88;
  return result;
}

export function createPaper() {
  const result = group('paper'), paper = material(0xf3ecd9, .95);
  box(result, [2.9, .045, 2.2], paper, [0, 0, 0], 'sheet');
  lines(result, 0xb2c3be, -1.2, .026, -.7, [2.4, 2.4, 2.4, 2.4, 2.4, 2.4], .25);
  lines(result, 0x68716c, -1.1, .031, -.69, [.73, 1.5, 1.1, .9], .25);
  return result;
}

export function createPencil() {
  const result = group('pencil'), paint = material(0xd0a549), graphite = material(0x333941), wood = material(0xd1af87), metal = material(0xa3b1b6, .28, .6);
  mesh(result, new THREE.CylinderGeometry(.055, .055, 1.48, 6), paint, [0, .91, 0], 'pencil-body');
  mesh(result, new THREE.ConeGeometry(.055, .22, 6), wood, [0, .13, 0], 'wood-tip').rotation.z = Math.PI;
  mesh(result, new THREE.ConeGeometry(.025, .09, 6), graphite, [0, .035, 0], 'graphite').rotation.z = Math.PI;
  mesh(result, new THREE.CylinderGeometry(.06, .06, .12, 12), metal, [0, 1.7, 0], 'ferrule');
  mesh(result, new THREE.CylinderGeometry(.055, .055, .12, 12), material(0xd9a19a), [0, 1.81, 0], 'eraser');
  return result;
}

export function createLaptop() {
  const result = group('laptop'), alloy = material(0x87989f, .35, .65), dark = material(0x28383e), keys = material(0x405158);
  softBox(result, [4.25, .22, 2.8], .16, alloy, [0, .11, 0], 'base');
  softBox(result, [1.2, .012, .65], .08, dark, [0, .226, -.8], 'touchpad');
  for (let row = 0; row < 4; row++) for (let col = 0; col < 11; col++) {
    softBox(result, [.255, .028, .205], .03, keys, [(col - 5) * .32, .236, -.2 + row * .31], 'key');
  }
  const hinge = group('screen-hinge'); hinge.position.set(0, .22, 1.3); result.add(hinge);
  softBox(hinge, [4.25, .15, 2.8], .16, alloy, [0, 0, -1.4], 'lid');
  box(hinge, [3.88, .018, 2.37], material(0x192f3b, .5), [0, -.086, -1.45], 'screen');
  // Screen shapes face toward the viewer/person on the negative-Z side.
  for (let i = 0; i < 4; i++) box(hinge, [2.6 - i * .27, .022, .06], material(i ? 0x6c9396 : 0xb4c2a5), [-.35, -.101, -2.25 + i * .32], 'screen-content');
  box(hinge, [.55, .022, 1.75], material(0x365460), [1.44, -.101, -1.45], 'screen-sidebar');
  hinge.rotation.x = 1.7; result.userData.articulation = { hinge }; return result;
}

export function createPlatform() {
  const result = group('platform'), body = material(0x4c7375), top = material(0x87aba3, .95), accent = material(0xe2cba1);
  softBox(result, [7, 1.15, 4.4], .38, body, [0, .575, 0], 'step-body');
  softBox(result, [6.8, .1, 4.2], .3, top, [0, 1.2, 0], 'nonslip-top');
  for (const z of [-1.65, -1.1, -.55, 0, .55, 1.1, 1.65]) box(result, [5.8, .008, .035], accent, [0, 1.253, z], 'traction-line');
  return result;
}

export function createMat() {
  const result = group('mat'), rubber = material(0x79939e, .98), edge = material(0xb0c4be, .98);
  softBox(result, [8.2, .08, 13], .58, rubber, [0, .04, 0], 'exercise-mat');
  for (const x of [-3.65, 3.65]) box(result, [.035, .005, 11.6], edge, [x, .083, 0], 'mat-border');
  for (const z of [-5.9, 5.9]) box(result, [7.3, .005, .035], edge, [0, .083, z], 'mat-border');
  return result;
}

export function createCarryBox() {
  const result = group('box'), card = material(0xbf9c73, .95), edge = material(0x9e7b59, .92), tape = material(0xd8bf91, .7);
  softBox(result, [4.3, 3, 3.5], .1, card, [0, 1.5, 0], 'carry-box');
  box(result, [.4, .018, 3.48], tape, [0, 3.012, 0], 'top-tape');
  for (const z of [-1.754, 1.754]) box(result, [.4, 2.96, .012], tape, [0, 1.5, z], 'tape');
  for (const x of [-2.157, 2.157]) {
    box(result, [.015, .22, .9], edge, [x, 2.1, 0], 'hand-slot');
    box(result, [.018, .055, .65], card, [x * 1.001, 2.1, 0], 'slot-highlight');
  }
  box(result, [1.15, .7, .015], material(0xeae1c8), [-.85, 1.6, 1.76], 'label');
  return result;
}

const BUILDERS = { chair: createChair, table: createTable, book: createBook, mug: createMug, paper: createPaper,
  pencil: createPencil, laptop: createLaptop, platform: createPlatform, mat: createMat, box: createCarryBox };

/** Props are a renderer layer, never an independent action clock. Calling
 * update with the same paused controller snapshot freezes every hinge/page.
 * The scene must supply measured world anchors AFTER applying avatar bones.
 */
export function createActivityProps(scene) {
  const root = group('activity-props'); scene.add(root);
  const objects = Object.fromEntries(ACTIVITY_PROP_IDS.map(id => [id, BUILDERS[id]()]));
  Object.values(objects).forEach(object => { object.visible = false; root.add(object); });
  const reports = {}, transferHistory = new Map(), placed = new Map(), acquired = new Map(); let disposed = false;
  const position = new THREE.Vector3(), offset = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const localRotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1), matrix = new THREE.Matrix4();
  const xAxis = new THREE.Vector3(), yAxis = new THREE.Vector3(), zAxis = new THREE.Vector3();
  const gripAxis = new THREE.Vector3(), gripUp = new THREE.Vector3(), gripNormal = new THREE.Vector3(), gripRotation = new THREE.Quaternion();
  const yawQuaternion = new THREE.Quaternion();

  function clear(ids = ACTIVITY_PROP_IDS) {
    for (const id of ids) if (objects[id]) {
      objects[id].visible = false;
      transferHistory.delete(id); placed.delete(id); acquired.delete(id);
      if (reports[id]) reports[id] = { ...reports[id], visible: false, attached: false, reason: 'cleared' };
    }
  }

  function place(object, state, avatar, id) {
    const spec = ACTIVITY_PROP_LAYOUT[id], attach = state.attachment;
    position.set(0, 0, 0); rotation.identity(); scale.set(1, 1, 1);
    let contact = null, measured = null, surfaceContact = null;
    if (['left', 'right', 'both'].includes(attach)) {
      const left = readHandAnchor(avatar, 'left'), right = readHandAnchor(avatar, 'right');
      if (attach === 'both') {
        if (!left || !right) return { attached: false, reason: 'missing-hand-anchor' };
        position.fromArray(left.position).add(new THREE.Vector3(...right.position)).multiplyScalar(.5);
        xAxis.fromArray(left.position).sub(new THREE.Vector3(...right.position));
        const span = xAxis.length(); if (span < .1) return { attached: false, reason: 'coincident-hand-anchors' };
        xAxis.normalize(); yAxis.copy(UP).addScaledVector(xAxis, -UP.dot(xAxis));
        if (yAxis.lengthSq() < .01) yAxis.set(0, 0, 1).addScaledVector(xAxis, -xAxis.z);
        yAxis.normalize(); zAxis.crossVectors(xAxis, yAxis).normalize(); matrix.makeBasis(xAxis, yAxis, zAxis); rotation.setFromRotationMatrix(matrix);
        const grip = propGripPair(id, state.openness);
        if (grip) {
          gripAxis.fromArray(grip.left).sub(new THREE.Vector3(...grip.right));
          // Geometry is fixed-size. Mismatched grips are reported and corrected
          // by the real avatar trajectory solver; never stretch a book or box.
          gripAxis.multiply(scale).normalize(); gripUp.copy(UP).addScaledVector(gripAxis, -UP.dot(gripAxis)).normalize();
          gripNormal.crossVectors(gripAxis, gripUp).normalize();
          gripRotation.setFromRotationMatrix(matrix.makeBasis(gripAxis, gripUp, gripNormal)).invert(); rotation.multiply(gripRotation);
        }
        contact = [left.position, right.position]; measured = left.measured && right.measured;
      } else {
        const hand = attach === 'left' ? left : right; if (!hand) return { attached: false, reason: 'missing-hand-anchor' };
        position.fromArray(hand.position); rotation.fromArray(hand.quaternion).normalize();
        // PMX wrist axes are anatomical axes, not the cup's upright axis. The
        // measured palm still owns the handle position; authored tilt controls
        // drinking without accidentally turning a full cup upside down.
        if (id === 'mug' && state.orientation !== 'hand') rotation.setFromAxisAngle(UP,
          (Number.isFinite(avatar?.anchor?.yaw) ? avatar.anchor.yaw : 0) + (attach === 'right' ? Math.PI : 0));
        contact = hand.position; measured = hand.measured;
      }
      if (finiteVector(state.orientationQuaternion, 4)) {
        rotation.fromArray(state.orientationQuaternion).normalize();
        if (state.orientationSpace !== 'world') rotation.premultiply(yawQuaternion.setFromAxisAngle(UP, avatar?.anchor?.yaw ?? 0));
      }
      if (finiteVector(state.rotation) && !finiteVector(state.orientationQuaternion, 4)) localRotation.setFromEuler(new THREE.Euler(...state.rotation));
      else localRotation.identity();
      if (id === 'mug' && state.orientation !== 'hand') rotation.premultiply(localRotation);
      else rotation.multiply(localRotation);
      if (id === 'pencil' && state.tipSurface === 'paper' && attach !== 'both' && !finiteVector(state.orientationQuaternion, 4)) {
        const paper = objects.paper, top = paper.position.y + ACTIVITY_PROP_LAYOUT.paper.size[1] / 2;
        const gripLength = (finiteVector(state.grip) ? state.grip : spec.grip)[1], rise = position.y - top;
        const reachable = paper.visible && rise >= 0 && rise <= gripLength;
        if (reachable) {
          const axis = UP.clone().applyQuaternion(rotation), horizontal = new THREE.Vector3(axis.x, 0, axis.z);
          if (horizontal.lengthSq() < 1e-8) horizontal.set(0, 0, -1); horizontal.normalize();
          const vertical = rise / gripLength, target = horizontal.multiplyScalar(Math.sqrt(Math.max(0, 1 - vertical * vertical))); target.y = vertical;
          rotation.premultiply(localRotation.setFromUnitVectors(axis, target));
        }
        surfaceContact = { targetY: top, reachable };
      }
      if (attach === 'both') {
        const grip = propGripPair(id, state.openness);
        if (grip) offset.fromArray(grip.left).add(new THREE.Vector3(...grip.right)).multiplyScalar(.5);
        else offset.set(0, 0, 0);
        position.sub(offset.multiply(scale).applyQuaternion(rotation));
      } else {
        offset.fromArray(finiteVector(state.grip) ? state.grip : spec.grip ?? [0, 0, 0]).applyQuaternion(rotation); position.sub(offset);
      }
      if (finiteVector(state.offset)) position.add(offset.fromArray(state.offset).applyQuaternion(rotation));
    } else {
      if (finiteVector(state.worldTransform?.position) && finiteVector(state.worldTransform?.quaternion, 4)) {
        position.fromArray(state.worldTransform.position); rotation.fromArray(state.worldTransform.quaternion).normalize();
        object.position.copy(position); object.quaternion.copy(rotation); object.scale.set(1, 1, 1);
        return { attached: true, contact: null, measured: true, attachment: attach, retainedWorldTransform: true };
      }
      const anchor = avatar?.anchor ?? {}, yaw = Number.isFinite(anchor.yaw) ? anchor.yaw : 0;
      yawQuaternion.setFromAxisAngle(UP, yaw); rotation.copy(yawQuaternion);
      position.fromArray(finiteVector(state.position) ? state.position : spec.position);
      if (!finiteVector(state.position)) {
        const tableItem = ['book', 'mug', 'paper', 'pencil', 'laptop'].includes(id);
        if (attach === 'floor' && tableItem) position.y -= ACTIVITY_PROP_LAYOUT.table.top;
        if (attach === 'table' && !tableItem) position.y += ACTIVITY_PROP_LAYOUT.table.top;
      }
      position.applyQuaternion(yawQuaternion);
      if (finiteVector(anchor.position)) position.add(offset.fromArray(anchor.position));
      if (finiteVector(state.rotation)) rotation.multiply(localRotation.setFromEuler(new THREE.Euler(...state.rotation)));
      else if (id === 'pencil') rotation.multiply(localRotation.setFromEuler(new THREE.Euler(Math.PI / 2, 0, -.12)));
      if (finiteVector(state.offset)) position.add(offset.fromArray(state.offset).applyQuaternion(rotation));
    }
    object.position.copy(position); object.quaternion.copy(rotation); object.scale.copy(scale);
    let gripError = null;
    if (attach === 'both' && contact) {
      const pair = propGripPair(id, state.openness);
      if (pair) gripError = Math.max(...[pair.left, pair.right].map((grip, i) => new THREE.Vector3(...grip).multiply(scale).applyQuaternion(rotation).add(position).distanceTo(new THREE.Vector3(...contact[i]))));
    }
    if (surfaceContact) { surfaceContact.tipY = position.y; surfaceContact.error = Math.abs(position.y - surfaceContact.targetY); }
    return { attached: true, contact, measured, attachment: attach, gripError, ...(surfaceContact ? { surfaceContact } : {}) };
  }

  function targetTransform(target, avatar) {
    if (!finiteVector(target?.position) || !finiteVector(target?.quaternion, 4)) return null;
    const targetPosition = new THREE.Vector3(...target.position), targetQuaternion = new THREE.Quaternion(...target.quaternion).normalize();
    if (target.space !== 'world') {
      const anchor = avatar.anchor ?? { position: [0, 0, 0], yaw: 0 }, yaw = new THREE.Quaternion().setFromAxisAngle(UP, anchor.yaw ?? 0);
      targetPosition.applyQuaternion(yaw).add(new THREE.Vector3(...(anchor.position ?? [0, 0, 0]))); targetQuaternion.premultiply(yaw);
    }
    return { position: targetPosition, quaternion: targetQuaternion };
  }

  function transfer(id, object, config, avatar, placement) {
    const request = config.transfer;
    if (!request || request.operation !== 'place' || request.to !== 'table') return placement;
    // Once accepted, later held snapshots from the same operation cannot pick a
    // released prop back up. A new explicit action/transfer identity is required.
    const owner = request.id ?? `${avatar.snapshot?.revision ?? 0}:${avatar.pose?.id ?? avatar.snapshot?.activeId ?? 'unowned'}:${id}:place`;
    const priorPlaced = placed.get(id);
    if (priorPlaced?.owner === owner) {
      object.position.fromArray(priorPlaced.transform.position); object.quaternion.fromArray(priorPlaced.transform.quaternion);
      object.scale.set(1, 1, 1); return { ...placement, attachment: 'table', contact: null, transfer: structuredClone(priorPlaced.accepted) };
    }
    const target = targetTransform(request.target, avatar), surface = objects.table;
    const clock = avatar.time ?? avatar.snapshot?.now ?? avatar.pose?.time;
    const previous = transferHistory.get(id), dt = Number.isFinite(clock) && previous?.owner === owner ? clock - previous.at : NaN;
    surface.updateMatrixWorld(true); object.updateMatrixWorld(true);
    const relativePosition = object.position.clone().applyMatrix4(surface.matrixWorld.clone().invert());
    const relativeQuaternion = surface.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(object.quaternion);
    const positionError = target ? object.position.distanceTo(target.position) : Infinity;
    const angleError = target ? object.quaternion.angleTo(target.quaternion) : Infinity;
    const speed = dt > 0 && dt <= .11 ? relativePosition.distanceTo(new THREE.Vector3(...previous.relativePosition)) / dt : null;
    const angularSpeed = dt > 0 && dt <= .11 ? relativeQuaternion.angleTo(new THREE.Quaternion(...previous.relativeQuaternion)) / dt : null;
    const surfaceBox = surface.visible ? new THREE.Box3().setFromObject(surface.getObjectByName('tabletop')) : null;
    const propBox = visibleBounds(object);
    // Inspect true transformed tabletop bounds. The center plus all prop box
    // corners must lie inside its local top footprint, including table yaw.
    let footprint = false, heightError = null;
    if (surfaceBox) {
      const inverse = surface.matrixWorld.clone().invert();
      const localBounds = visibleBounds(object, inverse);
      footprint = localBounds.min.x >= -5 - .02 && localBounds.max.x <= 5 + .02
        && localBounds.min.z >= -2.5 - .02 && localBounds.max.z <= 2.5 + .02;
      heightError = Math.abs(propBox.min.y - surfaceBox.max.y);
    }
    const finiteMotion = speed !== null && angularSpeed !== null;
    const positionOk = positionError <= (request.positionTolerance ?? .09), angleOk = angleError <= (request.angleTolerance ?? .09);
    const motionOk = finiteMotion && speed <= (request.maximumRelativeSpeed ?? .32) && angularSpeed <= (request.maximumAngularSpeed ?? .35);
    const gripContactOk = placement.gripError === null || placement.gripError <= .025;
    const contactOk = surface.visible && footprint && heightError <= .045 && placement.measured === true && gripContactOk;
    const qualified = positionOk && angleOk && motionOk && contactOk && config.gripReady !== false;
    const samePose = dt === 0 && previous?.owner === owner;
    const settled = samePose ? previous.settled : qualified ? (previous?.qualified && previous.owner === owner ? previous.settled : 0) + dt : 0;
    const gate = { released: false, operation: 'place', owner, positionError, angleError, relativeSpeed: speed, angularSpeed,
      footprint, heightError, surfacePresent: surface.visible, measuredHands: placement.measured === true, settledSeconds: settled,
      reason: !surface.visible ? 'missing-table' : !target ? 'invalid-target' : !footprint ? 'outside-table'
        : heightError > .045 ? 'no-surface-contact' : !gripContactOk ? 'grip-mismatch' : !positionOk ? 'position-mismatch' : !angleOk ? 'orientation-mismatch'
          : !finiteMotion ? 'unmeasured-velocity' : !motionOk ? 'still-moving' : !contactOk ? 'unmeasured-hand-contact' : 'settling' };
    if (!samePose) transferHistory.set(id, { owner, at: clock, position: object.position.toArray(), quaternion: object.quaternion.toArray(),
      relativePosition: relativePosition.toArray(), relativeQuaternion: relativeQuaternion.toArray(), qualified, settled });
    if (request.requestRelease && qualified && settled >= (request.settleSeconds ?? .16)) {
      const transform = { position: object.position.toArray(), quaternion: object.quaternion.toArray() };
      const receipt = { owner, transform, releasedAt: clock };
      const accepted = { ...gate, ...receipt, released: true, reason: 'measured-contact-and-rest' };
      placed.set(id, { ...receipt, accepted });
      return { ...placement, attachment: 'table', contact: null, transfer: structuredClone(accepted) };
    }
    return { ...placement, transfer: gate };
  }

  function take(id, object, config, avatar, placement) {
    const request = config.transfer;
    if (request?.operation !== 'take' || request.from !== 'table' || !['left', 'right', 'both'].includes(request.to)) return placement;
    const owner = request.id ?? `${avatar.snapshot?.revision ?? 0}:${avatar.pose?.id ?? avatar.snapshot?.activeId ?? 'unowned'}:${id}:take`;
    const accepted = acquired.get(id);
    if (accepted?.owner === owner) {
      // Until the host consumes the receipt, preserve the exact source pose.
      // The host then supplies a measured receipt-relative lifting trajectory.
      object.position.fromArray(accepted.transform.position); object.quaternion.fromArray(accepted.transform.quaternion); object.scale.set(1, 1, 1);
      return { ...placement, attachment: request.to, transfer: structuredClone(accepted) };
    }
    const sides = request.to === 'both' ? ['left', 'right'] : [request.to], pair = propGripPair(id, config.openness);
    const target = targetTransform(request.target, avatar), clock = avatar.time ?? avatar.snapshot?.now ?? avatar.pose?.time;
    const previous = transferHistory.get(id), dt = previous?.owner === owner && Number.isFinite(clock) ? clock - previous.at : NaN;
    const relativeHands = {}, quaternions = {}, worldHands = {}, gripErrors = [], linearSpeeds = [], angularSpeeds = [];
    for (const side of sides) {
      const hand = readHandAnchor(avatar, side);
      if (!hand?.measured) continue;
      const grip = pair && request.to === 'both' ? pair[side] : config.grip ?? ACTIVITY_PROP_LAYOUT[id].grip ?? [0, 0, 0];
      const required = new THREE.Vector3(...grip).applyQuaternion(object.quaternion).add(object.position);
      gripErrors.push(required.distanceTo(new THREE.Vector3(...hand.position))); worldHands[side] = hand.position;
      relativeHands[side] = new THREE.Vector3(...hand.position).sub(object.position).applyQuaternion(object.quaternion.clone().invert()).toArray();
      quaternions[side] = object.quaternion.clone().invert().multiply(new THREE.Quaternion(...hand.quaternion)).normalize().toArray();
      if (dt > 0 && dt <= .11 && previous.hands?.[side] && previous.quaternions?.[side]) {
        linearSpeeds.push(new THREE.Vector3(...relativeHands[side]).distanceTo(new THREE.Vector3(...previous.hands[side])) / dt);
        angularSpeeds.push(new THREE.Quaternion(...quaternions[side]).angleTo(new THREE.Quaternion(...previous.quaternions[side])) / dt);
      }
    }
    const measuredHands = Object.keys(relativeHands).length === sides.length;
    const gripError = measuredHands ? Math.max(...gripErrors) : null;
    const linearSpeed = linearSpeeds.length === sides.length ? Math.max(...linearSpeeds) : null;
    const angularSpeed = angularSpeeds.length === sides.length ? Math.max(...angularSpeeds) : null;
    let alignmentError = target ? object.quaternion.angleTo(target.quaternion) : null;
    if (request.to === 'both' && measuredHands) {
      const actual = new THREE.Vector3(...worldHands.left).sub(new THREE.Vector3(...worldHands.right));
      const expected = new THREE.Vector3(...pair.left).sub(new THREE.Vector3(...pair.right)).applyQuaternion(object.quaternion);
      alignmentError = actual.lengthSq() > 1e-10 ? Math.max(alignmentError ?? 0, actual.angleTo(expected)) : Math.PI;
    }
    object.updateMatrixWorld(true); objects.table.updateMatrixWorld(true);
    const actualBounds = visibleBounds(object), tableBounds = objects.table.visible ? new THREE.Box3().setFromObject(objects.table.getObjectByName('tabletop')) : null;
    const local = visibleBounds(object, objects.table.matrixWorld.clone().invert());
    const footprint = objects.table.visible && local.min.x >= -5 - .02 && local.max.x <= 5 + .02 && local.min.z >= -2.5 - .02 && local.max.z <= 2.5 + .02;
    const heightError = tableBounds ? Math.abs(actualBounds.min.y - tableBounds.max.y) : null;
    const sourcePresent = reports[id]?.visible === true && reports[id]?.attachment === 'table';
    const positionError = target ? object.position.distanceTo(target.position) : null;
    const contact = sourcePresent && measuredHands && footprint && heightError <= .045 && gripError <= (request.maximumGripError ?? .025)
      && positionError !== null && positionError <= (request.positionTolerance ?? .025) && alignmentError <= (request.angleTolerance ?? .09);
    const motion = linearSpeed !== null && angularSpeed !== null && linearSpeed <= (request.maximumRelativeSpeed ?? .32) && angularSpeed <= (request.maximumAngularSpeed ?? .5);
    const qualified = contact && motion, samePose = dt === 0 && previous?.owner === owner;
    const settled = samePose ? previous.settled : qualified ? (previous?.qualified && previous.owner === owner ? previous.settled : 0) + dt : 0;
    const gate = { released: false, operation: 'take', owner, from: 'table', attachment: request.to, sourcePresent,
      measuredHands, gripError, positionError, angleError: alignmentError, relativeSpeed: linearSpeed, angularSpeed, footprint, heightError,
      settledSeconds: settled, reason: !sourcePresent ? 'missing-existing-table-object' : !measuredHands ? 'unmeasured-hands'
        : !footprint ? 'outside-table' : heightError > .045 ? 'source-not-on-table' : gripError > (request.maximumGripError ?? .025) ? 'hands-not-at-grips'
          : !motion ? 'hands-not-settled' : !contact ? 'source-pose-mismatch' : 'settling' };
    if (!samePose) transferHistory.set(id, { owner, at: clock, hands: relativeHands, quaternions, qualified, settled });
    if (request.requestTake && qualified && settled >= (request.settleSeconds ?? .16)) {
      const receipt = { ...gate, released: true, releasedAt: clock, transform: { position: object.position.toArray(), quaternion: object.quaternion.toArray() },
        reason: 'measured-real-grips-and-rest' };
      acquired.set(id, receipt); placed.delete(id);
      return { ...placement, attachment: request.to, transfer: structuredClone(receipt) };
    }
    return { ...placement, transfer: gate };
  }
  return {
    layout: ACTIVITY_PROP_LAYOUT, objects, root,
    clear, reset: clear,
    update(state = {}, avatar = {}) {
      if (disposed) return;
      const props = state?.props ?? state ?? {};
      for (const id of ACTIVITY_PROP_IDS) {
        // Furniture and placed objects outlive the initiating action. Walking
        // away does not teleport the chair to the walk's newer root/anchor.
        // Explicit false removes a prop; explicit true may place it anew.
        if (!Object.hasOwn(props, id) && reports[id]?.visible && ['floor', 'table'].includes(reports[id].attachment)) continue;
        const config = normalizePropState(props[id], id), object = objects[id];
        if (props[id] === false) { placed.delete(id); acquired.delete(id); transferHistory.delete(id); }
        object.visible = config.visible && config.validAttachment;
        let placement = { attached: false, attachment: config.attachment };
        if (id === 'book') {
          const { left, right, turn } = object.userData.articulation, closure = (1 - config.openness) * 1.5;
          left.rotation.z = -closure; right.rotation.z = closure;
          turn.visible = object.visible && config.openness > .7 && config.pageTurn > .001 && config.pageTurn < .999;
          turn.rotation.z = config.pageTurn * Math.PI;
        }
        if (object.visible) { placement = place(object, config, avatar, id); object.visible = placement.attached; }
        if (object.visible) placement = transfer(id, object, config, avatar, placement);
        if (object.visible) placement = take(id, object, config, avatar, placement);
        if (object.visible && placement.attachment === 'table' && !config.transfer && placed.has(id)) {
          placement.transfer = structuredClone(placed.get(id).accepted);
        }
        if (object.visible && ['left', 'right', 'both'].includes(placement.attachment) && !config.transfer && acquired.has(id)) placement.transfer = structuredClone(acquired.get(id));
        if (id === 'laptop') object.userData.articulation.hinge.rotation.x = config.openness * 1.7;
        reports[id] = { visible: object.visible, ...placement, position: object.position.toArray(), quaternion: object.quaternion.toArray(),
          scale: object.scale.toArray(), openness: config.openness, pageTurn: config.pageTurn };
      }
      root.updateMatrixWorld(true);
    },
    snapshot() { return structuredClone({ disposed, props: reports, placementReceipts: Object.fromEntries([...placed].map(([id, state]) => [id, state.accepted])), acquisitionReceipts: Object.fromEntries(acquired) }); },
    dispose() {
      if (disposed) return; disposed = true; root.removeFromParent();
      const geometries = new Set(), materials = new Set();
      root.traverse(object => { if (object.geometry) geometries.add(object.geometry); if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m)); });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    },
  };
}
