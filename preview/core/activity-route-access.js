import { solveFullBodyPose, toWorld } from './full-body-ik.js';
import { sub, qconj, qrotate, qeuler } from './motion-math.js';

const IDENTITY = [0, 0, 0, 1];
const copy = value => structuredClone(value);
const finite = (v, count) => Array.isArray(v) && v.length === count && v.every(Number.isFinite);
const box = (name, center, size, rotation = IDENTITY) => ({ name, center, size, rotation });

// Actual parts of createTable/createChair/createCarryBox/createPlatform, in
// each object's own frame. Furniture is not treated as one filled AABB: a safe
// route beside a pulled-out seat remains possible. Rounded corners are bounded
// conservatively; this is mechanical clearance, not a skin/cloth simulation.
export const ACTIVITY_ROUTE_PARTS = Object.freeze({
  table: [box('tabletop', [0, 8.625, 0], [10, .55, 5]),
    box('table-edge', [0, 8.25, 0], [9.7, .2, 4.7]),
    ...[-3.95, 3.95].flatMap(x => [
      ...[-1.7, 1.7].map(z => box('table-leg', [x, 4.165, z], [.3, 7.97, .3])),
      box('table-foot', [x, .22, 0], [.32, .32, 3.7]),
      box('table-brace', [x, 7.5, 0], [.26, .26, 3.4])]),
    box('rear-crossbar', [0, 7.65, 1.7], [7.9, .24, .24])],
  chair: [box('seat', [0, 5.8, 0], [6.6, .6, 5.2]),
    box('seat-frame', [0, 5.34, 0], [6.35, .32, 4.95]),
    box('backrest', [0, 10.4, -2.35], [6.1, .55, 4.6], qeuler(Math.PI / 2 - .1, 0, 0)),
    ...[-1, 1].flatMap(x => [-1, 1].map(z =>
      box('chair-leg-envelope', [x * 2.625, 2.675, z * 2.015], [.79, 5.49, .77]))),
    ...[-2.65, 2.65].map(x => box('back-upright-envelope', [x, 8.975, -2.325], [.4, 7.95, 1.25])),
    box('back-top', [0, 12.75, -2.75], [5.78, .34, .34])],
  box: [box('carry-box', [0, 1.5, 0], [4.33, 3.03, 3.54])],
  platform: [box('step-body', [0, .575, 0], [7, 1.15, 4.4]),
    box('nonslip-top', [0, 1.2, 0], [6.8, .1, 4.2])],
});

export function needsActivityRouteCheck(definition) {
  return ['gait', 'jump', 'carry'].includes(definition?.kind);
}

function segmentBox(first, second, half, radius) {
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    // Exact surface contact is not penetration. A small body envelope also
    // catches a thin obstacle between the measured skeleton's centre lines.
    const bound = half[axis] + radius - 1e-5, delta = second[axis] - first[axis];
    if (Math.abs(delta) < 1e-10) {
      if (first[axis] <= -bound || first[axis] >= bound) return false;
      continue;
    }
    let lo = (-bound - first[axis]) / delta, hi = (bound - first[axis]) / delta;
    if (lo > hi) [lo, hi] = [hi, lo];
    enter = Math.max(enter, lo); leave = Math.min(leave, hi);
    if (enter >= leave) return false;
  }
  return leave > 0 && enter < 1;
}

function objectPoint(point, obstacle) {
  return qrotate(qconj(obstacle.quaternion), sub(point, obstacle.position))
    .map((value, axis) => value / obstacle.scale[axis]);
}

function hitPart(a, b, obstacle, part, radius) {
  const inverse = qconj(part.rotation);
  return segmentBox(qrotate(inverse, sub(objectPoint(a, obstacle), part.center)),
    qrotate(inverse, sub(objectPoint(b, obstacle), part.center)), part.size.map(v => v / 2),
    radius / Math.min(...obstacle.scale));
}

function measuredObstacles(sceneProps) {
  const obstacles = [];
  for (const [id, parts] of Object.entries(ACTIVITY_ROUTE_PARTS)) {
    const state = sceneProps?.[id];
    if (!state?.visible || ['left', 'right', 'both'].includes(state.attachment)) continue;
    const frame = state.worldTransform;
    if (!finite(frame?.position, 3) || !finite(frame?.quaternion, 4)
      || Math.abs(Math.hypot(...frame.quaternion) - 1) > .01)
      return { accepted: false, reason: 'activity_route_unmeasured_obstacle', obstacle: id };
    const scale = state.scale ?? [1, 1, 1];
    if (!finite(scale, 3) || scale.some(value => value <= 0))
      return { accepted: false, reason: 'activity_route_invalid_obstacle_scale', obstacle: id };
    obstacles.push({ id, parts, position: frame.position, quaternion: frame.quaternion, scale });
  }
  return { accepted: true, obstacles };
}

function measuredSegments(rig, pose, locals, fk) {
  solveFullBodyPose(rig, pose, locals, fk);
  const point = name => toWorld(pose.root, fk.get(name).position), segments = [];
  for (const side of ['L', 'R']) {
    const n = rig.legs[side].names;
    for (const [label, a, b, radius] of [['thigh', n.hip, n.knee, .06],
      ['shin', n.knee, n.ankle, .06], ['foot', n.ankle, n.toe, .035]]) {
      if (fk.has(a) && fk.has(b)) segments.push({ name: `${side}:${label}`, a: point(a), b: point(b), radius });
    }
  }
  segments.push({ name: 'torso', a: point(rig.support.root), b: point(rig.torso.upperChest.name), radius: .12 });
  segments.push({ name: 'neck-head', a: point(rig.torso.neck.name), b: point(rig.torso.head.name), radius: .1 });
  return segments;
}

/** Read-only validation of an already prepared isolated FullBodyController.
 * Call after its intended clip/context/entry bridge has been built, before
 * touching live state. Does not navigate, relocate props, retime or choose an
 * alternative action. The original source/entry trajectories are sampled at
 * 30 Hz, with swept joints between samples to avoid jumping through thin parts.
 * Seated contact and deliberate step-up exercises retain their dedicated gates.
 */
export function validateActivityRoute(probe) {
  const definition = probe.library[probe.activeId];
  if (!needsActivityRouteCheck(definition)) return { accepted: true, reason: 'route_not_required', samples: 0 };
  const measured = measuredObstacles(probe.sceneProps);
  if (!measured.accepted) return measured;
  if (!measured.obstacles.length) return { accepted: true, reason: 'no_scene_obstacle', samples: 0 };
  const duration = definition.duration;
  if (!Number.isFinite(duration) || duration <= 0) return { accepted: false, reason: 'activity_route_unbounded_source' };
  const locals = new Map(), fk = new Map(); let previous = null, samples = 0;
  const check = (pose, phase, seconds) => {
    const segments = measuredSegments(probe.rig, pose, locals, fk); samples++;
    for (const obstacle of measured.obstacles) for (const part of obstacle.parts) for (const segment of segments) {
      const prior = previous?.find(old => old.name === segment.name);
      const pairs = [[segment.a, segment.b], ...(prior ? [[prior.a, segment.a], [prior.b, segment.b]] : [])];
      if (pairs.some(([a, b]) => hitPart(a, b, obstacle, part, segment.radius)))
        return { accepted: false, reason: `activity_route_blocked_by_${obstacle.id}`, obstacle: obstacle.id,
          part: part.name, bodyPart: segment.name, phase, sourceTime: seconds, samples,
          root: copy(pose.root), segment: { a: segment.a, b: segment.b },
          evidence: 'actual PMX FK route and measured furniture transform; conservative solid-part bounds' };
    }
    previous = segments; return null;
  };
  if (probe.bridge) {
    const count = Math.max(1, Math.ceil(probe.bridge.duration * 30));
    for (let i = 0; i <= count; i++) {
      const elapsed = probe.bridge.duration * i / count;
      const failure = check(probe.bridgePose({ ...probe.bridge, elapsed }), 'entry', elapsed);
      if (failure) return failure;
    }
  }
  const start = Math.min(duration, probe.elapsed ?? 0), count = Math.max(1, Math.ceil((duration - start) * 30));
  for (let i = 0; i <= count; i++) {
    const seconds = start + (duration - start) * i / count;
    const failure = check(probe.sample(seconds), 'source', seconds);
    if (failure) return failure;
  }
  return { accepted: true, reason: 'measured_activity_route_clear', samples,
    sourceSeconds: duration, entrySeconds: probe.bridge?.duration ?? 0, obstacles: measured.obstacles.map(row => row.id) };
}
