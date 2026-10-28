// Fixed-size prop trajectories and measured hand contacts. This is a kinematic
// authoring aid, not a collision or rigid-body physics solver. Scene attachments
// are accepted separately by the renderer after measured contact/velocity gates.
import { ACTIVITY_PROP_LAYOUT, propGripPair, normalizePropState } from './activity-prop-layout.js';
import { solveFullBodyPose, toWorld, toModel, rootRotation } from './full-body-ik.js';
import { add, sub, len, scale, cross, dot, lerp3, qrotate, qconj, qmul, qnormalize, qslerp, qeuler, qaxis, smoother } from './motion-math.js';
import { quinticBoundary, heldPropSides } from './activity-continuity.js';
import { deskLayout, deskWorldFrame } from './activity-desk-layout.js';

const copy = value => structuredClone(value);
const SIDES = ['L', 'R'];
const held = (state, id) => state?.[id] && typeof state[id] === 'object'
  && state[id].visible === true && ['left', 'right', 'both'].includes(state[id].attachment);
const visible = state => state === true || state?.visible === true;
const inverseFrame = (frame, point) => qrotate(qconj(frame.quaternion), sub(point, frame.position));
const transformPoint = (frame, point) => add(frame.position, qrotate(frame.quaternion, point));

const finiteTransform = frame => frame?.position?.length === 3 && frame.position.every(Number.isFinite)
  && frame?.quaternion?.length === 4 && frame.quaternion.every(Number.isFinite) && Math.hypot(...frame.quaternion) > 1e-8;
const rotationVector = input => {
  let q = qnormalize([...input]); if (q[3] < 0) q = q.map(value => -value);
  const sine = Math.hypot(q[0], q[1], q[2]);
  return sine < 1e-10 ? q.slice(0, 3).map(value => 2 * value) : scale(q, 2 * Math.atan2(sine, q[3]) / sine);
};
const rotationFromVector = vector => len(vector) < 1e-10 ? qnormalize([...scale(vector, .5), 1]) : qaxis(vector, len(vector));
const angularVelocity = (before, after, dt) => dt > 1e-8
  ? scale(rotationVector(qmul(after, qconj(before))), 1 / dt) : [0, 0, 0];
// For q(t)=Exp(r(t))*q0, the world angular velocity is J_left(r)*r'.
// Convert the desired final world velocity before fitting the rotation vector;
// otherwise a non-collinear turn has the right angle but a false end velocity.
function inverseLeftJacobian(vector, velocity) {
  const theta = len(vector), coefficient = theta < 1e-5 ? 1 / 12
    : (1 - theta / (2 * Math.tan(theta / 2))) / (theta * theta);
  return add(add(velocity, scale(cross(vector, velocity), -.5)), scale(cross(vector, cross(vector, velocity)), coefficient));
}

/** One rigid transform is interpolated, then both hands are solved to its real
 * geometric grips. This avoids the false assumption that independently eased
 * palm paths retain a fixed grip distance during seated/standing transitions. */
export function buildHeldPropBridge(from, target, { previousFrom = null, fromDt = 0,
  targetProbe = null, targetDt = .001, duration = .42 } = {}) {
  const frames = {};
  for (const [id, fromState] of Object.entries(from?.props ?? {})) {
    const toState = target?.props?.[id], fromSides = heldPropSides(fromState), toSides = heldPropSides(toState);
    const start = fromState?.worldTransform, end = toState?.worldTransform;
    if (!fromSides.length || !toSides.length || !finiteTransform(start) || !finiteTransform(end)) continue;
    const common = fromSides.filter(side => toSides.includes(side));
    if (!common.length) continue; // A real transfer between hands needs its own receipt/overlap, not a crossfade.
    const previous = previousFrom?.props?.[id]?.worldTransform, probe = targetProbe?.props?.[id]?.worldTransform;
    const hasPrevious = finiteTransform(previous) && fromDt > 1e-8, hasProbe = finiteTransform(probe) && targetDt > 1e-8;
    const rotation = rotationVector(qmul(end.quaternion, qconj(start.quaternion)));
    const w0 = hasPrevious ? angularVelocity(previous.quaternion, start.quaternion, fromDt) : [0, 0, 0];
    const w1 = hasProbe ? angularVelocity(end.quaternion, probe.quaternion, targetDt) : [0, 0, 0];
    frames[id] = { start: copy(start), end: copy(end), duration,
      linearVelocityStart: hasPrevious ? scale(sub(start.position, previous.position), 1 / fromDt) : [0, 0, 0],
      linearVelocityEnd: hasProbe ? scale(sub(probe.position, end.position), 1 / targetDt) : [0, 0, 0],
      rotation, rotationVelocityStart: w0, rotationVelocityEnd: inverseLeftJacobian(rotation, w1),
      worldAngularVelocityStart: w0, worldAngularVelocityEnd: w1,
      opennessStart: fromState.openness ?? 1, opennessEnd: toState.openness ?? 1,
      opennessVelocityStart: hasPrevious ? ((fromState.openness ?? 1) - (previousFrom.props[id].openness ?? 1)) / fromDt : 0,
      opennessVelocityEnd: hasProbe ? ((targetProbe.props[id].openness ?? 1) - (toState.openness ?? 1)) / targetDt : 0,
      attachmentDuring: common.length === 2 ? 'both' : common[0] === 'L' ? 'left' : 'right', attachmentEnd: toState.attachment,
      fromState: copy(fromState), toState: copy(toState),
      velocityEvidence: { start: hasPrevious ? 'actual-displayed-transform-difference' : 'no-previous-display-sample',
        end: hasProbe ? 'actual-target-sampler-probe' : 'explicit-stationary-target' } };
  }
  return frames;
}

export function sampleHeldPropBridgeFrame(bridge, elapsed, duration = bridge.duration) {
  const position = bridge.start.position.map((value, index) => quinticBoundary(value, bridge.end.position[index],
    bridge.linearVelocityStart[index], bridge.linearVelocityEnd[index], elapsed, duration));
  const vector = bridge.rotation.map((value, index) => quinticBoundary(0, value,
    bridge.rotationVelocityStart[index], bridge.rotationVelocityEnd[index], elapsed, duration));
  return { position, quaternion: qnormalize(qmul(rotationFromVector(vector), bridge.start.quaternion)), space: 'world' };
}

export function applyHeldPropBridge(rig, pose, frames, elapsed, duration) {
  for (const [id, bridge] of Object.entries(frames ?? {})) {
    const atEnd = elapsed >= duration - 1e-10, attachment = atEnd ? bridge.attachmentEnd : bridge.attachmentDuring;
    const openness = Math.max(0, Math.min(1, quinticBoundary(bridge.opennessStart, bridge.opennessEnd,
      bridge.opennessVelocityStart, bridge.opennessVelocityEnd, elapsed, duration)));
    const frame = sampleHeldPropBridgeFrame(bridge, elapsed, duration);
    pose.props ??= {}; pose.propContactPlans ??= {};
    const pair = propGripPair(id, openness), singleGrip = attachment === 'left' ? pair?.left : attachment === 'right' ? pair?.right : null;
    pose.props[id] = { ...(pose.props[id] ?? bridge.fromState), visible: true, attachment, openness,
      ...(singleGrip ? { grip: copy(singleGrip) } : {}) };
    pose.propContactPlans[id] = { frame, openness, attachment,
      hands: attachment === 'both' ? ['L', 'R'] : [attachment === 'left' ? 'L' : 'R'], ...(singleGrip ? { grip: copy(singleGrip) } : {}) };
    if (id === 'book' && attachment === 'both' && Math.abs(bridge.opennessEnd - bridge.opennessStart) > .05) {
      // Opening a closed book changes the two rigid cover contacts. Guide the
      // elbows inward through the same verified closing posture, with
      // zero adjustment and zero velocity at both bridge boundaries.
      const u = Math.max(0, Math.min(1, elapsed / duration));
      const envelope = 64 * u ** 3 * (1 - u) ** 3;
      for (const [side, inward] of [['L', .3], ['R', .5]]) {
        const pole = pose.hands[side].pole ?? [0, -.3, 1];
        pose.hands[side].pole = [pole[0] - inward * envelope, pole[1], pole[2]];
      }
    }
  }
  return enforceActivityPropContacts(rig, pose);
}

/** The reference book position is in the bind-chest frame, in real PMX units.
 * The cover hinges move the contact points, never the whole book's scale. */
export function readingBookPlan(openness = .8) {
  return { frame: { position: [0, 12.55, 3.05], quaternion: [0, 0, 0, 1], space: 'chest' },
    openness, attachment: 'both', hands: ['L', 'R'] };
}

function frameWorld(rig, pose, fk, frame) {
  if (frame.space === 'route') {
    const progress = Math.max(0, Math.min(1, frame.progress));
    const next = frame.nodes.findIndex(node => node.at >= progress);
    if (next <= 0) return frameWorld(rig, pose, fk, frame.nodes[0].frame);
    const a = frame.nodes[next - 1], b = frame.nodes[next], start = frameWorld(rig, pose, fk, a.frame), end = frameWorld(rig, pose, fk, b.frame);
    const u = smoother((progress - a.at) / (b.at - a.at));
    return { position: lerp3(start.position, end.position, u), quaternion: qslerp(start.quaternion, end.quaternion, u) };
  }
  if (frame.space === 'blend') {
    const from = frameWorld(rig, pose, fk, frame.from), to = frameWorld(rig, pose, fk, frame.to), progress = Math.max(0, Math.min(1, frame.progress));
    return { position: lerp3(from.position, to.position, progress), quaternion: qslerp(from.quaternion, to.quaternion, progress) };
  }
  if (frame.space === 'world') return { position: [...frame.position], quaternion: [...frame.quaternion] };
  if (frame.space === 'chest') {
    if (frame.referenceBody || frame.referencePelvis) {
      const reference = copy(pose), referenceFk = new Map();
      if (frame.referenceBody) reference.body = copy(frame.referenceBody);
      if (frame.referencePelvis) reference.pelvis = copy(frame.referencePelvis);
      solveFullBodyPose(rig, reference, new Map(), referenceFk);
      const plain = { ...frame }; delete plain.referenceBody; delete plain.referencePelvis;
      return frameWorld(rig, reference, referenceFk, plain);
    }
    const chest = fk.get(rig.torso.upperChest.name), rest = rig.torso.upperChest.rest;
    const position = add(chest.position, qrotate(chest.rotation, sub(frame.position, rest)));
    return { position: toWorld(pose.root, position), quaternion: qmul(rootRotation(pose.root), qmul(chest.rotation, frame.quaternion)) };
  }
  const anchor = pose.anchor ?? pose.root;
  return { position: toWorld(anchor, frame.position), quaternion: qmul(rootRotation(anchor), frame.quaternion) };
}

/** Palm definition is the same wrist->middle-finger .45 point used by the real
 * renderer's readHandAnchor. Finger curls cannot change the first finger bone's
 * location, so this is stable while fingers open and close. */
export function measuredPropHand(rig, pose, fk, side) {
  const names = rig.sides[side].names, wrist = fk.get(names.wrist), middle = fk.get(names.fingers.middle[0]);
  return { position: toWorld(pose.root, lerp3(wrist.position, middle.position, .45)),
    quaternion: qmul(rootRotation(pose.root), wrist.rotation) };
}

function desiredGrips(id, plan, world) {
  if (plan.handTargets) return copy(plan.handTargets);
  const pair = propGripPair(id, plan.openness);
  if (plan.attachment === 'both' && pair) return { L: transformPoint(world, pair.left), R: transformPoint(world, pair.right) };
  const side = plan.attachment === 'left' ? 'L' : 'R';
  return { [side]: transformPoint(world, plan.grip ?? ACTIVITY_PROP_LAYOUT[id].grip ?? [0, 0, 0]) };
}

/** Correct wrist targets from actual PMX FK rather than resizing the prop.
 * Each correction is inverse-carried through the current chest transform.
 * Bound iterations retain the existing arm solver/elbow policy unchanged. */
export function enforceActivityPropContacts(rig, pose) {
  const plans = pose?.propContactPlans;
  if (!plans || !Object.keys(plans).length) return { ready: true, props: {} };
  const locals = new Map(), fk = new Map(), results = {};
  solveFullBodyPose(rig, pose, locals, fk);
  for (const [id, plan] of Object.entries(plans)) {
    if (!ACTIVITY_PROP_LAYOUT[id] || !plan?.frame) continue;
    const world = frameWorld(rig, pose, fk, plan.frame), targets = desiredGrips(id, plan, world);
    if (plan.approachFrom) for (const side of Object.keys(targets)) {
      const start = plan.approachFrom[side]?.position ?? plan.approachFrom[side];
      if (start?.length === 3 && start.every(Number.isFinite)) {
        const progress = Math.max(0, Math.min(1, plan.approachProgress ?? 1));
        if (plan.approachVia?.[side]) {
          const points = [{ at: 0, point: start }, ...plan.approachVia[side].map(node => ({ at: node.at, point: frameWorld(rig, pose, fk, node.frame).position })), { at: 1, point: targets[side] }];
          const next = points.findIndex(point => point.at >= progress);
          targets[side] = next <= 0 ? copy(start) : lerp3(points[next - 1].point, points[next].point, smoother((progress - points[next - 1].at) / (points[next].at - points[next - 1].at)));
        } else targets[side] = lerp3(start, targets[side], progress);
      }
    }
    let maximumError = Infinity;
    for (let iteration = 0; iteration < 10; iteration++) {
      maximumError = 0;
      const chest = fk.get(rig.torso.upperChest.name), rootQ = rootRotation(pose.root);
      for (const [side, target] of Object.entries(targets)) {
        if (!pose.hands?.[side]) continue;
        const actual = measuredPropHand(rig, pose, fk, side), error = sub(target, actual.position);
        maximumError = Math.max(maximumError, len(error));
        const restDelta = qrotate(qconj(chest.rotation), qrotate(qconj(rootQ), error));
        const sign = rig.sides[side].sign;
        // Existing activity specs are wrist targets; no anchor-type jump occurs
        // when the continuity controller blends in/out of this constraint.
        pose.hands[side].hand = add(pose.hands[side].hand, [sign * restDelta[0], restDelta[1], restDelta[2]]);
      }
      solveFullBodyPose(rig, pose, locals, fk);
      if (maximumError < 1e-9) break;
    }
    // Near a tightly folded elbow, limited wrist orientation makes palm motion
    // non-linear in the wrist target. The cheap carried-position correction can
    // oscillate there. Use a bounded measured Jacobian only for the unresolved
    // hand; it changes no bone lengths, elbow policy, body pose or prop scale.
    const beforeJacobianErrors = Object.fromEntries(Object.entries(targets).map(([side, target]) => [side, len(sub(target, measuredPropHand(rig, pose, fk, side).position))]));
    const jacobianIterations = {};
    for (const [side, target] of Object.entries(targets)) for (let iteration = 0; iteration < 5; iteration++) {
      const actual = measuredPropHand(rig, pose, fk, side).position, error = sub(target, actual);
      if (len(error) < 1e-8) break;
      jacobianIterations[side] = (jacobianIterations[side] ?? 0) + 1;
      const baseline = copy(pose.hands[side].hand), columns = [], epsilon = 1e-4;
      for (let axis = 0; axis < 3; axis++) {
        pose.hands[side].hand = copy(baseline); pose.hands[side].hand[axis] += epsilon;
        solveFullBodyPose(rig, pose, locals, fk);
        columns.push(scale(sub(measuredPropHand(rig, pose, fk, side).position, actual), 1 / epsilon));
      }
      pose.hands[side].hand = baseline;
      const determinant = dot(columns[0], cross(columns[1], columns[2]));
      if (Math.abs(determinant) < 1e-6) { solveFullBodyPose(rig, pose, locals, fk); break; }
      let step = [dot(error, cross(columns[1], columns[2])) / determinant,
        dot(columns[0], cross(error, columns[2])) / determinant, dot(columns[0], cross(columns[1], error)) / determinant];
      if (len(step) > .5) step = scale(step, .5 / len(step));
      let improved = false;
      for (const weight of [1, .5, .25, .125]) {
        pose.hands[side].hand = add(baseline, scale(step, weight)); solveFullBodyPose(rig, pose, locals, fk);
        if (len(sub(target, measuredPropHand(rig, pose, fk, side).position)) < len(error)) { improved = true; break; }
      }
      if (!improved) { pose.hands[side].hand = baseline; solveFullBodyPose(rig, pose, locals, fk); break; }
    }
    maximumError = Math.max(...Object.entries(targets).map(([side, target]) => len(sub(target, measuredPropHand(rig, pose, fk, side).position))));
    const ready = maximumError <= .025;
    results[id] = { ready, maximumGripError: maximumError, target: copy(world), targets: copy(targets),
      correction: { beforeJacobianErrors, jacobianIterations, method: Object.keys(jacobianIterations).length ? 'bounded-fk-jacobian-fallback' : 'carried-position' },
      reason: ready ? 'measured-grips-match' : 'unreachable-prop-grips' };
    if (pose.props?.[id] && typeof pose.props[id] === 'object') {
      pose.props[id].orientationQuaternion = copy(world.quaternion);
      pose.props[id].orientationSpace = 'world';
      pose.props[id].worldTransform = copy(world);
      pose.props[id].gripReady = ready;
    }
  }
  return { ready: Object.values(results).every(result => result.ready), props: results };
}

function initialFrame(c, id, attachment, fallback) {
  const state = c.initialProps?.[id];
  if (state?.worldTransform) return { ...copy(state.worldTransform), space: 'world' };
  // A context from a previous sampler can carry an explicit rigid plan before
  // the display solver has had a frame. Reuse it rather than guessing hand span.
  const planned = c.initialPose?.propContactPlans?.[id]?.frame;
  if (planned) return copy(planned);
  if (c.initialHandAnchors) {
    const l = c.initialHandAnchors.L ?? c.initialHandAnchors.leftHand;
    const r = c.initialHandAnchors.R ?? c.initialHandAnchors.rightHand;
    if (attachment === 'both' && l?.position && r?.position) {
      const grip = propGripPair(id, state?.openness ?? 1), midpoint = scale(add(l.position, r.position), .5);
      return { position: sub(midpoint, scale(add(grip.left, grip.right), .5)), quaternion: [0, 0, 0, 1], space: 'world' };
    }
    const hand = attachment === 'left' ? l : r;
    if (hand?.position) return { position: sub(hand.position, ACTIVITY_PROP_LAYOUT[id].grip), quaternion: [0, 0, 0, 1], space: 'world' };
  }
  return copy(fallback);
}

function activityFrame(c, frame) {
  const anchor = c.activityAnchor ?? { position: [0, 0, 0], yaw: 0 };
  if (frame.space === 'world') return { position: toModel(anchor, frame.position), quaternion: qmul(qconj(rootRotation(anchor)), frame.quaternion), space: 'activity' };
  return copy(frame);
}

export const PROP_TRANSFER_TIMING = Object.freeze({ approachEnd: 2.35, releaseAt: 2.85, withdrawAt: 3.35, duration: 4.8 });
export const PROP_TAKE_TIMING = Object.freeze({ approachEnd: 1.15, requestAt: 1.45, liftSeconds: 2.35, duration: 4.8 });
export function propPlacementPreparationSeconds(definition, context = {}) {
  return definition?.kind === 'put_prop' && definition.propId === 'book' && deskLayout(context)
    && (context.initialProps?.book?.openness ?? 0) > .05 && !context.bookClosedForPlacement ? 1.4 : 0;
}

const propEuler = rotation => qmul(qmul(qaxis([1, 0, 0], rotation[0]), qaxis([0, 1, 0], rotation[1])), qaxis([0, 0, 1], rotation[2]));
function sourceTableFrame(state, id, actual = null) {
  if (finiteTransform(state.worldTransform)) return { ...copy(state.worldTransform), space: 'world' };
  if (actual?.visible === true && actual.attachment === 'table' && finiteTransform(actual.worldTransform)) return { ...copy(actual.worldTransform), space: 'world' };
  return { position: copy(state.position ?? ACTIVITY_PROP_LAYOUT[id].position),
    quaternion: state.rotation ? propEuler(state.rotation) : id === 'pencil' ? propEuler([Math.PI / 2, 0, -.12]) : [0, 0, 0, 1], space: 'activity' };
}

export function samplePropPickup(pose, t, definition, context = {}) {
  const arrangedDesk = deskLayout(context);
  // The longer lid/desk routes belong to the seated 6.6-second take tracks.
  // A scene can use that furniture layout while executing a standing take;
  // adopting its 2.1-second gate would deadlock the standing 1.45-second clock.
  const desk = definition.initialSupport === 'seated' ? arrangedDesk : null;
  const id = definition.propId, previous = { ...context.sceneProps, ...context.initialProps }, raw = previous[id];
  const source = normalizePropState(raw, id), table = previous.table;
  const sourceExists = source.visible && source.attachment === 'table', tableExists = visible(table);
  pose.props = { ...copy(previous), ...pose.props };
  if (!sourceExists || !tableExists) {
    pose.phase = !sourceExists ? 'take-blocked-missing-table-object' : 'take-blocked-missing-table';
    pose.preparationBlocker = !sourceExists ? 'missing-table-object' : 'missing-table'; return pose;
  }
  if (arrangedDesk && id === 'book' && (previous.laptop?.openness ?? 0) > .05) {
    pose.phase = 'take-blocked-open-laptop'; pose.preparationBlocker = 'close-laptop-before-reaching-behind-screen'; return pose;
  }
  const attachment = ['book', 'box'].includes(id) ? 'both' : 'right', receipt = context.propTransferReceipts?.[id];
  const requiredSides = attachment === 'both' ? ['L', 'R'] : ['R'];
  if (!requiredSides.every(side => context.initialHandAnchors?.[side]?.position?.length === 3 && context.initialHandAnchors[side].position.every(Number.isFinite))) {
    pose.phase = 'take-blocked-unmeasured-start-hands'; pose.preparationBlocker = 'unmeasured-start-hands'; return pose;
  }
  const acquired = receipt?.released === true && receipt.operation === 'take';
  const sourceFrame = acquired ? { ...copy(receipt.transform), space: 'world' } : sourceTableFrame(source, id, context.sceneProps?.[id]);
  const sourceInActivity = sourceFrame.space === 'world' ? toModel(context.activityAnchor ?? pose.root, sourceFrame.position) : sourceFrame.position;
  // A standing reach to the back of an already arranged desk needs the body's
  // verified lean and pelvis range, not longer arms or a moved object. Near-edge
  // sources preserve the original trajectory exactly. The later contact solver
  // still rejects targets beyond this bounded supported reach.
  const standingReach = definition.initialSupport !== 'seated' && ['book', 'mug'].includes(id)
    ? smoother((sourceInActivity[2] - 3.3) / 2) : 0;
  const approachEnd = desk ? 1.8 : PROP_TAKE_TIMING.approachEnd, requestAt = desk ? 2.1 : PROP_TAKE_TIMING.requestAt;
  const approach = smoother(t / approachEnd), liftAge = acquired ? Math.max(0, t - (receipt.activityElapsed ?? requestAt)) : 0;
  const liftSeconds = desk && ['book', 'mug'].includes(id) ? 3.9 : PROP_TAKE_TIMING.liftSeconds;
  const lift = acquired ? Math.max(0, Math.min(1, liftAge / liftSeconds)) : 0, smoothLift = smoother(lift);
  const initialBody = context.initialPose?.body ?? {};
  const reachLean = id === 'box' ? .19 : id === 'pencil' && desk ? .5 : id === 'pencil' || desk ? .48 : definition.initialSupport === 'seated' ? .24 : .19 + .41 * standingReach;
  const endLean = id === 'pencil' ? .12 : 0;
  const recoverBody = desk && ['book', 'mug'].includes(id) ? smoother((lift - .3) / .4) : smoothLift;
  pose.body.lean = acquired ? reachLean + (endLean - reachLean) * recoverBody : (initialBody.lean ?? 0) + (reachLean - (initialBody.lean ?? 0)) * approach;
  pose.body.headPitch = acquired ? .12 * (1 - smoothLift) : .12 * approach;
  if (desk && definition.initialSupport === 'seated') {
    const seat = context.initialPose?.pelvis?.offset ?? pose.pelvis.offset;
    const reachForward = id === 'book' ? 1.5 : id === 'mug' ? 1.2 : .2;
    const restingZ = ACTIVITY_PROP_LAYOUT.chair.position[2], reachingZ = restingZ + reachForward;
    pose.pelvis.offset[2] = acquired ? reachingZ + (restingZ - reachingZ) * recoverBody
      : seat[2] + (reachingZ - seat[2]) * approach;
  }
  if (definition.initialSupport !== 'seated') {
    const drop = id === 'box' ? 2.609 : 3.4;
    const initialPelvis = context.initialPose?.pelvis?.offset ?? [0, 0, 0];
    pose.pelvis.offset[1] = acquired ? -drop * (1 - smoothLift) : initialPelvis[1] + (-drop - initialPelvis[1]) * approach;
    const reachForward = -.3 + .9 * standingReach;
    pose.pelvis.offset[2] = acquired ? reachForward * (1 - smoothLift) : initialPelvis[2] + (reachForward - initialPelvis[2]) * approach;
  }
  let destination;
  if (id === 'book') {
    destination = readingBookPlan(source.openness).frame;
    if (definition.initialSupport === 'seated') destination.position[1] = desk ? 14.4 : 13.9;
    if (source.openness < .3) destination.quaternion = qeuler(0, Math.PI / 2, 0);
  } else if (id === 'mug') destination = { position: [-1.15, definition.initialSupport === 'seated' ? 13.48 : 12.08, desk ? 2.25 : 2.8], quaternion: qeuler(0, Math.PI, 0), space: 'chest' };
  else if (id === 'pencil') destination = desk ? deskWorldFrame(context, [-3.2, 8.961, 3.02], qeuler(.34, 0, -.28)) : { position: [-.8, 8.961, 3.22], quaternion: qeuler(.34, 0, -.28), space: 'activity' };
  else destination = { position: [0, 11.9, 3.1], quaternion: [0, 0, 0, 1], space: 'chest' };
  if (destination.space === 'chest') {
    destination.referenceBody = { ...pose.body, lean: endLean, headPitch: 0 };
    destination.referencePelvis = { ...copy(pose.pelvis), offset: definition.initialSupport === 'seated' ? copy(context.initialPose?.pelvis?.offset ?? pose.pelvis.offset) : [0, 0, 0] };
  }
  let frame = acquired ? { space: 'blend', from: sourceFrame, to: destination, progress: smoothLift } : sourceFrame;
  if (desk && acquired && id === 'book') frame = { space: 'route', progress: lift, nodes: [{ at: 0, frame: sourceFrame },
    { at: .3, frame: deskWorldFrame(context, [0, 10.4, 6.6], desk.placementTargets.book.quaternion) },
    { at: .7, frame: deskWorldFrame(context, [0, 10.4, 1.3], desk.placementTargets.book.quaternion) }, { at: 1, frame: destination }] };
  if (desk && acquired && id === 'mug') frame = { space: 'route', progress: lift, nodes: [{ at: 0, frame: sourceFrame },
    { at: .3, frame: deskWorldFrame(context, [-3.5, 10.5, 5.3]) },
    { at: .7, frame: deskWorldFrame(context, [-3.5, 10.5, .9]) }, { at: 1, frame: destination }] };
  const plan = { frame, attachment, openness: source.openness, hands: attachment === 'both' ? ['L', 'R'] : ['R'] };
  if (!acquired) {
    plan.approachFrom = copy(context.initialHandAnchors ?? {});
    plan.approachProgress = desk ? Math.max(0, Math.min(1, t / approachEnd)) : approach;
    if (desk) {
      plan.approachVia = {};
      for (const side of requiredSides) {
        const x = id === 'book' ? side === 'L' ? 1.1 : -1.1 : id === 'mug' ? -2.55 : -2.65;
        const z = id === 'book' ? 5.78 : id === 'mug' ? 5.3 : 4.3;
        plan.approachVia[side] = [{ at: .4, frame: deskWorldFrame(context, [x, 10.1, id === 'book' ? 2.6 : .9]) }, { at: .75, frame: deskWorldFrame(context, [x, 10.1, z]) }];
      }
    }
  }
  pose.propContactPlans = { [id]: plan };
  if (desk) for (const side of requiredSides) pose.hands[side].pole = [0, -.3, 1];
  pose.props[id] = { ...copy(source), visible: true, attachment: acquired ? attachment : 'table', openness: source.openness,
    transfer: acquired ? undefined : { operation: 'take', from: 'table', to: attachment, target: copy(sourceFrame), requestTake: t >= requestAt,
      maximumGripError: .025, positionTolerance: .025, angleTolerance: .09, maximumRelativeSpeed: .32, maximumAngularSpeed: .5, settleSeconds: .16 } };
  pose.phase = !acquired ? t < PROP_TAKE_TIMING.approachEnd ? 'taking-approach' : 'taking-contact-request' : lift < 1 ? 'taking-lift-after-receipt' : 'held-after-measured-take';
  pose.preparationBlocker = null;
  return pose;
}

export function bookSupportBounds(openness, quaternion) {
  const closure = (1 - openness) * 1.5, corners = [];
  const addBox = (size, center, hinge = 0) => {
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const point = add(center, [x * size[0] / 2, y * size[1] / 2, z * size[2] / 2]);
      corners.push(qrotate(quaternion, qrotate(qaxis([0, 0, 1], hinge), point)));
    }
  };
  for (const sign of [-1, 1]) { addBox([1.68, .09, 2.6], [sign * .86, -.12, 0], sign * closure); addBox([1.57, .15, 2.43], [sign * .84, 0, 0], sign * closure); }
  addBox([.12, .2, 2.65], [0, -.08, 0]);
  return { min: [0, 1, 2].map(i => Math.min(...corners.map(point => point[i]))), max: [0, 1, 2].map(i => Math.max(...corners.map(point => point[i]))) };
}
const bookMinimumY = (openness, quaternion) => bookSupportBounds(openness, quaternion).min[1];

/** Preserve a held book above a real tabletop during a seated transfer. This
 * edits only the rigid prop/hand goal; root, pelvis, legs and elbow policy remain
 * the original trajectory. It is a local support-plane constraint, not a
 * general obstacle planner. A C2 positive part avoids a hard velocity clamp. */
export function applyHeldPropTableClearance(rig, pose, tableState) {
  const table = tableState?.worldTransform;
  if (!finiteTransform(table) || tableState.visible !== true) return { ready: true, corrections: [] };
  const plan = pose.propContactPlans?.book, state = pose.props?.book;
  if (!plan || !held(pose.props, 'book')) return { ready: true, corrections: [] };
  const fk = new Map(); solveFullBodyPose(rig, pose, new Map(), fk);
  plan.clearanceSourceFrame ??= copy(plan.frame);
  const world = frameWorld(rig, pose, fk, plan.clearanceSourceFrame), inverse = qconj(table.quaternion);
  const center = qrotate(inverse, sub(world.position, table.position)), bounds = bookSupportBounds(state.openness ?? 1, qmul(inverse, world.quaternion));
  const overlapX = Math.min(center[0] + bounds.max[0] + 5, 5 - center[0] - bounds.min[0]);
  const overlapZ = Math.min(center[2] + bounds.max[2] + 2.5, 2.5 - center[2] - bounds.min[2]);
  const gate = smoother(overlapX / .35) * smoother(overlapZ / .35), gap = 8.9 + .12 - center[1] - bounds.min[1], epsilon = .04;
  const u = Math.max(0, Math.min(1, gap / epsilon));
  const positive = gap <= 0 ? 0 : gap >= epsilon ? gap : epsilon * (6 * u ** 3 - 8 * u ** 4 + 3 * u ** 5);
  const lift = positive * gate;
  plan.frame = { position: add(world.position, qrotate(table.quaternion, [0, lift, 0])), quaternion: world.quaternion, space: 'world' };
  const result = enforceActivityPropContacts(rig, pose);
  return { ...result, corrections: lift > 0 ? [{ id: 'book', lift, supportPlane: 8.9, margin: .12, source: 'actual-rendered-table' }] : [] };
}

/** Deterministic put-down recipe. The table must exist in real inherited scene
 * state or explicit context; declaring a requirement never creates furniture.
 * A missing source object/surface leaves the existing hold intact and reports a
 * blocked operation. Completion is a request, not a successful handoff receipt. */
export function samplePropPlacement(pose, t, definition, context = {}) {
  const closingSeconds = propPlacementPreparationSeconds(definition, context);
  if (closingSeconds) {
    const source = context.initialProps.book, actual = source.worldTransform;
    if (finiteTransform(actual)) {
      const openness = source.openness * (1 - smoother(t / closingSeconds));
      const turn = value => smoother(((1 - value) * 1.5 - .9) / .6) * Math.PI / 2;
      const frame = { position: copy(actual.position), quaternion: qmul(actual.quaternion,
        qeuler(0, turn(openness) - turn(source.openness), 0)), space: 'world' };
      const initial = context.initialPose;
      pose.body = copy(initial.body); pose.pelvis = copy(initial.pelvis); pose.hands = copy(initial.hands);
      // The inward elbow path was validated against the actual moving cover
      // grips. Opening angle changes physically before any release is requested.
      pose.hands.R.pole = [-.5, -.3, 1];
      pose.props = { ...copy(context.initialProps), book: { ...copy(source), openness, transfer: undefined } };
      pose.propContactPlans = { book: { frame, openness, attachment: 'both', hands: SIDES } };
      pose.phase = 'placing-close-book';
      if (t <= closingSeconds) return pose;
      const closed = { ...pose.props.book, worldTransform: frame };
      return samplePropPlacement(pose, t - closingSeconds, definition, { ...context, bookClosedForPlacement: true,
        initialProps: { ...context.initialProps, book: closed },
        initialPose: { ...initial, hands: pose.hands, props: { ...initial.props, book: closed } } });
    }
  }
  const desk = deskLayout(context);
  const id = definition.propId, previous = context.initialProps ?? {}, state = previous[id];
  const attachment = id === 'book' ? 'both' : 'right';
  const table = context.sceneProps?.table ?? previous.table;
  const sourceHeld = held(previous, id), surfaceAvailable = visible(table);
  const valid = sourceHeld && surfaceAvailable;
  const fallback = id === 'book' ? readingBookPlan(state?.openness ?? .8).frame : {
    position: id === 'mug' ? [-1.15, 12.1, 2.8] : [-.8, 9.4, 3.1], quaternion: [0, 0, 0, 1], space: 'activity' };
  const initial = activityFrame(context, initialFrame(context, id, attachment, fallback));
  const configuredTarget = context.propPlacementTargets?.[id] ?? desk?.placementTargets?.[id];
  const targetSpec = desk && configuredTarget ? activityFrame(context, deskWorldFrame(context, configuredTarget.position, configuredTarget.quaternion)) : configuredTarget;
  // Put the closed/open book onto its actual lowest geometric point, the cup
  // base upright, or the pencil horizontally. Targets can be overridden only
  // within a real surface; renderer checks the actual footprint and height.
  const openness = state?.openness ?? (id === 'book' ? .8 : 1);
  const bookQuaternion = openness < .3 ? qmul(qeuler(0, Math.PI / 2, 0), qeuler(0, 0, -Math.PI / 2)) : [0, 0, 0, 1];
  const target = targetSpec ? { ...copy(targetSpec), space: targetSpec.space ?? 'activity' } : {
    position: id === 'book' ? [0, ACTIVITY_PROP_LAYOUT.table.top - bookMinimumY(openness, bookQuaternion), 3.7]
      : id === 'mug' ? [-2.55, ACTIVITY_PROP_LAYOUT.table.top, 3.55] : [-2.6, ACTIVITY_PROP_LAYOUT.table.top + .061, 3.55],
    quaternion: id === 'pencil' ? qeuler(0, 0, -Math.PI / 2) : id === 'book' ? bookQuaternion : [0, 0, 0, 1], space: 'activity' };
  const alreadyAtTarget = initial.space === target.space && len(sub(initial.position, target.position)) < .09
    && Math.abs(initial.quaternion.reduce((sum, value, i) => sum + value * target.quaternion[i], 0)) > .999;
  // When held in a chest frame, keep the frame until the controller can provide
  // an initial worldTransform. A missing transform cannot silently claim success.
  const readyFrame = initial.space !== 'chest' && target.space === initial.space;
  const active = valid && readyFrame;
  const approachEnd = desk && ['book', 'mug'].includes(id) ? 4 : PROP_TRANSFER_TIMING.approachEnd;
  const releaseAt = desk && ['book', 'mug'].includes(id) ? 4.5 : PROP_TRANSFER_TIMING.releaseAt;
  const progress = active ? Math.max(0, Math.min(1, t / approachEnd)) : 0, u = smoother(progress);
  const targetInActivity = target.space === 'world' ? toModel(context.activityAnchor ?? pose.root, target.position) : target.position;
  const standingReach = definition.initialSupport !== 'seated' && desk && ['book', 'mug'].includes(id)
    ? smoother((targetInActivity[2] - 3.3) / 2) : 0;
  const initialBody = context.initialPose?.body ?? {};
  pose.body = { ...pose.body, ...copy(initialBody),
    lean: (initialBody.lean ?? 0) + ((desk ? .48 + .12 * standingReach : definition.initialSupport === 'seated' ? .24 : .19) - (initialBody.lean ?? 0)) * (desk && ['book', 'mug'].includes(id) ? smoother((progress - .3) / .4) : u),
    headPitch: (initialBody.headPitch ?? 0) + (.12 - (initialBody.headPitch ?? 0)) * u };
  for (const key of ['side', 'twist', 'headYaw', 'headRoll']) pose.body[key] = (initialBody[key] ?? 0) * (1 - u);
  pose.pelvis.offset[0] = (context.initialPose?.pelvis?.offset?.[0] ?? 0) * (1 - u);
  if (desk && definition.initialSupport === 'seated') {
    const seat = context.initialPose?.pelvis?.offset ?? pose.pelvis.offset, reach = id === 'book' ? 1.5 : id === 'mug' ? 1.2 : .2;
    const finalReach = ACTIVITY_PROP_LAYOUT.chair.position[2] + reach;
    pose.pelvis.offset[2] = seat[2] + (finalReach - seat[2]) * smoother((progress - .3) / .4);
  } else if (definition.initialSupport === 'seated') {
    // A replacement can arrive in the exact acquisition frame, before the
    // previous take has withdrawn its supported forward reach. Start from
    // that attained pelvis instead of resetting to the nominal seated pose.
    const seat = context.initialPose?.pelvis?.offset ?? pose.pelvis.offset;
    pose.pelvis.offset = lerp3(seat, pose.pelvis.offset, u);
  }
  if (definition.initialSupport !== 'seated') {
    const initialPelvis = context.initialPose?.pelvis?.offset ?? [0, 0, 0];
    pose.pelvis.offset[1] = initialPelvis[1] + (-3.4 - initialPelvis[1]) * u;
    pose.pelvis.offset[2] = initialPelvis[2] + (-.3 + .9 * standingReach - initialPelvis[2]) * u;
  }
  let frame = { position: lerp3(initial.position, target.position, u), quaternion: qslerp(initial.quaternion, target.quaternion, u), space: initial.space };
  // Clear the desk edge with a shallow lift; no size or amplitude reduction.
  frame.position[1] += active ? .25 * Math.sin(Math.PI * u) ** 2 : 0;
  if (desk && id === 'book' && !alreadyAtTarget) frame = { space: 'route', progress, nodes: [{ at: 0, frame: initial },
    { at: .3, frame: deskWorldFrame(context, [0, 10.4, 1.3], configuredTarget.quaternion) },
    { at: .7, frame: deskWorldFrame(context, [0, 10.4, 6.6], configuredTarget.quaternion) }, { at: 1, frame: target }] };
  if (desk && id === 'mug' && !alreadyAtTarget) frame = { space: 'route', progress, nodes: [{ at: 0, frame: initial },
    { at: .2, frame: deskWorldFrame(context, [-1.15, 10.5, .9], qeuler(0, Math.PI, 0)) },
    { at: .45, frame: deskWorldFrame(context, [-3.5, 10.5, .9]) },
    { at: .75, frame: deskWorldFrame(context, [-3.5, 10.5, 5.3]) }, { at: 1, frame: target }] };
  pose.props = { ...copy(previous), ...pose.props };
  if (!sourceHeld) { pose.phase = 'place-blocked-missing-held-object'; pose.preparationBlocker = 'missing-held-object'; return pose; }
  pose.props[id] = { ...copy(state), visible: true, attachment, openness, pageTurn: 0,
    transfer: { operation: 'place', to: 'table', target: copy(target), requestRelease: active && t >= releaseAt,
      surface: 'table', positionTolerance: .09, angleTolerance: .09, maximumRelativeSpeed: .32,
      maximumAngularSpeed: .35, settleSeconds: .16 } };
  pose.propContactPlans = { [id]: { frame, openness, attachment, hands: attachment === 'both' ? SIDES : ['R'] } };
  if (desk) for (const side of attachment === 'both' ? SIDES : ['R']) pose.hands[side].pole = [0, -.3, 1];
  pose.phase = !surfaceAvailable ? 'place-blocked-missing-table' : !readyFrame ? 'place-blocked-unmeasured-source'
    : t < approachEnd ? 'placing-approach' : t < releaseAt ? 'placing-settle' : 'placing-release-request';
  pose.preparationBlocker = !surfaceAvailable ? 'missing-table' : !readyFrame ? 'unmeasured-source-transform' : null;
  // The controller/renderer handshake decides when hands may withdraw. The
  // renderer receipt is supplied back through context, never inferred from time.
  const receipt = context.propTransferReceipts?.[id];
  if (receipt?.released === true && receipt?.operation === 'place') {
    pose.props[id] = { ...pose.props[id], attachment: 'table', worldTransform: copy(receipt.transform), transfer: undefined };
    delete pose.propContactPlans;
    pose.phase = 'placed-with-receipt';
  }
  return pose;
}

export function propTransferSourceHeld(props, id) { return !!held(props, id); }
