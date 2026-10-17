// Boundary-only motion handoff. Coordinates and quaternion conventions match the
// caller; this is a finite-duration inertial offset, not a whole-track filter.
import { clamp, cross, qconj, qmul, qnormalize } from './motion-math.js';

/** Rotation vector in the quaternion's parent frame; shortest signed arc. */
export function rotationVector(q) {
  const sign = q[3] < 0 ? -1 : 1, n = Math.hypot(q[0], q[1], q[2]);
  if (n < 1e-10) return [q[0] * 2 * sign, q[1] * 2 * sign, q[2] * 2 * sign];
  const gain = 2 * Math.atan2(n, Math.abs(q[3])) * sign / n;
  return [q[0] * gain, q[1] * gain, q[2] * gain];
}

export function rotationFromVector(v) {
  const angle = Math.hypot(...v), gain = angle < 1e-10 ? .5 : Math.sin(angle / 2) / angle;
  return qnormalize([v[0] * gain, v[1] * gain, v[2] * gain, Math.cos(angle / 2)]);
}

/** Spatial angular velocity, radians / second, in the parent coordinate frame. */
export function angularVelocity(previous, current, dt) {
  return dt > 1e-6 ? rotationVector(qmul(current, qconj(previous))).map(x => x / dt) : [0, 0, 0];
}

/** Inverse SO(3) left Jacobian: turn parent-frame angular velocity into the
 * derivative of a rotation vector, rather than treating Euler/log rates as omega. */
export function rotationVectorVelocity(vector, omega) {
  const angle = Math.hypot(...vector), first = cross(vector, omega), second = cross(vector, first);
  const coefficient = angle < 1e-4 ? 1 / 12 + angle * angle / 720
    : (1 - .5 * angle / Math.tan(.5 * angle)) / (angle * angle);
  return omega.map((value, i) => value - .5 * first[i] + coefficient * second[i]);
}

/** Quintic offset: initial value/velocity, zero initial acceleration, and zero
 * value/velocity/acceleration at the end. Never samples a future audio frame. */
export function inertialOffset(value, velocity, elapsed, duration) {
  const T = Math.max(.08, duration), t = clamp(elapsed / T), v = velocity * T;
  const a = -10 * value - 6 * v, b = 15 * value + 8 * v, c = -6 * value - 3 * v;
  return { value: value + v * t + a * t ** 3 + b * t ** 4 + c * t ** 5,
    velocity: (v + 3 * a * t ** 2 + 4 * b * t ** 3 + 5 * c * t ** 4) / T };
}

export function continueScalar(start, velocity, target, elapsed, duration) {
  const offset = inertialOffset(start - target, velocity, elapsed, duration);
  return { value: target + offset.value, velocity: offset.velocity };
}
