import {
  add, clamp, cross, hash, mix, normalize, perpendicular, prng, qconj, qeuler, qfromFrames, qmul, qnormalize, qrotate,
  qslerp, smoother, sub,
} from './motion-math.js';
import { buildRig, forearmFrame, forwardKinematics, handRelative, solveArm, solveSupport, wristFromPalm } from './motion-skeleton.js';
import { AEMEATH_MOTION_BINDING, GESTURES, MOTION_DEFAULTS, OVERLAP, POSTURES } from './motion-profile.js';

// Flat arm parameter layout (model space, already mirrored per side).
const ARM = 17, HAND = 0, POLE = 3, PALM = 6, POINT = 9, SHRUG = 12, PROTRACT = 13, CURL = 14, THUMB = 15, SPREAD = 16;
const GROUP_INDEX = {
  position: [0, 1, 2, 3, 4, 5], orientation: [6, 7, 8, 9, 10, 11], shoulder: [12, 13], fingers: [14, 15, 16],
};
const GROUPS = Object.keys(GROUP_INDEX);
const BODY = ['lean', 'twist', 'side', 'headPitch', 'headYaw', 'headRoll', 'neckForward', 'gazePitch',
  'gazeYaw', 'pelvisPitch', 'pelvisRoll', 'hipShift'];
const SIDES = ['L', 'R'];
const AUTO_POSTURE = { idle: 'relaxed', playing: 'speaking', cancelled: 'listening', ended: 'listening' };
const SETTLE_TO_RELAXED = 8;

/** Positions stay in the model frame; palm/point are stored in the pose's own forearm
 * frame (handRelative). Additive offsets are rotated through a reference pose's forearm. */
function compileArm(rig, side, spec, additive, reference) {
  const sign = rig.sides[side].sign, out = new Float64Array(ARM);
  const m = (v, fallback) => v ? [sign * v[0], v[1], v[2]] : fallback;
  if (additive) {
    const inverse = qconj(forearmFrame(rig, side, { ...reference, hand: m(reference.hand), pole: m(reference.pole) }));
    out.set(m(spec.hand, [0, 0, 0]), HAND); out.set(m(spec.pole, [0, 0, 0]), POLE);
    out.set(qrotate(inverse, m(spec.palm, [0, 0, 0])), PALM); out.set(qrotate(inverse, m(spec.point, [0, 0, 0])), POINT);
  } else {
    const palm = m(spec.palm), point = m(spec.point), pole = m(spec.pole);
    let hand = m(spec.hand);
    if (spec.anchor === 'palm') hand = wristFromPalm(rig, side, hand, point, palm);
    const local = handRelative(rig, side, { hand, pole, palm, point, shrug: spec.shrug ?? 0, protract: spec.protract ?? 0 });
    out.set(hand, HAND); out.set(pole, POLE); out.set(local.palm, PALM); out.set(local.point, POINT);
  }
  out[SHRUG] = spec.shrug ?? 0; out[PROTRACT] = spec.protract ?? 0;
  out[CURL] = spec.curl ?? 0; out[THUMB] = spec.thumb ?? 0; out[SPREAD] = spec.spread ?? 0;
  return out;
}
const compileBody = spec => Float64Array.from(BODY, key => spec?.[key] ?? 0);

// Hand orientation is stored as (palm, point) vectors for authoring and additive
// offsets, but blended as one rotation: mixing the vectors separately lets them
// collapse onto each other between distant frames (palm-up shrug -> relaxed).
const REF_POINT = [0, 0, 1], REF_PALM = [0, 1, 0];
const scratch = { d: [0, 0, 0], n: [0, 0, 0], v: [0, 0, 0], qa: [0, 0, 0, 1], qb: [0, 0, 0, 1], q: [0, 0, 0, 1] };
function handQuat(a, o) {
  // Palm is primary, as in solveArm, so an unblended pose solves exactly as authored.
  const n = normalize([a[PALM], a[PALM + 1], a[PALM + 2]], scratch.n);
  const d = perpendicular([a[POINT], a[POINT + 1], a[POINT + 2]], n, cross(n, [1, 0, 0], scratch.v), scratch.d);
  return qfromFrames(REF_POINT, REF_PALM, d, n, o);
}
function mixHand(a, b, k) {
  if (!(k > 0)) return;
  if (k >= 1) { for (let i = PALM; i < POINT + 3; i++) a[i] = b[i]; return; }
  const q = qslerp(handQuat(a, scratch.qa), handQuat(b, scratch.qb), clamp(k), scratch.q);
  const d = qrotate(q, REF_POINT, scratch.d), n = qrotate(q, REF_PALM, scratch.n);
  a[POINT] = d[0]; a[POINT + 1] = d[1]; a[POINT + 2] = d[2];
  a[PALM] = n[0]; a[PALM + 1] = n[1]; a[PALM + 2] = n[2];
}

/** Monotone (Fritsch-Butland) cubic Hermite track: no overshoot, velocity carried
 * through interior keys, zero velocity only at ends, reversals and `stop` keys. */
function compileTrack(keys, compile) {
  const times = keys.map(k => k[0]), values = keys.map(k => compile(k[1])), stops = keys.map(k => k[2] === 'stop');
  const size = values[0].length, tangents = values.map(() => new Float64Array(size));
  for (let k = 1; k < keys.length - 1; k++) {
    if (stops[k]) continue;
    const h0 = times[k] - times[k - 1], h1 = times[k + 1] - times[k];
    for (let c = 0; c < size; c++) {
      const d0 = (values[k][c] - values[k - 1][c]) / h0, d1 = (values[k + 1][c] - values[k][c]) / h1;
      if (d0 * d1 <= 0) continue;
      const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
      tangents[k][c] = (w1 + w2) / (w1 / d0 + w2 / d1);
    }
  }
  return { times, values, tangents, size };
}
function sampleTrack(track, t, out) {
  const { times, values, tangents, size } = track, n = times.length;
  if (n === 1 || t <= times[0]) { out.set(values[0]); return out; }
  if (t >= times[n - 1]) { out.set(values[n - 1]); return out; }
  let i = 0; while (t > times[i + 1]) i++;
  const h = times[i + 1] - times[i], s = (t - times[i]) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const a = values[i], b = values[i + 1], ma = tangents[i], mb = tangents[i + 1];
  for (let c = 0; c < size; c++) out[c] = h00 * a[c] + h10 * h * ma[c] + h01 * b[c] + h11 * h * mb[c];
  return out;
}

function compileProfile(rig) {
  const postures = {};
  for (const [id, p] of Object.entries(POSTURES)) {
    postures[id] = { L: compileArm(rig, 'L', p.L, false), R: compileArm(rig, 'R', p.R, false), body: compileBody(p.body) };
  }
  const gestures = {};
  for (const [id, g] of Object.entries(GESTURES)) {
    const tracks = {};
    for (const [track, keys] of Object.entries(g.keys)) {
      tracks[track] = track === 'body'
        ? compileTrack(keys, compileBody)
        // Additive beats sit on the speaking posture; their offsets use its forearm frame.
        : compileTrack(keys, spec => compileArm(rig, track, spec, !!g.additive, POSTURES.speaking[track]));
    }
    const prepareEnd = g.phases.prepare[1], sample = new Float64Array(ARM);
    // Where each hand must be when the stroke begins; the prepare phase is stretched
    // when a hand starts farther away (see stretchFor).
    const recoverStart = g.phases.recover[0];
    const handAt = age => SIDES.filter(side => tracks[side] && !g.additive)
      .map(side => [side, Array.from(sampleTrack(tracks[side], age, sample).subarray(HAND, HAND + 3))]);
    // Where each hand must be when the stroke begins and when recovery begins; those
    // phases are stretched when the hand has farther to travel (see travelStretch).
    const reach = Object.fromEntries(handAt(prepareEnd)), release = Object.fromEntries(handAt(recoverStart));
    gestures[id] = { ...g, id, compiled: tracks, prepareEnd, recoverStart, reach, release };
    gestures[id].speakingStretch = travelStretch(reach, side => postures.speaking[side], prepareEnd);
  }
  return { postures, gestures };
}

/** Phase time stretch so the wrists average at most MOTION_DEFAULTS.travelSpeed
 * between `points` and the hands given by handOf over a phase of `seconds`. */
function travelStretch(points, handOf, seconds) {
  return clamp(handDistance(points, handOf) / (seconds * MOTION_DEFAULTS.travelSpeed), 1, MOTION_DEFAULTS.maxStretch);
}
function handDistance(points, handOf) {
  let dist = 0;
  for (const [side, p] of Object.entries(points)) {
    const h = handOf(side);
    dist = Math.max(dist, Math.hypot(p[0] - h[HAND], p[1] - h[HAND + 1], p[2] - h[HAND + 2]));
  }
  return dist;
}
/** Authored gesture age from its raw clock age, undoing the prepare/recover stretches. */
function warp(def, raw, g) {
  const f1 = g.stretch ?? 1, f2 = g.recoverStretch ?? 1, P = def.prepareEnd, R = def.recoverStart;
  if (raw < P * f1) return raw / f1;
  const mid = raw - P * (f1 - 1);
  return mid < R ? mid : R + (mid - R) / f2;
}
const prepareExtra = (def, stretch) => def.prepareEnd * (stretch - 1);
const REMOVE_AFTER = Math.max(...Object.values(OVERLAP.enter)) + .02;

/** Critically damped spring, exact for a constant target over the step. */
function spring(state, target, omega, dt) {
  const x0 = state.x - target, tmp = (state.v + omega * x0) * dt, e = Math.exp(-omega * dt);
  state.x = target + (x0 + tmp) * e;
  state.v = (state.v - omega * tmp) * e;
  return state.x;
}

const envelope = (g, age) => {
  if (age <= 0 || age >= g.duration) return 0;
  if (age < g.prepareEnd) return smoother(age / g.prepareEnd);
  if (age < g.recoverStart) return 1;
  return 1 - smoother((age - g.recoverStart) / (g.duration - g.recoverStart));
};
const phaseOf = (g, age) => {
  for (const name of ['prepare', 'stroke', 'hold', 'recover']) if (age < g.phases[name][1]) return name;
  return 'done';
};

/** Pure body-motion controller. Times in seconds supplied by the caller.
 * Audio-scoped gestures follow the playback clock (frozen while paused); retraction
 * after interruption, seek or replacement always runs on the local wall clock.
 * update() returns a reusable Map of local bone quaternions for the rig adapter.
 */
export class MotionController {
  constructor({ skeleton, binding = AEMEATH_MOTION_BINDING, seed = 20261014 } = {}) {
    if (!skeleton) throw new Error('MotionController requires a bind-pose skeleton');
    this.rig = buildRig(skeleton, binding);
    this.profile = compileProfile(this.rig);
    this.locals = new Map();
    this.locals.translations = new Map();
    this.fk = new Map();
    this.diag = { L: {}, R: {} };
    this.options = { intensity: 1, speed: 1, natural: true };
    this.mode = 'auto';
    this.epoch = 0; this.active = false; this.status = 'idle'; this.time = 0; this.now = 0;
    this.statusSince = 0;
    this.pending = []; this.gestures = []; this.seen = new Set(); this.lastStart = new Map();
    this.rejected = 0; this.beats = 0; this.quiet = 0; this.lastBeat = -100; this.rebase = false;
    this.random = prng(seed >>> 0);
    this.phase = { breath: 0, period: MOTION_DEFAULTS.breathPeriod };
    this.micro = Array.from({ length: 6 }, () => this.random() * Math.PI * 2);
    const zero = () => ({ x: 0, v: 0 });
    this.springs = { gazeYaw: zero(), gazePitch: zero(), headPitch: zero(), headYaw: zero(), headRoll: zero(),
      neckPitch: zero(), neckYaw: zero(), neckRoll: zero(), chestYaw: zero(),
      lean: zero(), twist: zero(), side: zero(), pelvisPitch: zero(), pelvisRoll: zero(), hipShift: zero() };
    const relaxed = this.profile.postures.relaxed;
    this.posture = { target: 'relaxed', start: -100, from: this.copyPosture(relaxed), current: this.copyPosture(relaxed) };
    this.work = { arm: { L: Float64Array.from(relaxed.L), R: Float64Array.from(relaxed.R) }, body: new Float64Array(BODY.length),
      sample: new Float64Array(ARM), bodySample: new Float64Array(BODY.length) };
    this.head = { pitch: 0, yaw: 0, roll: 0, eyesYaw: 0, eyesPitch: 0 };
    this.lastInput = { face: { pitch: 0, yaw: 0, roll: 0 }, actions: [] };
  }

  copyPosture(p) { return { L: Float64Array.from(p.L), R: Float64Array.from(p.R), body: Float64Array.from(p.body) }; }

  setOptions({ intensity, speed, natural } = {}) {
    if (intensity !== undefined && Number.isFinite(intensity)) this.options.intensity = clamp(intensity, .2, 1);
    if (speed !== undefined && Number.isFinite(speed)) this.options.speed = clamp(speed, .6, 1.4);
    if (natural !== undefined) this.options.natural = !!natural;
  }

  /** Diagnostic freeze of one gesture at a fixed age (key-pose inspection); null clears. */
  inspect(gesture, age = 0) {
    if (gesture === null) { this.inspection = null; return true; }
    if (!Object.hasOwn(GESTURES, gesture) || !Number.isFinite(age)) return false;
    this.inspection = { id: `inspect-${gesture}`, gesture, def: this.profile.gestures[gesture], fixedAge: age, at: 0, rate: 1,
      clock: 'wall', strength: 1, jitter: [0, 0, 0], recovering: false, live: null, frozen: null };
    return true;
  }

  /** 'auto' follows playback state; otherwise a fixed posture id. */
  setPosture(id, now = this.now) {
    if (id === 'auto') { this.mode = 'auto'; this.applyAutoPosture(now); return true; }
    if (!Object.hasOwn(POSTURES, id)) return false;
    this.mode = id;
    this.transitionTo(id, now);
    return true;
  }

  transitionTo(id, now) {
    if (this.posture.target === id) return;
    const p = this.posture;
    p.from = this.copyPosture(p.current);
    p.target = id; p.start = now;
  }

  applyAutoPosture(now) {
    if (this.mode !== 'auto') return;
    let id = AUTO_POSTURE[this.status] ?? this.posture.target;
    if (this.status === 'paused') id = this.posture.target;
    if ((this.status === 'cancelled' || this.status === 'ended') && now - this.statusSince > SETTLE_TO_RELAXED) id = 'relaxed';
    this.transitionTo(id, now);
  }

  begin(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) return false;
    // A new playback instance invalidates every older audio-scoped gesture.
    this.retractWhere(g => g.clock === 'audio', this.now);
    this.pending = this.pending.filter(c => c.clock !== 'audio');
    this.epoch = epoch; this.active = true; this.time = 0; this.rebase = false;
    this.setStatus('playing');
    return true;
  }

  playback(epoch, status, time) {
    if (!this.active || epoch !== this.epoch || !['playing', 'paused', 'ended'].includes(status) || !Number.isFinite(time)) return false;
    if (status !== this.status) this.setStatus(status);
    this.time = Math.max(0, time);
    if (status === 'ended') {
      this.active = false;
      this.pending = this.pending.filter(c => c.clock !== 'audio');
      // Gestures already under way finish naturally on the local clock.
      this.rebase = true;
    }
    return true;
  }

  setStatus(status) { this.status = status; this.statusSince = this.now; }

  /** Final interruption: drop this epoch's future cues, retract from the current pose. */
  cancel(epoch, now = this.now) {
    if (!this.active || epoch !== this.epoch) return false;
    this.active = false;
    this.pending = this.pending.filter(c => c.clock !== 'audio');
    this.setStatus('cancelled');
    this.statusSince = now;
    // Switch posture first so retraction is timed against where the hands now return to.
    this.applyAutoPosture(now);
    this.retractWhere(() => true, now);
    return true;
  }

  /** Retract every active gesture (manual stop), keeping playback state. */
  retract(now = this.now) { this.pending = this.pending.filter(c => c.clock !== 'wall'); return this.retractWhere(() => true, now); }

  retractWhere(predicate, now) {
    let count = 0;
    for (const g of this.gestures) {
      if (g.recovering || !predicate(g)) continue;
      this.freeze(g, now, this.retractTime(g));
      count++;
    }
    return count;
  }

  /** Interrupt retraction time: the gesture's recover time, longer (up to maxStretch)
   * when the hand is far from the posture it returns to. */
  retractTime(g) {
    const D = MOTION_DEFAULTS, base = g.def.recover / this.options.speed, live = g.live;
    if (!live || g.def.additive) return base;
    const target = this.profile.postures[this.posture.target];
    let dist = 0;
    for (const side of SIDES) {
      const v = live.values[side], w = live.weights[side];
      if (v) dist = Math.max(dist, w.position * Math.hypot(v[0] - target[side][0], v[1] - target[side][1], v[2] - target[side][2]));
    }
    return Math.min(base * D.maxStretch, Math.max(base, dist / (D.retractSpeed * this.options.speed)));
  }

  freeze(g, now, duration) {
    // Capture the gesture's live contribution so retraction starts from the exact current pose.
    g.recovering = true; g.recoverStart = now; g.recoverDuration = Math.max(.18, duration);
    g.frozen = g.live; g.live = null;
  }

  enqueue(cue) {
    const reject = () => { this.rejected++; return false; };
    if (!cue || typeof cue.id !== 'string' || !cue.id || cue.id.length > 128 || this.pending.length >= 64) return reject();
    if (cue.clock !== undefined && !['wall', 'audio'].includes(cue.clock)) return reject();
    const audio = cue.clock !== 'wall';
    if (audio && (!this.active || cue.epoch !== this.epoch)) return reject();
    if (cue.kind === 'posture') {
      if (!Object.hasOwn(POSTURES, cue.posture) || !Number.isFinite(cue.at) || cue.at < 0) return reject();
      if (this.seen.has(cue.id)) return reject();
      this.remember(cue.id);
      this.pending.push({ ...cue, clock: audio ? 'audio' : 'wall' });
      return true;
    }
    if (cue.kind !== 'gesture' || typeof cue.gesture !== 'string' || !Object.hasOwn(GESTURES, cue.gesture)) return reject();
    if (cue.strength !== undefined && !Number.isFinite(cue.strength)) return reject();
    const def = this.profile.gestures[cue.gesture];
    const rate = this.options.speed;
    let at = cue.at;
    if (cue.apexAt !== undefined) {
      if (!Number.isFinite(cue.apexAt) || cue.apexAt < 0) return reject();
      // Speech gestures normally start from the speaking posture; include its prepare stretch.
      at = Math.max(0, cue.apexAt - (def.apex + prepareExtra(def, def.speakingStretch)) / rate);
    }
    if (!Number.isFinite(at) || at < 0) return reject();
    const clock = audio ? this.time : this.now;
    if (this.seen.has(cue.id) || at > clock + 60 || at + def.duration / rate <= clock) return reject();
    // Never replay a gesture that arrives after its start window (late-start rule).
    if (clock - at > Math.min(MOTION_DEFAULTS.lateTolerance, def.prepareEnd * .5 / rate)) return reject();
    this.remember(cue.id);
    this.pending.push({ id: cue.id, kind: 'gesture', gesture: cue.gesture, epoch: this.epoch, clock: audio ? 'audio' : 'wall',
      at, rate, strength: clamp(cue.strength ?? 1) });
    return true;
  }

  remember(id) { this.seen.add(id); if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value); }

  /** Manual trigger: audio-scoped while a sentence plays (pause freezes it), else wall clock. */
  trigger(gesture, id, now = this.now) {
    if (!Object.hasOwn(GESTURES, gesture) || GESTURES[gesture].internal || !Number.isFinite(now)) return false;
    const def = this.profile.gestures[gesture];
    if (now - (this.lastStart.get(gesture) ?? -100) < def.cooldown) { this.rejected++; return false; }
    if (this.gestures.some(g => g.gesture === gesture && !g.recovering)) { this.rejected++; return false; }
    // A queued cue of the same gesture blocks only if it is about to start anyway.
    if (this.pending.some(c => c.gesture === gesture && c.at - this.clockOf(c) < def.cooldown)) { this.rejected++; return false; }
    const audio = this.active;
    return this.enqueue({ id, kind: 'gesture', gesture, epoch: this.epoch, clock: audio ? 'audio' : 'wall', at: audio ? this.time : now });
  }

  clockOf(item) { return item.clock === 'audio' ? this.time : this.now; }
  /** Authored gesture age (prepare stretch removed). */
  ageOf(g) { return warp(g.def, (this.clockOf(g) - g.at) * g.rate, g); }

  start(cue, now) {
    const def = this.profile.gestures[cue.gesture];
    // Same-track conflicts: an additive beat never interrupts a gesture; a full gesture replaces.
    const conflicts = this.gestures.filter(g => !g.recovering && g.def.tracks.some(t => def.tracks.includes(t)));
    if (def.additive && conflicts.length) { this.rejected++; return; }
    // Prepare and recover are paced by how far the hands actually have to travel.
    const stretch = travelStretch(def.reach, side => this.work.arm[side], def.prepareEnd);
    const home = this.profile.postures[this.posture.target];
    const recoverStretch = travelStretch(def.release, side => home[side], def.duration - def.recoverStart);
    // A replaced gesture hands over during the newcomer's (stretched) prepare.
    for (const g of conflicts) this.freeze(g, now, def.prepareEnd * stretch / cue.rate);
    const random = prng(hash(cue.id));
    const jitter = [(random() - .5) * .08, (random() - .5) * .08, (random() - .5) * .06];
    this.gestures.push({ ...cue, def, rate: cue.rate * (1 + (random() - .5) * .06), jitter, stretch, recoverStretch,
      recovering: false, live: null, frozen: null });
    this.lastStart.set(cue.gesture, now);
  }

  /** Per-frame update. input: { face: {pitch,yaw,roll}, actions: [], speech } */
  update(now, dt, input = {}) {
    dt = clamp(dt, 0, .1);
    this.now = now;
    if (input.face) this.lastInput.face = input.face;
    if (input.actions) this.lastInput.actions = input.actions;
    if (this.rebase) {
      for (const g of this.gestures) if (g.clock === 'audio' && !g.recovering) { g.at = now - (this.time - g.at); g.clock = 'wall'; }
      this.rebase = false;
    }
    this.applyAutoPosture(now);
    // Timeline: start due cues, then drop finished gestures.
    this.pending = this.pending.filter(c => {
      if (c.clock === 'audio' && (!this.active || c.epoch !== this.epoch)) return false;
      if (this.clockOf(c) < c.at) return true;
      if (c.kind === 'posture') { if (this.mode === 'auto' || this.mode === c.posture) this.transitionTo(c.posture, now); return false; }
      this.start(c, now);
      return false;
    });
    this.gestures = this.gestures.filter(g => g.recovering
      ? now - g.recoverStart < g.recoverDuration + .2
      // Authored clock, past the slowest lagged group (fingers enter .1 s late).
      : this.ageOf(g) < g.def.duration + REMOVE_AFTER);
    this.observeSpeech(now, dt, input.speech ?? 0);

    const p = this.posture;
    if (this.status === 'paused' && !this.gestures.some(g => g.recovering)) p.start += dt;
    const k = smoother((now - p.start) / MOTION_DEFAULTS.postureTransition);
    const target = this.profile.postures[p.target];
    for (const key of ['L', 'R', 'body']) {
      const current = p.current[key], from = p.from[key], to = target[key];
      for (let i = 0; i < current.length; i++) current[i] = mix(from[i], to[i], k);
      if (key !== 'body') { current.set(from.subarray(PALM, POINT + 3), PALM); mixHand(current, to, k); }
    }

    const arms = this.work.arm, body = this.work.body;
    for (const side of SIDES) arms[side].set(p.current[side]);
    body.set(p.current.body);
    const intensity = this.options.intensity;
    if (this.inspection) this.blendGesture(this.inspection, now, arms, body, 1);
    else for (const g of this.gestures) this.blendGesture(g, now, arms, body, intensity);
    this.compose(now, dt, arms, body);
    return this.locals;
  }

  blendGesture(g, now, arms, body, intensity) {
    const def = g.def;
    let live = g.live;
    if (!g.recovering) {
      const age = g.fixedAge ?? this.ageOf(g);
      live = g.live ??= { age: 0, weights: {}, values: {} };
      live.age = age;
      for (const track of def.tracks) {
        const trackData = def.compiled[track];
        if (!trackData) continue;
        const isBody = track === 'body';
        const values = live.values[track] ??= new Float64Array(isBody ? BODY.length : ARM);
        const weights = live.weights[track] ??= {};
        if (isBody) {
          sampleTrack(trackData, age, values);
          weights.body = envelope(def, age) * g.strength * intensity;
          continue;
        }
        weights.scale = clamp(g.strength * intensity);
        for (const group of GROUPS) {
          const lagged = age - OVERLAP.enter[group];
          sampleTrack(trackData, lagged, this.work.sample);
          for (const i of GROUP_INDEX[group]) values[i] = this.work.sample[i];
          if (group === 'position') weights.progress = envelope(def, lagged);
          weights[group] = clamp(envelope(def, lagged) * weights.scale);
        }
      }
    }
    const frozen = g.recovering ? g.frozen : live;
    if (!frozen) return;
    for (const track of Object.keys(frozen.values)) {
      const values = frozen.values[track], weights = frozen.weights[track];
      const fade = group => g.recovering
        ? 1 - smoother((now - g.recoverStart - OVERLAP.recover[group]) / g.recoverDuration)
        : 1;
      if (track === 'body') {
        const w = weights.body * fade('position');
        for (let i = 0; i < BODY.length; i++) body[i] += values[i] * w;
        continue;
      }
      const arm = arms[track];
      if (def.additive) {
        for (const group of GROUPS) {
          const w = weights[group] * fade(group);
          for (const i of GROUP_INDEX[group]) arm[i] += values[i] * w;
        }
        continue;
      }
      // Absolute pose: blend from whatever lies underneath (posture or an earlier gesture).
      const wp = weights.position * fade('position');
      const from = [arm[0], arm[1], arm[2]];
      for (const group of GROUPS) {
        const w = weights[group] * fade(group);
        if (group === 'orientation') { mixHand(arm, values, w); continue; }
        for (const i of GROUP_INDEX[group]) arm[i] = mix(arm[i], values[i], w);
      }
      // Arc away from the body while travelling, so paths swing around the torso and skirt.
      // The arc follows transition progress (not the intensity-scaled weight), so a soft
      // gesture holds without a residual offset.
      const travel = Math.hypot(values[0] - from[0], values[1] - from[1], values[2] - from[2]);
      const progress = clamp(weights.progress * fade('position'));
      const arc = def.arc ? { ...MOTION_DEFAULTS.arc, ...def.arc } : MOTION_DEFAULTS.arc, swing = Math.sin(Math.PI * progress) * weights.scale;
      const bulge = swing * Math.min(travel * arc.gain, arc.max);
      const side = this.rig.sides[track], sign = side.sign;
      // Long transfers also fold the elbow mid-way (hand drawn toward the shoulder), as
      // people do, instead of sweeping a straight arm.
      const tuck = swing * arc.tuck * clamp(travel / arc.tuckTravel);
      for (let i = 0; i < 3; i++) arm[i] += (side.A0[i] - arm[i]) * tuck;
      arm[0] += sign * arc.out * bulge + g.jitter[0] * wp; arm[1] += g.jitter[1] * wp; arm[2] += arc.forward * bulge + g.jitter[2] * wp;
    }
  }

  observeSpeech(now, dt, level) {
    if (!this.options.natural || !this.active || this.status !== 'playing' || this.posture.target !== 'speaking') { this.quiet = 0; return; }
    if (level < .06) { this.quiet += dt; return; }
    if (level > .16 && this.quiet >= MOTION_DEFAULTS.beatGap && now - this.lastBeat >= MOTION_DEFAULTS.beatCooldown) {
      this.lastBeat = now; this.beats++;
      this.enqueue({ id: `beat-${this.epoch}-${this.beats}`, kind: 'gesture', gesture: 'beat', epoch: this.epoch, clock: 'audio',
        at: this.time, strength: .7 + this.random() * .3 });
    }
    this.quiet = 0;
  }

  compose(now, dt, arms, body) {
    const D = MOTION_DEFAULTS, natural = this.options.natural, locals = this.locals;
    // Breathing: chest and shoulders on the wall clock, continuing through pause.
    let breath = 0;
    if (natural) {
      this.phase.breath = (this.phase.breath + dt / this.phase.period) % 1;
      if (this.phase.breath < dt / this.phase.period) this.phase.period = D.breathPeriod * (.92 + this.random() * .16);
      const x = this.phase.breath;
      breath = x < .42 ? smoother(x / .42) : 1 - smoother((x - .42) / .58);
    }
    const micro = natural ? {
      yaw: D.micro.headYaw * (.65 * Math.sin(now * .37 + this.micro[0]) + .35 * Math.sin(now * .91 + this.micro[1])),
      pitch: D.micro.headPitch * (.6 * Math.sin(now * .29 + this.micro[2]) + .4 * Math.sin(now * 1.13 + this.micro[3])),
      side: D.micro.bodySide * Math.sin(now * .21 + this.micro[4]),
    } : { yaw: 0, pitch: 0, side: 0 };
    const [lean, twist, side, bodyHeadPitch, bodyHeadYaw, bodyHeadRoll, neckForward, gazePitch,
      authoredGazeYaw, pelvisPitch, pelvisRoll, hipShift] = body;
    // Head, neck and gaze are combined and limited here, in one place.
    const face = this.lastInput.face, glance = this.lastInput.actions.includes('glance');
    const req = {
      pitch: clamp(face.pitch + bodyHeadPitch + micro.pitch, ...D.head.pitch),
      yaw: clamp(face.yaw + bodyHeadYaw + micro.yaw, ...D.head.yaw),
      roll: clamp(face.roll + bodyHeadRoll, ...D.head.roll),
    };
    const s = this.springs;
    // An audio pause freezes the expression's physical follow-through as well as
    // its keys. Retraction after cancellation still advances on the wall clock.
    const step = this.status === 'paused' && !this.gestures.some(g => g.recovering) ? 0 : dt;
    const returning = this.gestures.some(g => g.recovering || this.ageOf(g) >= g.def.recoverStart);
    const gazeTarget = authoredGazeYaw + bodyHeadYaw + (glance ? face.yaw * D.eyes.glanceLead : 0);
    const gazeYaw = spring(s.gazeYaw, gazeTarget, D.springs.gaze, step);
    const gazeP = spring(s.gazePitch, gazePitch + bodyHeadPitch, D.springs.gaze, step);
    const headOmega = returning ? 24 : D.springs.head;
    const hp = spring(s.headPitch, req.pitch, headOmega, step), hy = spring(s.headYaw, req.yaw, headOmega, step), hr = spring(s.headRoll, req.roll, headOmega, step);
    const share = D.head.neckShare;
    const neckOmega = returning ? 22 : D.springs.neck;
    const np = spring(s.neckPitch, hp * share, neckOmega, step), ny = spring(s.neckYaw, hy * share, neckOmega, step), nr = spring(s.neckRoll, hr * share, neckOmega, step);
    const chestFollow = spring(s.chestYaw, hy * D.head.chestYawShare, returning ? 22 : D.springs.chest, step);
    // Keep velocity across cue replacement/retraction. This is purposeful weight
    // transfer, not oscillating noise: gaze leads, chest follows, pelvis settles last.
    const settling = returning || (!this.inspection && !this.gestures.length);
    const bodyOmega = settling ? 30 : 16, supportOmega = settling ? 26 : 13;
    const torsoPitch = spring(s.lean, clamp(lean, -.38, .58), bodyOmega, step);
    const torsoTwist = spring(s.twist, clamp(twist, -.42, .42), bodyOmega, step);
    const torsoRoll = spring(s.side, clamp(side + micro.side, -.24, .24), bodyOmega, step);
    const torsoYaw = torsoTwist + chestFollow;
    const hipPitch = spring(s.pelvisPitch, clamp(pelvisPitch - torsoPitch * .10, -.12, .12), supportOmega, step);
    const hipRoll = spring(s.pelvisRoll, clamp(pelvisRoll - torsoRoll * .18, -.10, .10), supportOmega, step);
    const shift = spring(s.hipShift, clamp(hipShift - torsoRoll * .65, -.28, .28), supportOmega, step);
    if (this.rig.support) {
      const { root, pelvis } = this.rig.support;
      locals.set(pelvis, qeuler(hipPitch, 0, hipRoll, locals.get(pelvis)));
      // Lower the centre only enough to make both ankle constraints reachable;
      // opposite horizontal travel balances the mass carried forward by the bow.
      locals.translations.set(root, [shift, -Math.abs(hipRoll) * 1.15 - Math.abs(hipPitch) * .45 - shift * shift * .22,
        -Math.max(0, torsoPitch) * .7]);
    }
    locals.set(this.rig.torso.spine.name, qeuler(torsoPitch * .56, torsoTwist * .4, torsoRoll * .42, locals.get(this.rig.torso.spine.name)));
    locals.set(this.rig.torso.chest.name, qeuler(torsoPitch * .29 - breath * D.breath.chest * .5, torsoTwist * .35 + chestFollow * .5, torsoRoll * .34, locals.get(this.rig.torso.chest.name)));
    locals.set(this.rig.torso.upperChest.name, qeuler(torsoPitch * .15 - breath * D.breath.upperChest, torsoTwist * .25 + chestFollow * .5, torsoRoll * .24, locals.get(this.rig.torso.upperChest.name)));
    // Partial visual fixation: the head participates in a bow or lean, while an
    // authored headPitch can lift the chin independently. Full inverse compensation
    // made every body expression look like a stationary head on a moving neck.
    const compPitch = (torsoPitch - breath * (D.breath.chest * .5 + D.breath.upperChest)) * .45, compYaw = torsoYaw * .55, compRoll = torsoRoll * .45;
    locals.set(this.rig.torso.neck.name, qeuler(np + neckForward - compPitch * .4, ny - compYaw * .4, nr - compRoll * .4, locals.get(this.rig.torso.neck.name)));
    locals.set(this.rig.torso.head.name, qeuler(hp - np - neckForward - compPitch * .6, hy - ny - compYaw * .6, hr - nr - compRoll * .6, locals.get(this.rig.torso.head.name)));
    const glanceGain = glance ? 1 : D.eyes.vor;
    const eyesYaw = clamp((gazeYaw - hy) * glanceGain, -D.eyes.yaw, D.eyes.yaw);
    const eyesPitch = clamp((gazeP - hp) * D.eyes.vor, -D.eyes.pitch, D.eyes.pitch);
    locals.set(this.rig.torso.eyes.name, qeuler(eyesPitch, eyesYaw, 0, locals.get(this.rig.torso.eyes.name)));
    Object.assign(this.head, { pitch: hp, yaw: hy, roll: hr, eyesYaw, eyesPitch });
    // Read the actual hierarchy, including the pelvis translation, rather than
    // assuming the spine is a fixed world root. Wrists and poles ride with the torso.
    if (this.rig.support) solveSupport(this.rig, locals, this.fk);
    else forwardKinematics(this.rig, locals, this.fk);
    const chest = this.fk.get(this.rig.torso.upperChest.name), rot = chest.rotation, pos = chest.position;
    for (const sideKey of SIDES) {
      const a = arms[sideKey];
      const sign = this.rig.sides[sideKey].sign;
      // Small inertial drag is tied to torso velocity and asymmetrical shoulder
      // response. The hand stays chest-relative, so large bows cannot strand it.
      const drag = clamp(s.twist.v * .045, -.065, .065);
      const pose = {
        hand: [a[0] - drag, a[1], a[2]], pole: [a[3], a[4], a[5]], palm: [a[6], a[7], a[8]], point: [a[9], a[10], a[11]],
        shrug: a[SHRUG] + breath * D.breath.shoulder - sign * torsoRoll * .075,
        protract: a[PROTRACT] - sign * torsoTwist * .08, curl: a[CURL], thumb: a[THUMB], spread: a[SPREAD],
      };
      solveArm(this.rig, sideKey, pose, rot, pos, locals, this.diag[sideKey]);
    }
    this.breath = breath;
    this.bodyState = { lean: torsoPitch, twist: torsoTwist, side: torsoRoll, pelvisPitch: hipPitch, pelvisRoll: hipRoll, hipShift: shift };
    this.gaze = { yaw: gazeYaw, pitch: gazeP, targetYaw: gazeTarget, targetPitch: gazePitch + bodyHeadPitch };
  }

  snapshot() {
    const gestures = this.gestures.map(g => {
      const age = g.recovering ? (g.frozen?.age ?? 0) : this.ageOf(g);
      return { id: g.id, gesture: g.gesture, name: g.def.name, clock: g.clock, epoch: g.epoch, age,
        strength: g.strength, expressionWeight: g.strength * this.options.intensity * (g.recovering
          ? 1 - smoother((this.now - g.recoverStart) / g.recoverDuration) : 1),
        stretch: g.stretch ?? 1, recoverStretch: g.recoverStretch ?? 1, retractSeconds: g.recovering ? g.recoverDuration : null,
        phase: g.recovering ? 'retract' : phaseOf(g.def, age), recovering: g.recovering,
        retractProgress: g.recovering ? clamp((this.now - g.recoverStart) / g.recoverDuration) : 0 };
    });
    return { mode: this.mode, posture: this.posture.target, postureName: POSTURES[this.posture.target].name,
      postureBlend: smoother((this.now - this.posture.start) / MOTION_DEFAULTS.postureTransition),
      epoch: this.epoch, active: this.active, status: this.status, time: this.time,
      gestures, queued: this.pending.length, rejected: this.rejected, beats: this.beats,
      recovering: gestures.some(g => g.recovering), options: { ...this.options },
      head: { ...this.head }, body: { ...this.bodyState }, gaze: { ...this.gaze },
      bodyVelocity: Object.fromEntries(['lean', 'twist', 'side', 'pelvisPitch', 'pelvisRoll', 'hipShift'].map(key => [key, this.springs[key].v])),
      support: { planted: !!this.rig.support, error: Math.max(0, ...Object.values(this.rig.legs).map(leg => leg.unreachable ?? 0)) },
      reach: { L: this.diag.L.reach, R: this.diag.R.reach } };
  }
}

export { POSTURES, GESTURES };
