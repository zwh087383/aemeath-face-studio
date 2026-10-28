import { ACTIVITY_PROP_LAYOUT } from './activity-prop-layout.js';
import { toWorld, toModel, rootRotation } from './full-body-ik.js';
import { qrotate, sub } from './motion-math.js';
import { PARTITIONED_DESK } from './activity-desk-layout.js';

const yawOf = q => Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] ** 2 + q[2] ** 2));
const angle = x => Math.atan2(Math.sin(x), Math.cos(x));
export function measuredChairAnchor(sceneProps) {
  const frame = sceneProps?.chair?.worldTransform;
  if (!sceneProps?.chair?.visible || !frame?.position || !frame?.quaternion) return null;
  const yaw = yawOf(frame.quaternion);
  return { position: sub(frame.position, qrotate(rootRotation({ yaw }), ACTIVITY_PROP_LAYOUT.chair.position)), yaw };
}

export function seatEntryStandingRoot(sceneProps, context) {
  const anchor = measuredChairAnchor(sceneProps);
  if (!anchor) return null;
  const advance = 3.3 - context.feet.L[2];
  return { position: toWorld(anchor, [0, 0, advance]), yaw: anchor.yaw };
}

/** Explicit initial laboratory scene, not a runtime furniture mutation. */
export function pulledOutDeskEntryFixture(context, { retreat = 7, props = PARTITIONED_DESK.setupProps } = {}) {
  if (!(retreat >= 5.5 && retreat <= 7)) throw new RangeError('Unverified initial chair pull-out');
  const sceneProps = { ...structuredClone(props), chair: { visible: true, attachment: 'floor', position: [0, 0, -1.2 - retreat] } };
  const measured = { chair: { visible: true, worldTransform: { position: sceneProps.chair.position, quaternion: [0, 0, 0, 1] } } };
  return { sceneProps, initialRoot: seatEntryStandingRoot(measured, context), retreat,
    prerequisites: ['sit_down', 'approach_desk_seated'] };
}

function standingOverlapsTable(root, sceneProps) {
  const frame = sceneProps?.table?.worldTransform;
  if (!sceneProps?.table?.visible || !frame) return false;
  const point = toModel({ position: frame.position, yaw: yawOf(frame.quaternion) }, root.position);
  // Standing torso/legs need space, not merely an ankle-sized slot between a
  // chair and a desk. Bounds come from the same actual furniture geometry.
  return Math.abs(point[0]) < ACTIVITY_PROP_LAYOUT.table.size[0] / 2 + 1.1
    && Math.abs(point[2]) < ACTIVITY_PROP_LAYOUT.table.size[2] / 2 + 1.1;
}

function obstructedFloorRoute(scene, anchor, minimumZ, maximumZ) {
  for (const id of ['box', 'platform']) {
    const state = scene[id], size = ACTIVITY_PROP_LAYOUT[id].size;
    if (!state?.visible || state.attachment !== 'floor' || !state.worldTransform || !size) continue;
    const p = toModel(anchor, state.worldTransform.position);
    if (Math.abs(p[0]) < 3.3 + Math.hypot(size[0], size[2]) / 2
      && p[2] + Math.hypot(size[0], size[2]) / 2 > minimumZ
      && p[2] - Math.hypot(size[0], size[2]) / 2 < maximumZ) return id;
  }
  return null;
}

export function seatAccess(controller, id) {
  const definition = controller.library[id], scene = controller.sceneProps;
  const anchor = measuredChairAnchor(scene);
  if (!anchor) return { accepted: true, context: {} }; // Pure legacy samplers have no measured scene; director still requires a real chair.
  const seated = controller.pose.support === 'seated';
  const needsSeat = definition?.initialSupport === 'seated';
  if (id === 'approach_desk_seated') {
    if (!seated) return { accepted: false, reason: 'desk_approach_requires_actual_seat' };
    const seatPoint = toModel(anchor, toWorld(controller.root, [controller.pose.pelvis.offset[0],
      10.55 + controller.pose.pelvis.offset[1], controller.pose.pelvis.offset[2]]));
    if (Math.abs(seatPoint[1] - 6.1) > .08 || Math.abs(seatPoint[0]) > .18 || Math.abs(seatPoint[2] + 1.2) > .18)
      return { accepted: false, reason: 'desk_approach_seat_contact_lost' };
    const table = scene.table?.worldTransform;
    if (!scene.table?.visible || !table) return { accepted: false, reason: 'desk_approach_requires_actual_table' };
    if (Math.abs(angle(yawOf(table.quaternion) - anchor.yaw)) > .04) return { accepted: false, reason: 'chair_table_heading_mismatch' };
    const local = toModel(anchor, table.position), advance = local[2] - ACTIVITY_PROP_LAYOUT.table.position[2];
    if (Math.abs(local[0]) > .08 || Math.abs(local[1]) > .04) return { accepted: false, reason: 'chair_table_alignment_mismatch' };
    if (advance < .15 || advance > 7.05) return { accepted: false, reason: advance < .15 ? 'already_at_desk' : 'desk_approach_too_far' };
    const obstacle = obstructedFloorRoute(scene, anchor, -3.8, advance + 3.9);
    if (obstacle) return { accepted: false, reason: 'seat_route_obstructed', obstacle };
    return { accepted: true, context: { deskAdvance: advance } };
  }
  if (id === 'stand_up_from_desk' && seated) {
    const obstacle = obstructedFloorRoute(scene, anchor, -10.85, 3.9);
    if (obstacle) return { accepted: false, reason: 'seat_route_obstructed', obstacle };
  }
  const entering = !seated && (definition?.kind === 'sit_down' || needsSeat);
  const rising = seated && id !== 'stand_up_from_desk' && id !== 'approach_desk_seated' && !needsSeat;
  if (!entering && !rising) return { accepted: true, context: {} };
  const root = seatEntryStandingRoot(scene, controller.context);
  if (standingOverlapsTable(root, scene)) return { accepted: false, reason: entering ? 'seat_entry_space_blocked' : 'seat_exit_space_blocked', requiredStandingRoot: root };
  const obstacle = obstructedFloorRoute(scene, anchor, -3.8, 5.5);
  if (obstacle) return { accepted: false, reason: 'seat_route_obstructed', obstacle };
  if (entering) {
    const relative = toModel(root, controller.root.position);
    // A short straight approach from the free front corridor is permitted.
    // Side/back entry still requires an explicit route, never a diagonal bridge
    // through the chair. Both corridor endpoints must clear the same desk.
    if (Math.abs(relative[0]) > .18 || Math.abs(relative[1]) > .04 || relative[2] < -.18 || relative[2] > 5
      || standingOverlapsTable(controller.root, scene) || Math.abs(angle(controller.root.yaw - root.yaw)) > .04)
      return { accepted: false, reason: 'seat_entry_requires_front_approach', requiredStandingRoot: root };
  }
  return { accepted: true, context: { safeSeatEntry: true }, requiredStandingRoot: root };
}
