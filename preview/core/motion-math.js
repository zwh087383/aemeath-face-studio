// Small allocation-light vector/quaternion helpers for the pure motion core.
// Vectors are [x, y, z]; quaternions are [x, y, z, w] (Three.js order).

export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
export const mix = (a, b, k) => a + (b - a) * k;
export const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const smoother = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
/** Exact exponential smoothing factor; independent of frame rate. */
export const follow = (dt, tau) => tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau);

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b, o = [0, 0, 0]) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; };
export const sub = (a, b, o = [0, 0, 0]) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; };
export const scale = (a, s, o = [0, 0, 0]) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; };
export const addScaled = (a, b, s, o = [0, 0, 0]) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; };
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b, o = [0, 0, 0]) => {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  o[0] = x; o[1] = y; o[2] = z; return o;
};
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a, o = [0, 0, 0]) => { const l = len(a) || 1; return scale(a, 1 / l, o); };
export const lerp3 = (a, b, k, o = [0, 0, 0]) => { o[0] = mix(a[0], b[0], k); o[1] = mix(a[1], b[1], k); o[2] = mix(a[2], b[2], k); return o; };
/** Component of a perpendicular to unit n, normalized; falls back to fallback. */
export const perpendicular = (a, n, fallback, o = [0, 0, 0]) => {
  addScaled(a, n, -dot(a, n), o);
  if (len(o) < 1e-6) return normalize(fallback, o);
  return normalize(o, o);
};

export const qid = () => [0, 0, 0, 1];
export const qcopy = (q, o = [0, 0, 0, 1]) => { o[0] = q[0]; o[1] = q[1]; o[2] = q[2]; o[3] = q[3]; return o; };
export const qaxis = (axis, angle, o = [0, 0, 0, 1]) => {
  const l = len(axis) || 1, s = Math.sin(angle / 2) / l;
  o[0] = axis[0] * s; o[1] = axis[1] * s; o[2] = axis[2] * s; o[3] = Math.cos(angle / 2); return o;
};
export const qmul = (a, b, o = [0, 0, 0, 1]) => {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = ax * bw + aw * bx + ay * bz - az * by;
  o[1] = ay * bw + aw * by + az * bx - ax * bz;
  o[2] = az * bw + aw * bz + ax * by - ay * bx;
  o[3] = aw * bw - ax * bx - ay * by - az * bz;
  return o;
};
export const qconj = (q, o = [0, 0, 0, 1]) => { o[0] = -q[0]; o[1] = -q[1]; o[2] = -q[2]; o[3] = q[3]; return o; };
export const qnormalize = (q, o = q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(l) || l < 1e-12) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; }
  o[0] = q[0] / l; o[1] = q[1] / l; o[2] = q[2] / l; o[3] = q[3] / l; return o;
};
export const qrotate = (q, v, o = [0, 0, 0]) => {
  const [x, y, z, w] = q, vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  o[0] = vx + w * tx + y * tz - z * ty;
  o[1] = vy + w * ty + z * tx - x * tz;
  o[2] = vz + w * tz + x * ty - y * tx;
  return o;
};
export const qfromUnit = (a, b, o = [0, 0, 0, 1]) => {
  let r = dot(a, b) + 1;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(a[0]) > Math.abs(a[2])) { o[0] = -a[1]; o[1] = a[0]; o[2] = 0; }
    else { o[0] = 0; o[1] = -a[2]; o[2] = a[1]; }
  } else {
    o[0] = a[1] * b[2] - a[2] * b[1]; o[1] = a[2] * b[0] - a[0] * b[2]; o[2] = a[0] * b[1] - a[1] * b[0];
  }
  o[3] = r;
  return qnormalize(o);
};
export const qslerp = (a, b, t, o = [0, 0, 0, 1]) => {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0 = 1 - t, k1 = t;
  if (c < .9995) {
    const s = Math.sqrt(1 - c * c), angle = Math.atan2(s, c);
    k0 = Math.sin((1 - t) * angle) / s; k1 = Math.sin(t * angle) / s;
  }
  o[0] = a[0] * k0 + bx * k1; o[1] = a[1] * k0 + by * k1; o[2] = a[2] * k0 + bz * k1; o[3] = a[3] * k0 + bw * k1;
  return qnormalize(o);
};
export const qangle = q => 2 * Math.acos(clamp(Math.abs(q[3]), 0, 1));
/** Twist of q around unit axis (swing-twist decomposition, q = swing * twist). */
export const qtwist = (q, axis, o = [0, 0, 0, 1]) => {
  const p = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  o[0] = axis[0] * p; o[1] = axis[1] * p; o[2] = axis[2] * p; o[3] = q[3];
  if (Math.hypot(o[0], o[1], o[2], o[3]) < 1e-9) return qid();
  return qnormalize(o);
};
/** Signed twist angle of q about the unit axis, in (-PI, PI]. */
export const qtwistAngle = (q, axis) => {
  const t = qtwist(q, axis);
  let angle = 2 * Math.atan2(t[0] * axis[0] + t[1] * axis[1] + t[2] * axis[2], t[3]);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
};
/** Limit the rotation angle of q, preserving its axis. */
export const qlimit = (q, maxAngle, o = q) => {
  const angle = qangle(q);
  if (angle <= maxAngle) return qcopy(q, o);
  const s = q[3] < 0 ? -1 : 1, axis = [q[0] * s, q[1] * s, q[2] * s];
  return qaxis(axis, maxAngle, o);
};
/** Rotation taking orthonormal frame (d0, n0) to (d1, n1). */
export const qfromFrames = (d0, n0, d1, n1, o = [0, 0, 0, 1]) => {
  const b0 = cross(d0, n0), b1 = cross(d1, n1);
  // R = B1 * B0^T, where B = [d n b] columns.
  const m = (r, c) => d1[r] * d0[c] + n1[r] * n0[c] + b1[r] * b0[c];
  const m00 = m(0, 0), m01 = m(0, 1), m02 = m(0, 2), m10 = m(1, 0), m11 = m(1, 1), m12 = m(1, 2), m20 = m(2, 0), m21 = m(2, 1), m22 = m(2, 2);
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = .5 / Math.sqrt(trace + 1);
    o[3] = .25 / s; o[0] = (m21 - m12) * s; o[1] = (m02 - m20) * s; o[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    o[3] = (m21 - m12) / s; o[0] = .25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = .25 * s; o[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = .25 * s;
  }
  return qnormalize(o);
};
/** Small-angle body rotation: yaw about +Y, pitch about +X, roll about +Z (applied roll, pitch, yaw). */
export const qeuler = (pitch, yaw, roll, o = [0, 0, 0, 1]) => {
  const p = qaxis([1, 0, 0], pitch), y = qaxis([0, 1, 0], yaw), r = qaxis([0, 0, 1], roll);
  return qmul(qmul(y, p, o), r, o);
};

/** Deterministic PRNG (mulberry32) and string hash for bounded, reproducible variation. */
export const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const prng = seed => () => {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Centripetal-free uniform Catmull-Rom through keyed numbers, clamped at the ends.
 * Repeated equal keys create intentional holds; intermediate keys keep velocity. */
export const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return .5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
