import {
  add, addScaled, clamp, cross, dot, len, normalize, perpendicular, qaxis, qconj, qcopy, qfromFrames, qfromUnit,
  qid, qlimit, qmul, qnormalize, qrotate, qtwist, qtwistAngle, scale, sub,
} from './motion-math.js';

/** Character skeleton analysis and solvers, independent of Three.js.
 *
 * Input is the bind pose in model space (right-handed, +Y up, the character facing +Z,
 * character-left at +X) with identity rest rotations, as loaded by three-mmd. All axes
 * below are derived from bone geometry, not from names or guessed Euler orders.
 * Output rotations are local bone quaternions to be multiplied onto the rest rotation.
 */
export const FORWARD = Object.freeze([0, 0, 1]);
export const UP = Object.freeze([0, 1, 0]);
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export function skeletonFromInspection(inspection) {
  // Inspection JSON stores raw PMX (left-handed) positions; three-mmd negates Z.
  const bones = inspection.bones;
  return new Map(bones.map(b => [b.name, { position: [b.position[0], b.position[1], -b.position[2]],
    parent: b.parentIndex >= 0 ? bones[b.parentIndex].name : null }]));
}

export function buildRig(skeleton, binding) {
  const pos = name => {
    const bone = skeleton.get(name);
    if (!bone) throw new Error(`motion rig: missing bone ${name}`);
    return bone.position;
  };
  const parentOf = name => skeleton.get(name)?.parent ?? null;
  const t = binding.torso;
  const rig = { binding, skeleton, torso: {}, sides: {}, legs: {}, chain: [] };
  for (const key of ['spine', 'chest', 'upperChest', 'neck', 'head', 'eyes']) rig.torso[key] = { name: t[key], rest: pos(t[key]) };
  // Optional support rig: older/custom skeletons keep upper-body motion. The two
  // leg chains are solved here because the preview deliberately disables MMD IK.
  const support = binding.support ?? { root: '腰', pelvis: '下半身' };
  if (skeleton.has(support.root) && skeleton.has(support.pelvis)) {
    rig.support = support;
    for (const [side, prefix] of [['L', '左'], ['R', '右']]) {
      const names = { hip: `${prefix}足`, knee: `${prefix}ひざ`, ankle: `${prefix}足首`, toe: `${prefix}つま先` };
      if (!Object.values(names).every(name => skeleton.has(name))) continue;
      const upper = sub(pos(names.knee), pos(names.hip)), lower = sub(pos(names.ankle), pos(names.knee));
      rig.legs[side] = { names, upper: normalize(upper), lower: normalize(lower),
        L1: len(upper), L2: len(lower), hinge: normalize(cross(upper, lower)),
        pole: perpendicular(upper, normalize(sub(pos(names.ankle), pos(names.hip))), FORWARD),
        target: pos(names.ankle) };
    }
    if (Object.keys(rig.legs).length !== 2) rig.support = null;
  }
  for (const [sideKey, side] of Object.entries(binding.sides)) {
    const n = side.names;
    const S0 = pos(n.shoulder), A0 = pos(n.arm), E0 = pos(n.elbow), W0 = pos(n.wrist);
    const upper = sub(E0, A0), fore = sub(W0, E0);
    const restUpper = normalize(upper), restFore = normalize(fore);
    const mid1 = pos(n.fingers.middle[0]);
    const handDir = normalize(sub(mid1, W0));
    const thumbSideRaw = normalize(sub(pos(n.fingers.index[0]), pos(n.fingers.pinky[0])));
    const thumbSide = perpendicular(thumbSideRaw, handDir, FORWARD);
    // Palm normal points out of the palm. With thumbs forward in the A-pose it faces
    // the body; the cross product flips handedness between the mirrored sides.
    const palm = perpendicular(scale(normalize(cross(handDir, thumbSide)), side.sign), handDir, [-side.sign, 0, 0]);
    const fingers = {};
    for (const finger of FINGERS) {
      const names = n.fingers[finger];
      const segments = [];
      for (let i = 0; i < names.length - 1; i++) {
        const dir = normalize(sub(pos(names[i + 1]), pos(names[i])));
        segments.push({ name: names[i], dir, curlAxis: normalize(cross(dir, palm)),
          spreadAxis: normalize(cross(dir, perpendicular(thumbSide, dir, FORWARD))) });
      }
      fingers[finger] = segments;
    }
    // Elbow flexion axis: positive bend moves the forearm toward the front of the upper arm.
    const hinge = normalize(cross(restUpper, FORWARD));
    rig.sides[sideKey] = {
      key: sideKey, sign: side.sign, names: n,
      S0, A0, E0, W0, L1: len(upper), L2: len(fore), restUpper, restFore, hinge,
      // The bind pose is not perfectly straight; IK bends are measured from it.
      restBend: Math.atan2(dot(cross(restUpper, restFore), hinge), dot(restUpper, restFore)),
      handDir, palm, thumbSide, palmAlong: .45 * len(sub(mid1, W0)), palmDepth: .12,
      shrugAxis: [0, 0, side.sign], protractAxis: [0, -side.sign, 0],
      fingers,
    };
  }
  // Parent-first FK chain over the bones the motion system rotates or measures.
  const wanted = new Set();
  const addPath = name => { for (let b = name; b; b = parentOf(b)) wanted.add(b); };
  for (const key of ['eyes']) addPath(t[key]);
  for (const leg of Object.values(rig.legs)) addPath(leg.names.toe);
  for (const side of Object.values(rig.sides)) {
    for (const segs of Object.values(side.fingers)) for (const s of segs) addPath(s.name);
    for (const tip of Object.values(side.names.tips)) addPath(tip);
  }
  const depth = name => { let d = 0; for (let b = parentOf(name); b; b = parentOf(b)) d++; return d; };
  rig.chain = [...wanted].sort((a, b) => depth(a) - depth(b));
  rig.parentOf = parentOf;
  rig.pos = pos;
  return rig;
}

/** Forward kinematics for the rig chain. locals: Map name -> quaternion. */
export function forwardKinematics(rig, locals, out = new Map()) {
  for (const name of rig.chain) {
    const parent = rig.parentOf(name);
    const local = locals.get(name) ?? qid();
    let entry = out.get(name);
    if (!entry) { entry = { position: [0, 0, 0], rotation: [0, 0, 0, 1] }; out.set(name, entry); }
    const p = parent && out.get(parent);
    if (!p) { qcopy(local, entry.rotation); entry.position.splice(0, 3, ...rig.pos(name)); continue; }
    const offset = add(sub(rig.pos(name), rig.pos(parent)), locals.translations?.get(name) ?? [0, 0, 0]);
    add(p.position, qrotate(p.rotation, offset), entry.position);
    qmul(p.rotation, local, entry.rotation);
  }
  return out;
}

/** Keep both feet planted while the pelvis shifts and counter-tilts. Rest ankle
 * positions and rotations are the support constraints, not moving gesture targets.
 * Standard leg bones feed the PMX's D-bone grants; no grant helper is double-driven. */
export function solveSupport(rig, locals, fk = new Map()) {
  if (!rig.support) return fk;
  forwardKinematics(rig, locals, fk);
  for (const leg of Object.values(rig.legs)) {
    const { names, L1, L2 } = leg;
    const parent = fk.get(rig.parentOf(names.hip));
    const hip = fk.get(names.hip).position;
    const ray = sub(leg.target, hip), distance = len(ray), direction = normalize(ray);
    const reach = clamp(distance, Math.abs(L1 - L2) + 1e-5, L1 + L2 - 1e-5);
    // Knees point forward. Preserve the small natural lateral cant of each leg.
    const bendPlane = perpendicular(leg.pole, direction, FORWARD);
    const cosA = clamp((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach), -1, 1);
    const upperDir = normalize(add(scale(direction, cosA), scale(bendPlane, Math.sqrt(1 - cosA * cosA))));
    const knee = add(hip, scale(upperDir, L1));
    const lowerDir = normalize(sub(add(hip, scale(direction, reach)), knee));
    const hinge = normalize(cross(upperDir, lowerDir));
    const thighWorld = qfromFrames(leg.upper, leg.hinge, upperDir, hinge);
    const shinWorld = qfromFrames(leg.lower, leg.hinge, lowerDir, hinge);
    locals.set(names.hip, qnormalize(qmul(qconj(parent.rotation), thighWorld)));
    locals.set(names.knee, qnormalize(qmul(qconj(thighWorld), shinWorld)));
    locals.set(names.ankle, qconj(shinWorld));
    leg.unreachable = Math.max(0, distance - reach);
  }
  return forwardKinematics(rig, locals, fk);
}

/** Shoulder girdle and two-bone arm chain (no hand) for a pose with model-space hand/pole. */
function solveChain(rig, side, pose, chestRot, chestPos) {
  const s = rig.sides[side], upperChest = rig.torso.upperChest.rest;
  const toWorld = p => add(chestPos, qrotate(chestRot, sub(p, upperChest)));
  // Shoulder girdle: elevation then protraction, applied at the clavicle bone.
  const qShoulder = qnormalize(qmul(qaxis(s.protractAxis, pose.protract ?? 0), qaxis(s.shrugAxis, pose.shrug ?? 0)));
  const shoulderWorld = qmul(chestRot, qShoulder);
  const S = toWorld(s.S0);
  const A = add(S, qrotate(shoulderWorld, sub(s.A0, s.S0)));
  const T = toWorld(pose.hand);
  const pole = normalize(qrotate(chestRot, pose.pole));
  // Clamp reach to keep a slight elbow bend and avoid a degenerate fold.
  const toT = sub(T, A), dist = len(toT);
  const d = clamp(dist, Math.abs(s.L1 - s.L2) + .05, (s.L1 + s.L2) * .995);
  const uHat = scale(toT, 1 / (dist || 1));
  const cosA = clamp((s.L1 * s.L1 + d * d - s.L2 * s.L2) / (2 * s.L1 * d), -1, 1);
  const pHat = perpendicular(pole, uHat, [0, -1, 0]);
  const upperDir = normalize(add(scale(uHat, cosA), scale(pHat, Math.sqrt(1 - cosA * cosA))));
  const cosE = clamp((s.L1 * s.L1 + s.L2 * s.L2 - d * d) / (2 * s.L1 * s.L2), -1, 1);
  const bend = Math.PI - Math.acos(cosE);
  // World swing of the upper arm, then align the elbow hinge with the bend plane.
  const swing = qfromUnit(s.restUpper, upperDir);
  const hingeNow = qrotate(swing, s.hinge);
  const wanted = normalize(cross(pHat, uHat));
  const tau = Math.atan2(dot(cross(hingeNow, wanted), upperDir), dot(hingeNow, wanted));
  const armWorld = swing;
  const qTwist = qaxis(s.restUpper, tau);
  const qElbow = qaxis(s.hinge, bend - s.restBend);
  const elbowWorld = qmul(qmul(armWorld, qTwist), qElbow);
  return { qShoulder, qArm: qnormalize(qmul(qconj(shoulderWorld), armWorld)), qTwist, qElbow, elbowWorld, dist, bend, tau, T, A };
}

/** Hand rotation in the forearm (elbow) frame from palm/pointing directions in that frame. */
const handLocal = (s, palm, point) => {
  const palmL = normalize(palm);
  return qfromFrames(s.handDir, s.palm, perpendicular(point, palmL, s.handDir), palmL);
};
/** Split a forearm-frame hand rotation into forearm twist (twist bone) and a limited wrist swing. */
function splitHand(s, localHand) {
  const twistAngle = clamp(qtwistAngle(localHand, s.restFore), -1.75, 1.75);
  const qForearm = qaxis(s.restFore, twistAngle);
  const qWrist = qlimit(qnormalize(qmul(qconj(qForearm), localHand)), 1.05);
  return { twistAngle, qForearm, qWrist };
}

/** Convert a hand orientation authored in model space (rest chest frame) into the
 * forearm frame of that same pose, keeping only what the twist and wrist limits can
 * reach. Poses blend in this frame, so a large reorientation of the hand becomes
 * forearm rotation and wrist motion instead of a world-space shortcut. */
export function handRelative(rig, side, pose) {
  const s = rig.sides[side];
  const { elbowWorld } = solveChain(rig, side, pose, qid(), rig.torso.upperChest.rest);
  const palmD = normalize(pose.palm);
  const pointD = perpendicular(pose.point, palmD, qrotate(elbowWorld, s.handDir));
  const desired = qmul(qconj(elbowWorld), qfromFrames(s.handDir, s.palm, pointD, palmD));
  const { qForearm, qWrist } = splitHand(s, desired);
  const achieved = qmul(qForearm, qWrist);
  return { palm: qrotate(achieved, s.palm), point: qrotate(achieved, s.handDir) };
}

/** Rest-chest forearm frame of a pose; converts small model-space offsets (additive gestures). */
export const forearmFrame = (rig, side, pose) => solveChain(rig, side, pose, qid(), rig.torso.upperChest.rest).elbowWorld;

/** Two-bone arm IK with geometric pole, forearm/hand orientation and finger curls.
 * Frame: model space after torso rotation. chestRot/chestPos describe the
 * upper-chest bone; hand/pole targets are authored in the rest model frame and carried
 * by it. pose.palm/pose.point are in the forearm frame (see handRelative).
 * Writes local quaternions into `locals` and returns a small diagnostic record.
 */
export function solveArm(rig, side, pose, chestRot, chestPos, locals, diag = {}) {
  const s = rig.sides[side], n = s.names;
  const { qShoulder, qArm, qTwist, qElbow, dist, bend, tau, T, A } = solveChain(rig, side, pose, chestRot, chestPos);
  locals.set(n.shoulder, qShoulder);
  locals.set(n.arm, qArm);
  locals.set(n.armTwist, qTwist);
  locals.set(n.elbow, qElbow);
  const { twistAngle, qForearm, qWrist } = splitHand(s, handLocal(s, pose.palm, pose.point));
  locals.set(n.handTwist, qForearm);
  locals.set(n.wrist, qWrist);
  // Fingers: a relaxed cascade (index < middle < ring < pinky), thumb separate.
  const curl = clamp(pose.curl, -.15, 1), thumb = clamp(pose.thumb, -.2, 1), spread = clamp(pose.spread, -1, 1);
  for (const [finger, segments] of Object.entries(s.fingers)) {
    const shape = FINGER_SHAPE[finger];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const amount = finger === 'thumb' ? thumb : curl;
      let q = qaxis(seg.curlAxis, amount * shape.curl[i] * shape.gain);
      if (i === 0 && shape.spread) q = qmul(q, qaxis(seg.spreadAxis, spread * shape.spread));
      locals.set(seg.name, qnormalize(q));
    }
  }
  diag.reach = dist / (s.L1 + s.L2);
  diag.bend = bend;
  diag.twist = tau;
  diag.forearmTwist = twistAngle;
  diag.wrist = 2 * Math.acos(clamp(Math.abs(qWrist[3]), 0, 1));
  diag.target = T;
  diag.shoulder = A;
  return diag;
}

// Max joint angles (radians) at curl = 1, proximal to distal, plus per-finger gain.
export const FINGER_SHAPE = Object.freeze({
  thumb: { curl: [.22, .42, .55], gain: 1, spread: 0 },
  index: { curl: [1.05, 1.35, .85], gain: .86, spread: .16 },
  middle: { curl: [1.1, 1.4, .9], gain: 1, spread: .03 },
  ring: { curl: [1.1, 1.42, .9], gain: 1.07, spread: -.1 },
  pinky: { curl: [1.12, 1.45, .95], gain: 1.16, spread: -.21 },
});

/** Convert a palm-surface target into the wrist target for a given hand orientation. */
export function wristFromPalm(rig, side, palmPoint, point, palm) {
  const s = rig.sides[side];
  const p = normalize(palm), d = perpendicular(point, p, s.handDir);
  return addScaled(addScaled(palmPoint, d, -s.palmAlong), p, -s.palmDepth);
}
