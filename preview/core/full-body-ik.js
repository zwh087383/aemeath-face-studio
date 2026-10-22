import { buildRig, forwardKinematics, handRelative, solveArm, wristFromPalm } from './motion-skeleton.js';
import { AEMEATH_MOTION_BINDING, POSTURES } from './motion-profile.js';
import { add, sub, scale, len, normalize, perpendicular, cross, clamp, qaxis, qconj, qmul, qnormalize, qrotate, qfromFrames, qeuler, qid } from './motion-math.js';

const SIDES = ['L', 'R'];
const UP = [0, 1, 0], FORWARD = [0, 0, 1];
export const rootRotation = root => qaxis(UP, root?.yaw ?? 0);
export const toWorld = (root, point) => add(root?.position ?? [0, 0, 0], qrotate(rootRotation(root), point));
export const toModel = (root, point) => qrotate(qconj(rootRotation(root)), sub(point, root?.position ?? [0, 0, 0]));

/** The existing torso/hand solver remains unchanged. This separate adapter adds
 * world-space ankle goals and actual pelvis translation for whole-body clips.
 * Drive the original PMX leg chain, then let MMD grants update D-bones once. */
export function buildFullBodyRig(skeleton) {
  const rig = buildRig(skeleton, AEMEATH_MOTION_BINDING);
  if (!rig.support || SIDES.some(side => !rig.legs[side])) throw new Error('Full-body activities require two complete hip/knee/ankle/toe chains');
  rig.context = {
    feet: Object.fromEntries(SIDES.map(side => [side, [...rig.legs[side].target]])),
    legLengths: Object.fromEntries(SIDES.map(side => [side, [rig.legs[side].L1, rig.legs[side].L2]])),
    pelvisHeight: rig.pos(rig.support.root)[1], hipHeight: rig.pos(rig.legs.L.names.hip)[1],
  };
  return rig;
}

/** Analytic two-bone IK. Contact goals stay in world space while the root travels.
 * The forward knee plane is explicit: the PMX's almost-straight bind legs point
 * slightly backwards and must not determine the bend direction for a squat. */
export function solveLegTargets(rig, locals, feet, root, fk = new Map()) {
  forwardKinematics(rig, locals, fk);
  const diagnostics = {};
  for (const side of SIDES) {
    const leg = rig.legs[side], goal = feet[side], { names, L1, L2 } = leg;
    const target = toModel(root, goal.position), hip = fk.get(names.hip).position;
    const parent = fk.get(rig.parentOf(names.hip)), ray = sub(target, hip), distance = len(ray);
    const direction = distance > 1e-8 ? scale(ray, 1 / distance) : [0, -1, 0];
    const reach = clamp(distance, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
    const desiredPole = goal.pole ?? [side === 'L' ? .03 : -.03, 0, 1];
    const plane = perpendicular(desiredPole, direction, [0, 0, 1]);
    const cosine = clamp((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach), -1, 1);
    const upper = normalize(add(scale(direction, cosine), scale(plane, Math.sqrt(Math.max(0, 1 - cosine * cosine)))));
    const knee = add(hip, scale(upper, L1));
    const lower = normalize(sub(add(hip, scale(direction, reach)), knee));
    const hinge = normalize(cross(upper, lower));
    const thigh = qfromFrames(leg.upper, leg.hinge, upper, hinge);
    const shin = qfromFrames(leg.lower, leg.hinge, lower, hinge);
    const ankle = qmul(qconj(rootRotation(root)), goal.rotation ?? rootRotation(root));
    locals.set(names.hip, qnormalize(qmul(qconj(parent.rotation), thigh)));
    locals.set(names.knee, qnormalize(qmul(qconj(thigh), shin)));
    locals.set(names.ankle, qnormalize(qmul(qconj(shin), ankle)));
    diagnostics[side] = { contact: !!goal.contact, target: [...goal.position], unreachable: Math.max(0, distance - reach),
      bend: Math.acos(clamp((L1 * L1 + L2 * L2 - reach * reach) / (2 * L1 * L2), -1, 1)), knee: toWorld(root, knee) };
  }
  forwardKinematics(rig, locals, fk);
  for (const side of SIDES) {
    const actual = toWorld(root, fk.get(rig.legs[side].names.ankle).position);
    diagnostics[side].actual = actual;
    diagnostics[side].error = len(sub(actual, diagnostics[side].target));
  }
  return diagnostics;
}

export function solveFullBodyPose(rig, pose, locals = new Map(), fk = new Map()) {
  if (!pose?.root?.position || !Number.isFinite(pose.root.yaw ?? 0)
    || !pose.root.position.every(Number.isFinite)
    || SIDES.some(side => !pose.feet?.[side]?.position?.every(Number.isFinite))) {
    throw new TypeError('Full-body pose requires finite root and ankle targets');
  }
  locals.clear(); locals.translations ??= new Map(); locals.translations.clear();
  const pelvis = pose.pelvis ?? {}, body = pose.body ?? {}, t = rig.torso;
  locals.translations.set(rig.support.root, [...(pelvis.offset ?? [0, 0, 0])]);
  // Waist stays unrotated: its PMX cancellation grants otherwise alter the leg
  // parent frame after IK. Lower-body tilt is an independent anatomical channel.
  locals.set(rig.support.pelvis, qeuler(pelvis.pitch ?? 0, pelvis.yaw ?? 0, pelvis.roll ?? 0));
  const lean = clamp(body.lean ?? 0, -1, 1.2), twist = clamp(body.twist ?? 0, -.85, .85), side = clamp(body.side ?? 0, -.65, .65);
  locals.set(t.spine.name, qeuler(lean * .56, twist * .4, side * .42));
  locals.set(t.chest.name, qeuler(lean * .29, twist * .35, side * .34));
  locals.set(t.upperChest.name, qeuler(lean * .15, twist * .25, side * .24));
  const headPitch = (body.headPitch ?? 0) - lean * .32, headYaw = (body.headYaw ?? 0) - twist * .3;
  locals.set(t.neck.name, qeuler(headPitch * .35, headYaw * .35, (body.headRoll ?? 0) * .4));
  locals.set(t.head.name, qeuler(headPitch * .65, headYaw * .65, (body.headRoll ?? 0) * .6));
  locals.set(t.eyes.name, qeuler(body.gazePitch ?? 0, body.gazeYaw ?? 0, 0));
  const legs = solveLegTargets(rig, locals, pose.feet, pose.root, fk);
  const chest = fk.get(t.upperChest.name), arms = {};
  for (const sideName of SIDES) {
    const sign = rig.sides[sideName].sign, raw = { ...POSTURES.relaxed[sideName], ...pose.hands?.[sideName] };
    const mirror = vector => [sign * vector[0], vector[1], vector[2]];
    const spec = { ...raw, hand: mirror(raw.hand), pole: mirror(raw.pole), palm: mirror(raw.palm), point: mirror(raw.point) };
    if (raw.anchor === 'palm') spec.hand = wristFromPalm(rig, sideName, spec.hand, spec.point, spec.palm);
    Object.assign(spec, handRelative(rig, sideName, spec));
    arms[sideName] = solveArm(rig, sideName, spec, chest.rotation, chest.position, locals, {});
  }
  forwardKinematics(rig, locals, fk);
  const finite = [...locals.values()].flat().concat([...locals.translations.values()].flat()).every(Number.isFinite);
  if (!finite) throw new Error('Non-finite full-body pose');
  return { legs, arms, finite };
}
