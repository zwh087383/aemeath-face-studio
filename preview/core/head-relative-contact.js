import { add, sub, scale, len, dot, cross, clamp, smoother, lerp3, qconj, qrotate, qmul, normalize } from './motion-math.js';
import { rootRotation, toWorld, solveFullBodyPose } from './full-body-ik.js';
import { heldPropSides } from './activity-continuity.js';

// Measured from the actual face material, PMX sha256 79b622d0a87ab615...
// Vertex 65527 is fully attached to 頭 (35), including its duplicate weights.
// Mouth morphs move this skin point: the renderer may pass the skinned point.
export const AEMEATH_CHIN_CONTACT = Object.freeze({
  vertexIndex: 65527, bone: '頭', side: 'R',
  bindHeadPosition: Object.freeze([-.0000003889427092, 17.6265926361084, -.5550668835639954]),
  localPosition: Object.freeze([.0000003889427092, -.3992729187011719, .8418161273002625]),
  localNormal: Object.freeze([-.014563092030584812, -.9765163660049438, .2149505466222763]),
  clearance: .07, voicingClearance: .6, tolerance: .06,
});

const copy = value => structuredClone(value);
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** The actual index fingertip follows the current head frame. This is a contact
 * constraint inside a selected gesture, never a fixed world-space hand point. */
export function sampleHeadRelativeChinTap(source, { phase = 0, strength = 1, activation = 1, voicing = false, voiceClearance, chinSurface } = {}, { rig } = {}) {
  const reject = reason => ({ pose: copy(source), accepted: false, reason, contact: null });
  if (!rig || !['standing', 'seated'].includes(source?.support)) return reject('supported-rig-required');
  if (!Number.isFinite(phase) || !Number.isFinite(strength) || !Number.isFinite(activation)) return reject('finite-contact-parameters-required');
  if (Object.values(source.props ?? {}).some(prop => heldPropSides(prop).includes('R'))
    || Object.values(source.propContactPlans ?? {}).some(plan => plan.hands?.includes('R'))) return reject('chin-contact-needs-free-right-hand');
  const marker = AEMEATH_CHIN_CONTACT, pose = copy(source), locals = new Map(), fk = new Map();
  if (rig.torso.head.name !== marker.bone || len(sub(rig.pos(marker.bone), marker.bindHeadPosition)) > .01) return reject('head-contact-marker-model-mismatch');
  solveFullBodyPose(rig, pose, locals, fk);
  const head = fk.get(rig.torso.head.name), chest = fk.get(rig.torso.upperChest.name), rootQ = rootRotation(pose.root);
  const headQ = qmul(rootQ, head.rotation);
  const headSurface = toWorld(pose.root, add(head.position, qrotate(head.rotation, marker.localPosition)));
  const surface = vector(chinSurface?.position) ? copy(chinSurface.position) : headSurface;
  if (len(sub(surface, headSurface)) > .35 || vector(chinSurface?.normal) && len(chinSurface.normal) < .5) return reject('rendered-chin-surface-outside-head-envelope');
  const normal = normalize(vector(chinSurface?.normal) ? chinSurface.normal : qrotate(headQ, marker.localNormal));
  const clearance = marker.clearance + (marker.voicingClearance - marker.clearance) * clamp(voiceClearance ?? (voicing ? 1 : 0));
  const target = add(surface, scale(normal, clearance));
  const inverseWorldChest = qconj(qmul(rootQ, chest.rotation)), sign = rig.sides.R.sign;
  const mirror = p => [p[0] * sign, p[1], p[2]];
  const toRestVector = value => qrotate(inverseWorldChest, value);
  pose.hands.R = { ...pose.hands.R, anchor: 'wrist', curl: .12 + .02 * clamp(strength), thumb: .25 + .05 * clamp(strength), spread: .02,
    fingerCurls: { middle: .68, ring: .78, pinky: .86 },
    palm: mirror(toRestVector(qrotate(headQ, [0, 0, -1]))),
    point: mirror(toRestVector(qrotate(headQ, [0, 1, .08]))), pole: [1, -.35, .8] };
  // Inverse-carried positional correction leaves the established elbow policy,
  // bone lengths and wrist limits intact. Reject impossible contacts honestly.
  const tipName = rig.sides.R.names.tips.index;
  let residual = Infinity;
  for (let iteration = 0; iteration < 20; iteration++) {
    solveFullBodyPose(rig, pose, locals, fk);
    const actual = toWorld(pose.root, fk.get(tipName).position), error = sub(target, actual);
    residual = len(error); if (residual < .004) break;
    const delta = mirror(toRestVector(error));
    pose.hands.R.hand = add(pose.hands.R.hand, scale(delta, .8));
  }
  for (let iteration = 0; iteration < 10; iteration++) {
    solveFullBodyPose(rig, pose, locals, fk);
    const actual = toWorld(pose.root, fk.get(tipName).position), error = sub(target, actual);
    residual = len(error); if (residual < .004) break;
    const baseline = copy(pose.hands.R.hand), columns = [], epsilon = 1e-4;
    for (let axis = 0; axis < 3; axis++) {
      pose.hands.R.hand = copy(baseline); pose.hands.R.hand[axis] += epsilon;
      solveFullBodyPose(rig, pose, locals, fk);
      columns.push(scale(sub(toWorld(pose.root, fk.get(tipName).position), actual), 1 / epsilon));
    }
    const determinant = dot(columns[0], cross(columns[1], columns[2]));
    pose.hands.R.hand = baseline;
    if (Math.abs(determinant) < 1e-6) break;
    let step = [dot(error, cross(columns[1], columns[2])) / determinant,
      dot(columns[0], cross(error, columns[2])) / determinant, dot(columns[0], cross(columns[1], error)) / determinant];
    if (len(step) > .4) step = scale(step, .4 / len(step));
    let improved = false;
    for (const weight of [1, .5, .25, .125]) {
      pose.hands.R.hand = add(baseline, scale(step, weight)); solveFullBodyPose(rig, pose, locals, fk);
      if (distanceToTarget() < residual) { improved = true; break; }
    }
    if (!improved) { pose.hands.R.hand = baseline; break; }
  }
  function distanceToTarget() { return len(sub(target, toWorld(pose.root, fk.get(tipName).position))); }
  solveFullBodyPose(rig, pose, locals, fk); residual = distanceToTarget();
  if (residual > marker.tolerance) return reject('head-relative-contact-unreachable');
  // Intensity changes a small hand shaping detail. Scaling the whole reach by
  // emotional intensity would falsely report chin contact with a hand in midair.
  const p = clamp(phase), envelope = smoother(p / .3) * (1 - smoother((p - .62) / .38)) * clamp(activation) * (strength > 0 ? 1 : 0);
  const contactHand = copy(pose.hands.R), original = source.hands.R;
  for (const key of ['hand', 'pole', 'palm', 'point']) pose.hands.R[key] = lerp3(original[key], contactHand[key], envelope);
  for (const key of ['curl', 'thumb', 'spread']) pose.hands.R[key] = (original[key] ?? 0) + ((contactHand[key] ?? 0) - (original[key] ?? 0)) * envelope;
  pose.hands.R.fingerCurls = Object.fromEntries(Object.entries(contactHand.fingerCurls).map(([finger, curl]) => {
    const from = original.fingerCurls?.[finger] ?? original.curl ?? .15;
    return [finger, from + (curl - from) * envelope];
  }));
  if (envelope === 0) pose.hands.R = copy(original);
  solveFullBodyPose(rig, pose, locals, fk);
  const actual = toWorld(pose.root, fk.get(tipName).position);
  return { pose, accepted: true, reason: 'head-relative-chin-contact', contact: {
    kind: 'chin', side: 'R', bone: marker.bone, vertexIndex: marker.vertexIndex,
    source: vector(chinSurface?.position) ? 'rendered-skin' : 'measured-head-local-skin',
    surface, normal, target, actual, clearance, error: len(sub(actual, target)),
    atContact: envelope > .999, solvedError: residual, voicing: !!voicing,
  } };
}
