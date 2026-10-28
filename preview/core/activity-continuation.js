import { clamp, smoother, qslerp } from './motion-math.js';
import { heldPropSides } from './activity-continuity.js';

const copy = value => structuredClone(value);
export const ACTIVITY_MICRO_SETS = Object.freeze(['gaze_shift', 'finger_release']);

/** These windows have no acquisition, release, page turn or laptop lid event.
 * A duration request owns only this middle. Entry and exit retain source speed. */
export function createActivityContinuation(definition, { targetDuration, hold = false, microSet = [] } = {}) {
  const requested = targetDuration !== undefined || hold || microSet.length > 0;
  if (!requested) return null;
  const window = definition?.continuation;
  if (!window || !(window.start >= 0 && window.end > window.start + 2 * window.blend && window.end < definition.duration)) {
    throw new RangeError('Activity has no verified continuation window');
  }
  if (targetDuration !== undefined && (!Number.isFinite(targetDuration) || targetDuration < definition.duration)) {
    throw new RangeError('Activity duration cannot shorten its source entry or exit');
  }
  if (!Array.isArray(microSet) || microSet.some(id => !ACTIVITY_MICRO_SETS.includes(id))) throw new RangeError('Unknown activity micro set');
  return { ...copy(window), sourceDuration: definition.duration,
    duration: hold ? Infinity : targetDuration ?? definition.duration, hold: !!hold,
    requestedDuration: targetDuration ?? null, microSet: [...new Set(microSet)] };
}

// Blend continuous geometry including explicit contact frames, not just wrists:
// contact solving otherwise replaces the blended wrist with an unblended target.
function blendValue(a, b, k, key = '') {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 4 && /quaternion|rotation/i.test(key)) return qslerp(a, b, k);
    return b.map((v, i) => blendValue(a[i], v, k, key));
  }
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * k;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map(name => [name, blendValue(a[name], b[name], k, name)]));
  }
  return copy(k < 1 ? a === undefined ? b : a : b === undefined ? a : b);
}

function repeatedMiddle(plan, time, sample) {
  const { start, end, blend } = plan, firstSeam = end - blend;
  if (time <= firstSeam) return sample(time);
  const period = end - start - blend;
  const phase = (time - firstSeam) % period;
  if (phase < blend) return blendValue(sample(end - blend + phase), sample(start + phase), smoother(phase / blend));
  return sample(start + phase);
}

function applyMicro(pose, plan, time, envelope, inheritedOccupiedHands) {
  const applied = [], suppressed = [];
  if (!(envelope > 0)) return { applied, suppressed };
  if (plan.microSet.includes('gaze_shift')) {
    pose.body ??= {};
    // Only a bounded local eye motion: no new semantic reaction or head turn.
    pose.body.gazeYaw = (pose.body.gazeYaw ?? 0) + .028 * Math.sin((time - plan.start) * .71) * envelope;
    applied.push('gaze_shift');
  }
  if (plan.microSet.includes('finger_release')) {
    const occupied = new Set([...inheritedOccupiedHands, ...Object.values(pose.props ?? {}).flatMap(heldPropSides)]);
    for (const contact of Object.values(pose.propContactPlans ?? {})) for (const side of contact.hands ?? []) occupied.add(side);
    let changed = false;
    for (const side of ['L', 'R']) {
      if (occupied.has(side) || !pose.hands?.[side]) { suppressed.push(`finger_release:${side}:contact`); continue; }
      const pulse = .5 - .5 * Math.cos((time - plan.start) * 1.1);
      pose.hands[side].curl = Math.max(-.1, (pose.hands[side].curl ?? .15) - .055 * pulse * envelope);
      changed = true;
    }
    if (changed) applied.push('finger_release');
  }
  return { applied, suppressed };
}

export function sampleActivityContinuation(plan, time, sample, { occupiedHands = [] } = {}) {
  if (!plan) return copy(sample(time));
  const t = Math.max(0, Math.min(plan.duration, time));
  const extension = plan.duration - plan.sourceDuration;
  let pose, stage = 'entry', sourceTime = t;
  const tailStart = plan.duration - (plan.sourceDuration - plan.end);
  if (!(extension > 1e-9)) pose = copy(sample(t));
  else if (t >= tailStart - 1e-10) {
    sourceTime = Math.abs(t - plan.duration) < 1e-10 ? plan.sourceDuration
      : Math.abs(t - tailStart) < 1e-10 ? plan.end : plan.end + (t - tailStart);
    pose = copy(sample(sourceTime)); stage = 'exit';
  } else {
    pose = repeatedMiddle(plan, t, sample);
    if (t > plan.end - plan.blend) { stage = 'middle'; sourceTime = null; }
    // Meet the original exit with the original velocity at an arbitrary target
    // time, instead of rounding a user's duration to complete cycle counts.
    if (Number.isFinite(tailStart) && t > tailStart - plan.blend) {
      const u = (t - (tailStart - plan.blend)) / plan.blend;
      pose = blendValue(pose, sample(plan.end - plan.blend + u * plan.blend), smoother(u));
      stage = 'middle-exit-blend';
    }
  }
  const envelope = smoother((t - plan.start) / plan.blend)
    * (Number.isFinite(tailStart) ? 1 - smoother((t - (tailStart - plan.blend)) / plan.blend) : 1);
  const micro = applyMicro(pose, plan, t, envelope, occupiedHands);
  pose.time = t; pose.duration = Number.isFinite(plan.duration) ? plan.duration : null;
  pose.done = pose.terminal = Number.isFinite(plan.duration) && t >= plan.duration;
  pose.continuation = { stage, sourceTime, holding: plan.hold, micro };
  return pose;
}

/** Release is explicit; a silent interval never resumes or closes a task. */
export function releaseActivityContinuation(plan, elapsed) {
  if (!plan || plan.released || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= plan.duration) return false;
  const previousDuration = plan.duration;
  plan.hold = false;
  plan.released = true;
  // Reserve a full C1 seam and the original exit even if released mid-cycle.
  // Finite requested work is just as interruptible by an explicit finish as an
  // indefinite hold. Never extend a finite task already entering its own exit.
  plan.duration = Math.min(previousDuration, Math.max(plan.sourceDuration, elapsed + plan.blend + plan.sourceDuration - plan.end));
  return true;
}
