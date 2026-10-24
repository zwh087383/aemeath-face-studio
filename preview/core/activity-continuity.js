// Activity transitions operate in the same explicit coordinate frames as the
// sampled body. These functions do not run clocks or own animation callbacks.
// Positions use PMX model units; scalar rotations use radians; velocities are
// measured per second from the two actual displayed samples, never assumed 0.
const copy = value => structuredClone(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const angleDifference = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function quinticBoundary(a, b, velocityA = 0, velocityB = 0, elapsed = 0, duration = 1) {
  const u = Math.max(0, Math.min(1, elapsed / Math.max(1e-9, duration)));
  const u2 = u * u, u3 = u2 * u, u4 = u3 * u, u5 = u4 * u;
  return a * (1 - 10 * u3 + 15 * u4 - 6 * u5) + b * (10 * u3 - 15 * u4 + 6 * u5)
    + velocityA * duration * (u - 6 * u3 + 8 * u4 - 3 * u5)
    + velocityB * duration * (-4 * u3 + 7 * u4 - 3 * u5);
}

function mapNumbers(a, b, callback, path = '') {
  if (Array.isArray(a) || Array.isArray(b)) {
    const size = Math.max(a?.length ?? 0, b?.length ?? 0);
    return Array.from({ length: size }, (_, i) => mapNumbers(a?.[i], b?.[i], callback, `${path}.${i}`));
  }
  if (isNumber(a) || isNumber(b)) return callback(isNumber(a) ? a : 0, isNumber(b) ? b : 0, path);
  if (a && typeof a === 'object' || b && typeof b === 'object') {
    return Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
      .map(key => [key, mapNumbers(a?.[key], b?.[key], callback, `${path}.${key}`)]));
  }
  return b === undefined ? a : b;
}

const channels = pose => ({ root: pose?.root ?? {}, pelvis: pose?.pelvis ?? {}, body: pose?.body ?? {}, hands: pose?.hands ?? {} });
const readPath = (value, path) => path.split('.').filter(Boolean).reduce((node, key) => node?.[key], value);

export function measurePoseVelocity(previous, current, dt) {
  if (!previous || !(dt > 1e-8)) return mapNumbers(channels(current), channels(current), () => 0);
  return mapNumbers(channels(previous), channels(current), (a, b, path) =>
    (path === '.root.yaw' ? angleDifference(a, b) : b - a) / dt);
}

export function blendTrajectoryChannels(from, target, velocityFrom, velocityTarget, elapsed, duration) {
  return mapNumbers(channels(from), channels(target), (a, b, path) => {
    if (path === '.root.yaw') b = a + angleDifference(a, b);
    return quinticBoundary(a, b, readPath(velocityFrom, path) ?? 0, readPath(velocityTarget, path) ?? 0, elapsed, duration);
  });
}

export function velocityMagnitude(value) {
  if (isNumber(value)) return Math.abs(value);
  if (Array.isArray(value)) return Math.hypot(...value.map(velocityMagnitude));
  if (value && typeof value === 'object') return Math.max(0, ...Object.values(value).map(velocityMagnitude));
  return 0;
}

export const heldPropSides = state => {
  if (!state || typeof state !== 'object' || state.visible === false) return [];
  return state.attachment === 'both' ? ['L', 'R'] : state.attachment === 'left' ? ['L'] : state.attachment === 'right' ? ['R'] : [];
};

export function activityPropNeed(definition) {
  const id = definition?.propId ?? (definition?.reading ? 'book' : definition?.kind === 'drink' ? 'mug'
    : definition?.kind === 'write' ? 'pencil' : definition?.kind === 'carry' ? 'box' : null);
  return id ? { id, sides: ['book', 'box'].includes(id) ? ['L', 'R'] : ['R'] } : null;
}

export function propAdmissionConflict(definition, props = {}) {
  const freeHands = definition?.freeHands === true ? ['L', 'R'] : Array.isArray(definition?.freeHands) ? definition.freeHands : [];
  for (const [id, state] of Object.entries(props)) if (heldPropSides(state).some(side => freeHands.includes(side))) {
    return { reason: 'free-hands-required', heldProp: id, freeHands: [...freeHands] };
  }
  const need = activityPropNeed(definition);
  if (!need) return null;
  for (const [id, state] of Object.entries(props)) if (id !== need.id && heldPropSides(state).some(side => need.sides.includes(side))) {
    return { reason: 'hands-occupied', requestedProp: need.id, heldProp: id };
  }
  return null;
}

/** Omission is not a release instruction. If the next activity has no ownership
 * of an already held object, retain that grip while its unoccupied body parts
 * continue the requested activity. Scene-owned furniture is left to the scene's
 * world transform and is not re-emitted under a newer moving anchor. */
export function inheritHeldProps(sample, previous, { releaseReceipts = {} } = {}) {
  const result = sample;
  result.props ??= {};
  result.hands ??= {};
  for (const [id, state] of Object.entries(previous?.props ?? {})) {
    const sides = heldPropSides(state);
    if (!sides.length) continue;
    if (Object.hasOwn(result.props, id)) {
      if (!heldPropSides(result.props[id]).length && !(releaseReceipts[id]?.released && releaseReceipts[id].operation === 'place')) {
        result.props[id] = copy(state);
        for (const side of sides) if (previous.hands?.[side]) result.hands[side] = copy(previous.hands[side]);
        if (previous.propContactPlans?.[id]) { result.propContactPlans ??= {}; result.propContactPlans[id] = copy(previous.propContactPlans[id]); }
        result.propOwnershipConflicts ??= []; result.propOwnershipConflicts.push({ id, reason: 'held-prop-release-requires-receipt' });
      }
      // A carry activity may specify the same held object again without owning
      // a new grip trajectory. Preserve its verified rigid contact plan rather
      // than falling back to approximate independent wrist positions.
      if (heldPropSides(result.props[id]).length && !result.propContactPlans?.[id] && previous.propContactPlans?.[id]) {
        result.props[id] = { ...copy(state), ...result.props[id] };
        result.propContactPlans ??= {}; result.propContactPlans[id] = copy(previous.propContactPlans[id]);
      }
      continue;
    }
    result.props[id] = copy(state);
    for (const side of sides) if (previous.hands?.[side]) result.hands[side] = copy(previous.hands[side]);
    if (previous.propContactPlans?.[id]) {
      result.propContactPlans ??= {};
      result.propContactPlans[id] = copy(previous.propContactPlans[id]);
    }
  }
  return result;
}
