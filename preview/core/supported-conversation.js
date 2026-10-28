import { POSTURES } from './motion-profile.js';
import { add, sub, len, scale, clamp, smoother, qconj, qmul, qrotate, qeuler, lerp3 } from './motion-math.js';
import { toModel, rootRotation, solveFullBodyPose } from './full-body-ik.js';
import { heldPropSides } from './activity-continuity.js';
import { enforceActivityPropContacts } from './activity-prop-execution.js';
import { ACTIVITY_PROP_LAYOUT } from './activity-prop-layout.js';
import { sampleHeadRelativeChinTap } from './head-relative-contact.js';

const copy = value => structuredClone(value);
const vector = (value, n = 3) => Array.isArray(value) && value.length === n && value.every(Number.isFinite);
const SIDES = ['L', 'R'];

export const SUPPORTED_CONVERSATION_KINDS = Object.freeze({
  listen: Object.freeze({ channels: ['head', 'upper-torso'], sustained: true }),
  nod: Object.freeze({ channels: ['head'], sustained: false }),
  shake: Object.freeze({ channels: ['head'], sustained: false }),
  tilt_left: Object.freeze({ channels: ['head'], sustained: false }),
  tilt_right: Object.freeze({ channels: ['head'], sustained: false }),
  glance_left: Object.freeze({ channels: ['head', 'eyes'], sustained: false }),
  glance_right: Object.freeze({ channels: ['head', 'eyes'], sustained: false }),
  finger_release: Object.freeze({ channels: ['free-fingers'], sustained: false }),
  chin_tap: Object.freeze({ channels: ['free-right-hand'], sustained: false, contact: 'head-relative-index-tip' }),
});

function pinHeldFrames(pose) {
  for (const [id, prop] of Object.entries(pose.props ?? {})) {
    const hands = heldPropSides(prop), frame = prop?.worldTransform;
    if (!hands.length || !ACTIVITY_PROP_LAYOUT[id] || !vector(frame?.position) || !vector(frame?.quaternion, 4)) continue;
    pose.propContactPlans ??= {};
    pose.propContactPlans[id] = { attachment: prop.attachment, hands, openness: prop.openness,
      ...(prop.grip ? { grip: copy(prop.grip) } : {}), frame: { ...copy(frame), space: 'world' } };
  }
}

/** A local, explicitly selected gesture. No semantic action is chosen here.
 * Root, pelvis, feet, seat and object ownership remain with the original task. */
export function sampleSupportedConversation(source, { kind = 'listen', phase = 0, strength = 1, activation = 1, voicing = false, voiceClearance, chinSurface } = {}, { rig } = {}) {
  const pose = copy(source), reject = reason => ({ pose, accepted: false, reason, contact: null });
  if (!Object.hasOwn(SUPPORTED_CONVERSATION_KINDS, kind)) return reject('unknown-supported-gesture');
  if (!['standing', 'seated'].includes(pose?.support) || !vector(pose.root?.position)
    || SIDES.some(side => !vector(pose.feet?.[side]?.position))) return reject('measured-supported-pose-required');
  if (!Number.isFinite(phase) || !Number.isFinite(strength)) return reject('finite-gesture-parameters-required');
  if (kind === 'chin_tap') return sampleHeadRelativeChinTap(source, { phase, strength, activation, voicing, voiceClearance, chinSurface }, { rig });
  const weight = clamp(strength, 0, 1), p = clamp(phase), pulse = Math.sin(Math.PI * p) ** 2;
  pose.body ??= {};
  const b = pose.body;
  if (kind === 'listen') {
    b.headPitch = (b.headPitch ?? 0) * (1 - weight) + .015 * weight;
    b.headYaw = (b.headYaw ?? 0) * (1 - weight);
    b.headRoll = (b.headRoll ?? 0) * (1 - .75 * weight);
    b.gazePitch = (b.gazePitch ?? 0) * (1 - weight);
    b.gazeYaw = (b.gazeYaw ?? 0) * (1 - weight);
    // An occupied hand or surface contact keeps the entire torso unchanged.
    // Only the head turns from the book/screen toward the conversation.
    if (!Object.keys(pose.propContactPlans ?? {}).length && !Object.values(pose.props ?? {}).some(prop => heldPropSides(prop).length)) {
      b.lean = (b.lean ?? 0) + .012 * weight;
    }
  } else if (kind === 'nod') b.headPitch = (b.headPitch ?? 0) + .13 * Math.sin(2 * Math.PI * p) * pulse * weight;
  else if (kind === 'shake') b.headYaw = (b.headYaw ?? 0) + .16 * Math.sin(4 * Math.PI * p) * pulse * weight;
  else if (kind.startsWith('tilt_')) b.headRoll = (b.headRoll ?? 0) + (kind === 'tilt_left' ? 1 : -1) * .12 * pulse * weight;
  else if (kind.startsWith('glance_')) {
    const sign = kind === 'glance_left' ? 1 : -1;
    b.headYaw = (b.headYaw ?? 0) + sign * .14 * pulse * weight;
    b.gazeYaw = (b.gazeYaw ?? 0) + sign * .055 * pulse * weight;
  } else if (kind === 'finger_release') {
    const occupied = new Set(Object.values(pose.props ?? {}).flatMap(heldPropSides));
    for (const contact of Object.values(pose.propContactPlans ?? {})) for (const side of contact.hands ?? []) occupied.add(side);
    const free = SIDES.filter(side => !occupied.has(side) && pose.hands?.[side]);
    if (!free.length) return reject('no-free-hand');
    for (const side of free) pose.hands[side].curl = Math.max(-.1, (pose.hands[side].curl ?? .15) - .07 * pulse * weight);
  }
  let contact = null;
  if (rig && Object.values(pose.props ?? {}).some(prop => heldPropSides(prop).length)) {
    pinHeldFrames(pose); contact = enforceActivityPropContacts(rig, pose);
    if (!contact.ready) return { pose: copy(source), accepted: false, reason: 'held-contact-unreachable', contact };
  }
  return { pose, accepted: true, reason: 'supported-local-gesture', contact, voicing: !!voicing };
}

/** The caller selects kind/id. Cancel returns along the same bounded envelope;
 * update never starts a new gesture or restarts a completed task. */
export class SupportedConversationOverlay {
  constructor() { this.active = null; }
  begin({ id, kind = 'listen', duration = 1.4, strength = 1, hold = false } = {}) {
    if (!id || !Object.hasOwn(SUPPORTED_CONVERSATION_KINDS, kind) || !Number.isFinite(duration) || duration < .2 || !Number.isFinite(strength)) return false;
    if (this.active?.id === id) return true;
    if (this.active) return false;
    this.active = { id, kind, duration, strength: clamp(strength), hold: !!hold, elapsed: 0, cancelElapsed: null, cancelWeight: 0, weight: 0, voiceClearance: 0 };
    return true;
  }
  cancel(id) {
    const a = this.active;
    if (!a || id !== undefined && id !== a.id) return false;
    if (a.cancelElapsed === null) { a.cancelElapsed = 0; a.cancelWeight = a.weight; }
    return true;
  }
  clear() { this.active = null; }
  update(dt, pose, options = {}) {
    const a = this.active;
    if (!a) return { pose: copy(pose), accepted: true, reason: 'no-overlay', contact: null };
    dt = clamp(dt, 0, .1);
    if (a.cancelElapsed !== null) a.cancelElapsed += dt; else a.elapsed += dt;
    const entry = smoother(a.elapsed / .3), exit = a.hold ? 1 : 1 - smoother((a.elapsed - a.duration + .3) / .3);
    a.weight = a.cancelElapsed === null ? entry * exit : a.cancelWeight * (1 - smoother(a.cancelElapsed / .3));
    a.voiceClearance += ((options.voicing ? 1 : 0) - a.voiceClearance) * (1 - Math.exp(-dt / .055));
    const result = sampleSupportedConversation(pose, { kind: a.kind, phase: clamp(a.elapsed / a.duration), strength: a.kind === 'chin_tap' ? a.strength : a.strength * a.weight,
      activation: a.weight,
      voicing: options.voicing, voiceClearance: a.voiceClearance, chinSurface: options.chinSurface }, options);
    if (a.cancelElapsed >= .3 || !a.hold && a.elapsed >= a.duration) this.active = null;
    return result;
  }
  snapshot() { return copy(this.active); }
}

// Small, bounded fit of the existing solver's three torso angles. This preserves
// the measured chest orientation without treating a native seated pose as upright.
function euler(q) {
  const [x, y, z, w] = q;
  return [Math.asin(clamp(2 * (w * x - y * z), -1, 1)),
    Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)),
    Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z))];
}
function linear3(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return [0, 0, 0];
    [m[c], m[p]] = [m[p], m[c]];
    const divisor = m[c][c]; for (let j = c; j < 4; j++) m[c][j] /= divisor;
    for (let r = 0; r < 3; r++) if (r !== c) { const k = m[r][c]; for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j]; }
  }
  return m.map(row => row[3]);
}
function fitOrientation(target, compose, bounds) {
  let value = euler(target).map((v, i) => clamp(v, bounds[i][0], bounds[i][1]));
  const error = v => { const q = qmul(target, qconj(compose(v))), sign = q[3] < 0 ? -1 : 1; return q.slice(0, 3).map(n => n * sign * 2); };
  for (let iteration = 0; iteration < 8; iteration++) {
    const e = error(value); if (len(e) < 1e-9) break;
    const columns = value.map((_, i) => { const probe = [...value]; probe[i] += 1e-5; return error(probe).map((v, j) => (v - e[j]) / 1e-5); });
    const delta = linear3([0, 1, 2].map(i => columns.map(column => column[i])), e.map(v => -v));
    value = value.map((v, i) => clamp(v + clamp(delta[i], -.2, .2), bounds[i][0], bounds[i][1]));
  }
  return { value, error: len(error(value)) };
}

/** state is measured scene data, never inferred from an action label. The scene
 * must establish seatSupported from actual furniture height/bounds beforehand. */
export function captureSupportedPoseFromMeasured(body, state) {
  const rig = body?.rig, bones = state?.bones ?? {}, rotations = state?.rotations ?? {}, root = state?.root;
  const rejected = reason => ({ accepted: false, reason, pose: null, diagnostics: null });
  if (!rig || !vector(root?.position) || !Number.isFinite(root?.yaw)) return rejected('measured-root-required');
  const support = state.support ?? state.posture;
  if (!['standing', 'seated'].includes(support)) return rejected('measured-support-required');
  if (support === 'seated' && state.seatSupported !== true) return rejected('verified-seat-required');
  if (support === 'standing' && !SIDES.some(side => state.contacts?.[side] === true)) return rejected('planted-foot-required');
  const required = ['pelvis', 'upperChest', 'head', 'leftWrist', 'rightWrist', 'leftElbow', 'rightElbow', 'leftAnkle', 'rightAnkle'];
  if (required.some(key => !vector(bones[key])) || ['upperChest', 'head', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle'].some(key => !vector(rotations[key], 4))) return rejected('measured-bone-frames-required');
  const rootQ = rootRotation(root), inverseRoot = qconj(rootQ), upper = qmul(inverseRoot, rotations.upperChest);
  const torso = fitOrientation(upper, ([l, t, s]) => qmul(qmul(qeuler(l * .56, t * .4, s * .42), qeuler(l * .29, t * .35, s * .34)), qeuler(l * .15, t * .25, s * .24)), [[-1, 1.2], [-.85, .85], [-.65, .65]]);
  const [lean, twist, side] = torso.value, relativeHead = qmul(qconj(rotations.upperChest), rotations.head);
  const head = fitOrientation(relativeHead, ([p, y, r]) => qmul(qeuler(p * .35, y * .35, r * .4), qeuler(p * .65, y * .65, r * .6)), [[-.8, .8], [-1, 1], [-.65, .65]]);
  if (torso.error > .12 || head.error > .2) return rejected('measured-upper-body-outside-supported-range');
  const pose = body.standing(root);
  pose.support = support; pose.phase = 'adopted-supported-pose'; pose.terminal = true;
  pose.pelvis.offset = sub(toModel(root, bones.pelvis), rig.pos(rig.support.root));
  if (vector(rotations.lowerBody, 4)) {
    const [pitch, yaw, roll] = euler(qmul(inverseRoot, rotations.lowerBody)); Object.assign(pose.pelvis, { pitch, yaw, roll });
  }
  pose.body = { lean, twist, side, headPitch: head.value[0] + lean * .32, headYaw: head.value[1] + twist * .3, headRoll: head.value[2] };
  for (const s of SIDES) {
    const prefix = s === 'L' ? 'left' : 'right', arm = rig.sides[s], sign = arm.sign;
    const inverseChest = qconj(rotations.upperChest), rest = rig.torso.upperChest.rest;
    const carriedPoint = point => add(rest, qrotate(inverseChest, sub(point, bones.upperChest)));
    const mirror = point => [point[0] * sign, point[1], point[2]];
    const wristRotation = qmul(inverseChest, rotations[`${prefix}Wrist`]);
    const wrist = carriedPoint(bones[`${prefix}Wrist`]), elbow = carriedPoint(bones[`${prefix}Elbow`]);
    const shoulder = bones[`${prefix}Shoulder`] ? carriedPoint(bones[`${prefix}Shoulder`]) : rig.pos(arm.names.arm);
    pose.hands[s] = { ...copy(POSTURES.relaxed[s]), hand: mirror(wrist),
      pole: mirror(sub(elbow, lerp3(shoulder, wrist, .5))),
      palm: mirror(qrotate(wristRotation, arm.palm)), point: mirror(qrotate(wristRotation, arm.handDir)), anchor: 'wrist' };
    pose.feet[s] = { position: copy(bones[`${prefix}Ankle`]), rotation: copy(rotations[`${prefix}Ankle`]), contact: state.contacts?.[s] === true };
  }
  pose.props = copy(state.props ?? {}); pose.anchor = copy(root);
  for (const [id, prop] of Object.entries(pose.props)) if (heldPropSides(prop).length) {
    if (!ACTIVITY_PROP_LAYOUT[id] || !vector(prop?.worldTransform?.position) || !vector(prop?.worldTransform?.quaternion, 4)) return rejected('measured-held-prop-frame-required');
  }
  pinHeldFrames(pose);
  const contact = enforceActivityPropContacts(rig, pose), fk = new Map();
  const solved = solveFullBodyPose(rig, pose, new Map(), fk);
  if (!contact.ready || !solved.finite) return rejected('measured-pose-not-solvable');
  const footError = Math.max(...Object.values(solved.legs).map(leg => leg.error));
  if (footError > .08) return rejected('measured-leg-support-unreachable');
  pose.propContacts = contact;
  const handPositionError = Object.fromEntries(SIDES.map(s => [s, len(sub(
    add(root.position, qrotate(rootQ, fk.get(rig.sides[s].names.wrist).position)), bones[s === 'L' ? 'leftWrist' : 'rightWrist']))]));
  return { accepted: true, reason: 'measured-supported-pose', pose,
    diagnostics: { torsoOrientationError: torso.error, headOrientationError: head.error, footError, handPositionError, contact } };
}
