// Full-body activity tracks. Units are the PMX model's units, +Y up, +Z forward,
// +X character-left. Planted feet are activity-world targets, never root-relative.
// This is authored procedural animation, not motion capture or a physics simulation.
import { POSTURES } from './motion-profile.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = x => { const v = clamp(x); return v * v * v * (v * (v * 6 - 15) + 10); };
const mix = (a, b, t) => a + (b - a) * t;
const vec = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const add = (a, b) => a.map((v, i) => v + b[i]);
const yawPoint = (v, y) => [v[0] * Math.cos(y) + v[2] * Math.sin(y), v[1], -v[0] * Math.sin(y) + v[2] * Math.cos(y)];
const yawQuaternion = a => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const clone = v => JSON.parse(JSON.stringify(v));
const deepFreeze = v => { if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); } return v; };
const arm = (hand, overrides = {}) => ({ ...clone(POSTURES.listening.L), hand, ...overrides });
const readyHands = () => ({ L: clone(POSTURES.relaxed.L), R: clone(POSTURES.relaxed.R) });
const defaultFeet = { L: [1.143494, 1.411263, -1.105294], R: [-1.143505, 1.411263, -1.105288] };
const footBase = (c, s) => [...(c.feet?.[s]?.position ?? c.feet?.[s] ?? defaultFeet[s])];
const seatedFeet = (c, s) => { const p = footBase(c, s); p[2] = 3.3; return p; };

// Solve the support height from the actual leg lengths instead of making a
// planted ankle chase an unreachable target. This produces the extra knee bend
// needed when the trailing foot is behind the translating pelvis.
function supportHeight(p, c) {
  let lower = 0;
  for (const [s, sign] of [['L', 1], ['R', -1]]) {
    const hip = c.hips?.[s]?.position ?? c.hips?.[s] ?? [sign * .9034266, c.hipHeight ?? 11.178317, -.118098];
    const lengths = c.legLengths?.[s] ?? [4.887788, 4.942139], reach = (lengths[0] + lengths[1]) * .9998;
    const worldHip = add(p.root.position, yawPoint(add(hip, p.pelvis.offset), p.root.yaw));
    const foot = p.feet[s].position, horizontal2 = (worldHip[0] - foot[0]) ** 2 + (worldHip[2] - foot[2]) ** 2;
    const maxY = foot[1] + Math.sqrt(Math.max(0, reach * reach - horizontal2));
    lower = Math.max(lower, worldHip[1] - maxY);
  }
  p.pelvis.offset[1] -= lower;
}

export const ACTIVITY_CATEGORIES = deepFreeze({
  locomotion: '行走与转向', running: '跑步与敏捷', jumping: '跳跃与落地',
  seated: '坐下与坐姿', reading: '阅读与学习', exercise: '运动与伸展', daily: '日常与物品',
});

function neutral(c = {}) {
  return {
    root: { position: [0, 0, 0], yaw: 0 }, pelvis: { offset: [0, 0, 0], pitch: 0, roll: 0 },
    feet: Object.fromEntries(['L', 'R'].map(s => [s, { position: footBase(c, s), rotation: [0, 0, 0, 1], contact: true, pole: [0, 0, 1] }])),
    body: { lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0 },
    hands: readyHands(), face: { preset: 'serene', intensity: .45 }, props: {}, support: 'standing', phase: 'ready',
  };
}
function seat(c = {}) {
  const p = neutral(c);
  p.pelvis.offset = [0, (c.seatHeight ?? 6.1) - 10.55, -1.2];
  p.feet.L.position = seatedFeet(c, 'L'); p.feet.R.position = seatedFeet(c, 'R');
  p.hands.L = arm([1.8, 12.55, 2.2], { palm: [0, -1, 0], point: [0, 0, 1], curl: .15 });
  p.hands.R = arm([1.8, 12.55, 2.2], { palm: [0, -1, 0], point: [0, 0, 1], curl: .15 });
  p.props = { chair: true }; p.support = 'seated'; p.phase = 'seated';
  return p;
}
function blendPose(a, b, x) {
  const t = smooth(x), p = clone(a);
  p.root.position = vec(a.root.position, b.root.position, t); p.root.yaw = mix(a.root.yaw, b.root.yaw, t);
  p.pelvis.offset = vec(a.pelvis.offset, b.pelvis.offset, t);
  for (const k of ['pitch', 'roll']) p.pelvis[k] = mix(a.pelvis[k] ?? 0, b.pelvis[k] ?? 0, t);
  for (const k of Object.keys(b.body)) p.body[k] = mix(a.body[k] ?? 0, b.body[k], t);
  for (const s of ['L', 'R']) {
    p.feet[s].position = vec(a.feet[s].position, b.feet[s].position, t);
    p.feet[s].rotation = vec(a.feet[s].rotation, b.feet[s].rotation, t);
    const len = Math.hypot(...p.feet[s].rotation); p.feet[s].rotation = p.feet[s].rotation.map(v => v / len);
    p.feet[s].contact = a.feet[s].contact && b.feet[s].contact && Math.hypot(...a.feet[s].position.map((v, i) => v - b.feet[s].position[i])) < 1e-6;
    for (const [key, value] of Object.entries(b.hands[s])) {
      if (Array.isArray(value)) p.hands[s][key] = vec(a.hands[s][key] ?? value, value, t);
      else if (typeof value === 'number') p.hands[s][key] = mix(a.hands[s][key] ?? value, value, t);
      else p.hands[s][key] = value;
    }
  }
  p.props = clone(b.props); p.face = clone(b.face); p.support = x >= 1 ? b.support : a.support;
  return p;
}

// A foot swings between two absolute contact anchors. The support foot remains
// exactly fixed even while the character root progresses or turns.
function swingFoot(from, to, t, height = .7) {
  const u = clamp(t), p = vec(from, to, smooth(u));
  p[1] += Math.sin(Math.PI * u) ** 2 * height;
  return p;
}
function gait(p, t, d, c) {
  const start = .45, cadence = d.cadence ?? .62, steps = d.steps ?? 6;
  const overlap = d.running ? 1.28 : .83, travelEnd = start + (steps - 1 + overlap) * cadence;
  const travelDuration = travelEnd - start, ramp = Math.min(cadence * .85, travelDuration * .25);
  // Short, smooth acceleration and deceleration surround a constant-speed walk.
  // A single whole-clip ease would nearly double the middle stride's speed.
  const integral = x => x ** 6 - 3 * x ** 5 + 2.5 * x ** 4;
  const progress = time => {
    const v = clamp(time - start, 0, travelDuration), speed = 1 / (travelDuration - ramp);
    if (v < ramp) return speed * ramp * integral(v / ramp);
    if (v > travelDuration - ramp) return 1 - speed * ramp * integral((travelDuration - v) / ramp);
    return speed * (v - ramp / 2);
  };
  const path = time => {
    const u = progress(time);
    let position = (d.displacement ?? [0, 0, 9]).map(v => v * u);
    const yaw = (d.turn ?? 0) * u;
    if (d.arc) { const a = d.arc.angle * u, r = d.arc.radius; position = [r * (1 - Math.cos(a)), 0, r * Math.sin(a)]; }
    return { position, yaw };
  };
  p.root = path(t);
  let flying = 0;
  for (const s of ['L', 'R']) {
    const base = footBase(c, s);
    let anchor = [...base], q = [0, 0, 0, 1], contact = true;
    for (let i = 0; i < steps; i++) {
      if ((i % 2 === 0 ? 'L' : 'R') !== s) continue;
      const begin = start + i * cadence, end = begin + cadence * overlap;
      // Heel lands ahead of the pelvis. During the subsequent stance, the root
      // travels over that fixed foot instead of always chasing an under-body foot.
      const endRoot = path(end + cadence * .5), target = add(endRoot.position, yawPoint(base, endRoot.yaw));
      if (t >= end) { anchor = target; q = yawQuaternion(endRoot.yaw); continue; }
      if (t > begin) {
        const u = (t - begin) / (end - begin);
        anchor = swingFoot(anchor, target, u, d.running ? 1.45 : d.sideStep ? .48 : .75);
        q = yawQuaternion(mix(Math.atan2(2 * q[3] * q[1], 1 - 2 * q[1] ** 2), endRoot.yaw, smooth(u)));
        contact = false;
      }
      break;
    }
    p.feet[s] = { ...p.feet[s], position: anchor, rotation: q, contact };
    if (!contact) flying++;
  }
  // Both feet finish beneath the displaced root. A short final gathering step
  // places the foot that landed one stride earlier without sliding either sole.
  const gatherStart = travelEnd + .08, gatherEnd = gatherStart + .48;
  const lastSide = steps % 2 === 0 ? 'L' : 'R', finalRoot = path(travelEnd);
  const finalTarget = add(finalRoot.position, yawPoint(footBase(c, lastSide), finalRoot.yaw));
  if (t > gatherStart) {
    const from = p.feet[lastSide].position;
    p.feet[lastSide].position = swingFoot(from, finalTarget, (t - gatherStart) / .48, .45);
    p.feet[lastSide].contact = t >= gatherEnd;
    p.feet[lastSide].rotation = yawQuaternion(finalRoot.yaw);
  }
  const active = smooth((t - .2) / .35) * (1 - smooth((t - travelEnd) / .55));
  const cycle = (t - start) / cadence * Math.PI;
  p.pelvis.offset[1] = -.18 * active - .12 * active * (1 - Math.cos(cycle * 2));
  p.pelvis.offset[0] = .19 * Math.cos(cycle) * active;
  p.body.lean = (d.running ? .14 : .035) * active;
  p.body.twist = .045 * Math.sin(cycle) * active; p.body.headRoll = -.016 * Math.cos(cycle) * active;
  for (const [s, sign] of [['L', 1], ['R', -1]]) {
    const sw = Math.sin(cycle) * sign * active;
    p.hands[s] = arm([2.65, d.running ? 13.1 + .45 * sw : 11.3 + .2 * Math.abs(sw), (d.running ? 1.15 : .15) + sw * (d.running ? 1.1 : .9)],
      { pole: [.25, -.1, -1], curl: d.running ? .55 : .22, palm: [-.85, 0, .1], point: [0, -.9, .4] });
  }
  if (d.running && flying === 2 && t < travelEnd) {
    p.support = 'airborne';
    p.root.position[1] = Math.min(.18, Math.max(0, Math.min(...['L', 'R'].map(s => p.feet[s].position[1] - footBase(c, s)[1]))) * .3);
    p.phase = 'flight';
  } else p.phase = t < start ? 'prepare' : t > travelEnd ? 'gather' : 'stride';
  supportHeight(p, c);
  if (t >= d.duration) p.phase = 'arrived';
}

function jump(p, t, d, c) {
  const takeoff = .9, flight = d.flight ?? .75, land = takeoff + flight, settle = land + .7;
  const target = d.displacement ?? [0, 0, 0], height = d.height ?? 2.5;
  const wind = Math.sin(Math.PI * clamp(t / takeoff)) ** 2;
  p.pelvis.offset[1] = -.95 * wind; p.body.lean = .13 * wind;
  if (t > takeoff && t < land) {
    const u = (t - takeoff) / flight;
    p.root.position = target.map(v => v * u); p.root.position[1] += 4 * height * u * (1 - u);
    p.root.yaw = (d.turn ?? 0) * smooth(u);
    p.pelvis.offset[1] = -.25 * Math.sin(Math.PI * u);
    for (const s of ['L', 'R']) {
      const base = yawPoint(footBase(c, s), p.root.yaw);
      const spread = d.jack ? Math.sin(Math.PI * u) * (s === 'L' ? 1 : -1) * 2.0 : 0;
      p.feet[s].position = add(p.root.position, add(base, [spread, .45 * Math.sin(Math.PI * u), -.25 * Math.sin(Math.PI * u)]));
      p.feet[s].rotation = yawQuaternion(p.root.yaw); p.feet[s].contact = false;
    }
    p.support = 'airborne'; p.phase = 'flight';
  } else if (t >= land) {
    p.root.position = [...target]; p.root.yaw = d.turn ?? 0;
    for (const s of ['L', 'R']) { p.feet[s].position = add(target, yawPoint(footBase(c, s), p.root.yaw)); p.feet[s].rotation = yawQuaternion(p.root.yaw); }
    const u = clamp((t - land) / .7);
    p.pelvis.offset[1] = -.85 * Math.sin(Math.PI * u) ** 2; p.body.lean = .12 * Math.sin(Math.PI * u) ** 2;
    p.phase = t < settle ? 'absorb' : 'landed';
  } else p.phase = 'crouch';
  const lift = t < takeoff ? smooth(t / takeoff) : t < land ? 1 : 1 - smooth((t - land) / .7);
  for (const s of ['L', 'R']) p.hands[s] = arm([mix(2.7, d.jack ? 4.2 : 2.8, lift), mix(11.4, d.jack ? 18.6 : 16.4, lift), mix(-.2, 2.3, lift)],
    { palm: [-.5, .1, .8], point: [0, .8, .3], curl: .15, spread: .2 });
  p.face = { preset: 'determined', intensity: .55 };
}

function sitDown(t, c, slow = false) {
  const p = neutral(c), target = seat(c), shiftEnd = slow ? 2.1 : 1.7, lowerEnd = slow ? 4.5 : 3.5;
  p.props = { chair: true };
  for (const [s, start] of [['L', .15], ['R', .8]]) {
    const u = (t - start) / .75;
    p.feet[s].position = swingFoot(footBase(c, s), seatedFeet(c, s), u, .65);
    p.feet[s].contact = u <= 0 || u >= 1;
  }
  // Move the pelvis over the stepping support before lowering back to the seat.
  p.root.position[2] = 2.8 * smooth(t / 1.55);
  if (t >= shiftEnd) {
    const u = smooth((t - shiftEnd) / (lowerEnd - shiftEnd));
    p.root.position[2] = 2.8 * (1 - u); p.pelvis.offset = target.pelvis.offset.map(v => v * u);
    p.hands = blendPose(neutral(c), target, u).hands;
    p.body.lean = .21 * Math.sin(Math.PI * u) + .025 * u;
    p.support = u >= 1 ? 'seated' : 'standing'; p.phase = u >= 1 ? 'seated' : 'lower';
  } else p.phase = 'position_feet';
  supportHeight(p, c);
  return p;
}
function standUp(t, c) {
  const p = seat(c), u = smooth((t - .6) / 2.0), forward = seatedFeet(c, 'L')[2] - footBase(c, 'L')[2];
  p.root.position[2] = forward * u;
  p.pelvis.offset = p.pelvis.offset.map(v => u === 1 ? 0 : v * (1 - u));
  p.body.lean = .28 * Math.sin(Math.PI * clamp(t / 2.9));
  p.hands = blendPose(seat(c), neutral(c), smooth((t - 1.3) / 1.5)).hands;
  p.support = t < 1 ? 'seated' : 'standing'; p.phase = t < .6 ? 'lean_forward' : t < 2.6 ? 'rise' : 'standing';
  return p;
}

function standUpFromDesk(t, c) {
  const retreat = 3.5, shiftBegin = .25, shiftEnd = 2.8, riseBegin = 3.35;
  const shiftAt = time => retreat * smooth((time - shiftBegin) / (shiftEnd - shiftBegin));
  if (t >= riseBegin) {
    const p = standUp(t - riseBegin, c);
    p.root.position[2] -= retreat;
    for (const side of ['L', 'R']) p.feet[side].position[2] -= retreat;
    p.props.chair = { visible: true, position: [0, 0, -1.2 - retreat] };
    p.seatOffset = [0, 0, -retreat]; p.phase = `desk_${p.phase}`;
    return p;
  }
  const p = seat(c), shift = shiftAt(t);
  p.root.position[2] = -shift; p.seatOffset = [0, 0, -shift];
  p.props.chair = { visible: true, position: [0, 0, -1.2 - shift] };
  // Retain the table in its existing world placement. Feet step backward in
  // alternation while the seated body and chair retreat, rather than dragging
  // two planted soles under a translating chair.
  for (const side of ['L', 'R']) {
    let position = seatedFeet(c, side), contact = true;
    for (let i = 0; i < 4; i++) {
      if ((i % 2 === 0 ? 'L' : 'R') !== side) continue;
      const begin = .3 + i * .6, end = begin + .52;
      const target = seatedFeet(c, side); target[2] -= shiftAt(end + .3);
      if (t >= end) { position = target; continue; }
      if (t > begin) { position = swingFoot(position, target, (t - begin) / .52, .35); contact = false; }
      break;
    }
    const gatherStart = 2.65, gatherEnd = 3.15;
    if (side === 'L' && t > gatherStart) {
      const target = seatedFeet(c, side); target[2] -= retreat;
      position = swingFoot(position, target, (t - gatherStart) / (gatherEnd - gatherStart), .28);
      contact = t >= gatherEnd;
    }
    p.feet[side] = { ...p.feet[side], position, contact };
  }
  p.body.lean = .05 * Math.sin(Math.PI * clamp(t / riseBegin));
  p.phase = t < .3 ? 'desk_prepare_retreat' : t < 3.15 ? 'desk_retreat_seated' : 'desk_ready_to_rise';
  return p;
}

function reading(p, t, d) {
  const active = smooth(t / .75), seated = d.initialSupport === 'seated';
  const phase = (t % 5) / 5;
  p.hands.L = arm([1.55, 12.85, 3.1], { palm: [.2, .7, .6], point: [0, .1, 1], curl: .2 });
  p.hands.R = arm([1.55, 12.85, 3.1], { palm: [.2, .7, .6], point: [0, .1, 1], curl: .2 });
  p.body.headPitch = .18 * active; p.body.lean = (seated ? .07 : .025) * active;
  p.body.headYaw = .03 * Math.sin(t * .6); p.face = { preset: 'attentive', intensity: .65 };
  p.props.book = { visible: true, attachment: 'both', openness: .8, pageTurn: 0 };
  p.phase = 'read';
  if (d.pageTurn || d.kind === 'study') {
    const u = clamp((t - 1.8) / 1.8), sweep = Math.sin(Math.PI * u) ** 2;
    p.hands.R.hand = [mix(1.55, -.6, sweep), 12.85 + .43 * sweep, 3.1 + .08 * sweep];
    p.props.book.pageTurn = smooth(u); p.phase = u > 0 && u < 1 ? 'turn_page' : 'read';
  }
  if (d.kind === 'look_up_book') { const look = Math.sin(Math.PI * clamp((t - 1.5) / 3)) ** 2; p.body.headPitch -= .24 * look; p.body.headYaw += .15 * look; p.phase = look > .1 ? 'look_up' : 'read'; }
  if (d.kind === 'close_book') { const close = smooth((t - 1.5) / 1.4); p.props.book.openness = .8 * (1 - close); p.hands.L.hand[0] = p.hands.R.hand[0] = 1.55 - .8 * close; p.body.headPitch *= 1 - close; p.phase = close >= 1 ? 'closed_book' : 'close_book'; }
  if (d.kind === 'study') { p.props.table = true; p.face = { preset: phase < .5 ? 'considering' : 'understanding', intensity: .65 }; }
}

function exercise(p, t, d, c) {
  const enter = d.enter ?? 1.25, leave = d.duration - 1.2;
  const a = smooth(t / enter) * (1 - smooth((t - leave) / 1.2));
  const cycle = Math.sin(Math.PI * clamp((t - .65) / (d.duration - 1.3))) ** 2;
  p.props.mat = true; p.face = { preset: 'determined', intensity: .5 };
  p.phase = t < enter ? 'prepare' : t > leave ? 'recover' : 'exercise';
  if (d.kind === 'squat' || d.kind === 'squat_hold') {
    const depth = d.kind === 'squat_hold' ? a : cycle;
    p.pelvis.offset = [0, -2.4 * depth, -1.45 * depth]; p.body.lean = .21 * depth;
    for (const s of ['L', 'R']) p.hands[s] = arm([1.5, 13.7, 3.4], { palm: [0, -.7, .7], point: [0, .1, 1], curl: .25 });
  } else if (['lunge', 'side_lunge'].includes(d.kind)) {
    const side = d.side ?? 'L', begin = .25, end = 1.2, back = d.duration - 1.25;
    const base = footBase(c, side), delta = d.kind === 'side_lunge' ? [side === 'L' ? 3.3 : -3.3, 0, .3] : [0, 0, 4.0];
    const planted = add(base, delta), u = t < end ? (t - begin) / (end - begin) : t > back ? 1 - (t - back) / .95 : 1;
    p.feet[side].position = swingFoot(base, planted, u, .6); p.feet[side].contact = t <= begin || (t >= end && t <= back) || t >= back + .95;
    p.pelvis.offset = [delta[0] * .42 * a, -1.6 * a, delta[2] * .45 * a]; p.body.lean = .11 * a;
    for (const s of ['L', 'R']) p.hands[s] = arm([1.8, 13, 2.8], { curl: .18 });
  } else if (d.kind === 'balance') {
    const side = d.side ?? 'L', supportSign = side === 'L' ? -1 : 1;
    p.pelvis.offset = [supportSign * .78 * a, -.2 * a, 0]; p.body.side = -.035 * supportSign * a;
    p.feet[side].position = add(footBase(c, side), [0, 2.5 * a, 1.5 * a]); p.feet[side].contact = a < 1e-7;
    for (const s of ['L', 'R']) p.hands[s] = arm([3.9, 13.8, .8], { palm: [0, -1, 0], point: [.9, .05, .1], curl: .1 });
  } else if (d.kind === 'stretch_up') {
    p.body.lean = -.04 * a; p.body.headPitch = -.11 * a;
    for (const s of ['L', 'R']) p.hands[s] = arm([mix(2.7, 1.8, a), mix(11.3, 19.5, a), mix(0, 1.1, a)], { palm: [0, 1, .1], point: [0, 1, 0], curl: .15 });
  } else if (d.kind === 'side_stretch') {
    const sign = d.side === 'R' ? -1 : 1;
    p.body.side = .14 * sign * a; p.pelvis.offset[0] = -.35 * sign * a; p.pelvis.offset[1] = -.025 * a;
    p.hands[d.side ?? 'L'] = arm([2.1, 19.0, 1.0], { point: [0, 1, 0], palm: [0, .8, .2] });
    p.body.headRoll = .12 * sign * a;
  } else if (d.kind === 'torso_twist') {
    const angle = .2 * Math.sin(t * 1.05) * a; p.body.twist = angle; p.body.headYaw = angle * .5;
    for (const s of ['L', 'R']) p.hands[s] = arm([2.5, 14.1, 2.2], { curl: .3, palm: [0, -.8, .3] });
  } else if (d.kind === 'forward_fold') {
    p.pelvis.offset = [0, -.6 * a, -.8 * a]; p.body.lean = .55 * a; p.body.headPitch = .18 * a;
    for (const s of ['L', 'R']) p.hands[s] = arm([1.7, 12.8, 2.5], { palm: [0, -1, 0], point: [0, -1, .2], curl: .1 });
  } else if (d.kind === 'shoulder_roll') {
    for (const s of ['L', 'R']) { p.hands[s].hand[1] += .03 + .18 * a; p.hands[s].shrug = .08 * Math.sin(t * 2) * a; p.hands[s].protract = .12 * Math.cos(t * 2) * a; }
    p.body.lean = .035 * Math.sin(t * 2) * a;
  } else if (d.kind === 'tai_chi') {
    const w = Math.sin(t * .75) * a; p.pelvis.offset = [.55 * w, -.55 * a, 0]; p.body.twist = .13 * w;
    for (const [s, sign] of [['L', 1], ['R', -1]]) p.hands[s] = arm([2.2 + .8 * sign * w, 13.5 + .8 * sign * Math.cos(t * .75), 2.6 + .3 * sign * w], { palm: [0, .4 * sign * w, .8], point: [0, .5, .5], curl: .12 });
  }
}

function daily(p, t, d, c) {
  const a = smooth(t / .9), wave = Math.sin(Math.PI * clamp((t - 1) / (d.duration - 2))) ** 2;
  p.phase = t < .9 ? 'prepare' : t > d.duration - 1.4 ? 'settle' : d.kind;
  if (d.kind === 'drink') {
    const lift = Math.sin(Math.PI * clamp((t - .7) / (d.duration - 1.4))) ** 2;
    p.hands.R = arm([mix(2.1, .65, lift), mix(12.8, 16.4, lift), mix(2.8, 1.3, lift)], { curl: .65, thumb: .5, palm: [-1, 0, 0], point: [0, 1, .2] });
    p.props.mug = { visible: true, attachment: 'right', rotation: [lift * -.35, 0, 0] };
    p.body.headPitch = -.08 * lift; p.face = { preset: 'relieved', intensity: .4 };
  } else if (d.kind === 'write') {
    p.props.table = true; p.props.paper = { visible: true, attachment: 'table' }; p.props.pencil = { visible: true, attachment: 'right', tipSurface: 'paper' };
    p.hands.L = arm([1.8, 13.95, 3.1], { palm: [0, -1, 0], curl: .1, point: [0, -.2, 1] });
    p.hands.R = arm([.8 + .35 * Math.sin(t * 2.6) * a, 14.5 + .07 * Math.sin(t * 5), 3.1 + .12 * Math.cos(t * 4)], { palm: [-.4, -.7, .1], curl: .7, point: [0, -.2, 1] });
    p.body.lean = .12; p.body.headPitch = .22; p.face = { preset: 'considering', intensity: .6 };
  } else if (d.kind === 'keyboard') {
    p.props.table = true; p.props.laptop = { visible: true, attachment: 'table' };
    for (const [s, sign] of [['L', 1], ['R', -1]]) p.hands[s] = arm([1.15 + .08 * Math.sin(t * 4 * sign), 13.95 + .05 * Math.sin(t * 7 + sign), 3.1], { palm: [0, -1, .1], curl: .32 + .12 * Math.sin(t * 8 + sign), point: [0, -.1, 1] });
    p.body.lean = .11; p.body.headPitch = .12; p.face = { preset: 'attentive', intensity: .6 };
  } else if (d.kind === 'pickup') {
    p.pelvis.offset = [0, -2.609 * wave, -.25 * wave]; p.body.lean = .075 * wave; p.body.headPitch = .09 * wave;
    p.hands.L = arm([2.183, 13.5, 3.35], { palm: [1, 0, 0], curl: .45 });
    p.hands.R = arm([2.183, 13.5, 3.35], { palm: [1, 0, 0], curl: .45 });
    p.props.table = { visible: true, position: [0, 0, 4.0] };
    // The takeover pose was checked in actual PMX FK: palms ~[±2.15,10.4,3.33]
    // meet the box's side grips before attachment changes, with its base at8.9.
    p.props.box = t < d.duration / 2 ? { visible: true, attachment: 'table', position: [0, 8.9, 3.332] } : { visible: true, attachment: 'both', fitToHands: false };
  } else if (d.kind === 'carry') {
    // Back away from the pickup table; forward travel would cross its retained
    // top and frame. Furniture remains in the scene throughout the handoff.
    gait(p, t, { ...d, displacement: [0, 0, -6.5], cadence: .7, steps: 4 }, c);
    for (const s of ['L', 'R']) p.hands[s] = arm([2.183, 13.4, 3.1], { palm: [1, 0, 0], curl: .5 });
    p.props.box = { visible: true, attachment: 'both', fitToHands: false }; p.body.lean += .045;
  } else if (d.kind === 'sit_listen') { p.body.lean = .08 * a; p.body.headRoll = .055 * Math.sin(t * .55); p.face = { preset: 'attentive', intensity: .7 }; }
  else if (d.kind === 'sit_relax') { p.body.lean = -.06 * a; p.body.headPitch = -.025; p.face = { preset: 'serene', intensity: .6 }; }
  else if (d.kind === 'sit_talk') {
    p.hands.R = arm([1.9 + .35 * wave, 13.7 + .3 * wave, 3.3], { palm: [0, .8, .2], point: [.2, 0, 1], curl: .18 });
    p.body.twist = -.08 * wave; p.body.headYaw = -.06 * wave; p.face = { preset: 'acknowledge_soft', intensity: .65 };
  } else if (d.kind === 'sit_stretch') {
    p.body.lean = -.05 * wave; p.body.headPitch = -.07 * wave;
    for (const s of ['L', 'R']) p.hands[s] = arm([mix(1.8, 2.5, wave), mix(12.55, 18.9, wave), mix(2.2, 1.2, wave)], { palm: [0, 1, 0], point: [0, 1, .1], curl: .2 });
  } else if (d.kind === 'ankle_cross') {
    const b = p.feet.R.position; p.feet.R.position = [mix(b[0], .7, wave), b[1] + .4 * wave, b[2] + .5 * wave]; p.feet.R.contact = wave < 1e-7;
    p.body.headPitch = .04 * wave;
  }
}

const library = {};
function define(id, name, category, duration, spec = {}) {
  const initialSupport = spec.initialSupport ?? 'standing';
  library[id] = { id, name, category, description: spec.description ?? name, duration, initialSupport,
    endSupport: spec.endSupport ?? initialSupport, loop: false, requires: spec.requires ?? [], ...spec };
}
// Direction variants have different world paths and support contacts; they are
// intentionally separate commands so the director can select an exact direction.
for (const [id, name, v] of [
  ['walk_forward', '向前走', [0, 0, 18]], ['walk_backward', '向后退', [0, 0, -11]],
  ['walk_left', '向左侧移', [10, 0, 0]], ['walk_right', '向右侧移', [-10, 0, 0]],
  ['walk_forward_left', '向左前方走', [10, 0, 12]], ['walk_forward_right', '向右前方走', [-10, 0, 12]],
  ['walk_back_left', '向左后方退', [7, 0, -8]], ['walk_back_right', '向右后方退', [-7, 0, -8]],
]) define(id, name, 'locomotion', 4.8, { kind: 'gait', displacement: v, sideStep: v[2] === 0, description: `${name}六步，双脚交替落地，结束时保留实际位移。` });
define('walk_slow', '慢慢踱步', 'locomotion', 6.6, { kind: 'gait', cadence: .9, steps: 6, displacement: [0, 0, 6.5] });
define('walk_stop', '走两步停下来', 'locomotion', 2.7, { kind: 'gait', steps: 2, displacement: [0, 0, 5.0] });
define('turn_left', '踏步左转', 'locomotion', 3.6, { kind: 'gait', steps: 4, turn: Math.PI / 2, displacement: [0, 0, 0] });
define('turn_right', '踏步右转', 'locomotion', 3.6, { kind: 'gait', steps: 4, turn: -Math.PI / 2, displacement: [0, 0, 0] });
define('turn_around', '转身回望', 'locomotion', 4.8, { kind: 'gait', steps: 6, turn: Math.PI, displacement: [0, 0, 0] });
define('walk_curve_left', '向左绕弯走', 'locomotion', 5.5, { kind: 'gait', steps: 7, arc: { angle: Math.PI / 2, radius: 9 }, turn: Math.PI / 2 });
define('walk_curve_right', '向右绕弯走', 'locomotion', 5.5, { kind: 'gait', steps: 7, arc: { angle: -Math.PI / 2, radius: -9 }, turn: -Math.PI / 2 });
define('jog_forward', '轻松慢跑', 'running', 4.5, { kind: 'gait', running: true, cadence: .42, steps: 7, displacement: [0, 0, 18] });
define('run_forward', '加速跑几步', 'running', 4.0, { kind: 'gait', running: true, cadence: .34, steps: 7, displacement: [0, 0, 26] });
define('jog_in_place', '原地小跑', 'running', 4.8, { kind: 'gait', running: true, cadence: .4, steps: 8, displacement: [0, 0, 0] });
define('side_shuffle_left', '向左快速并步', 'running', 3.3, { kind: 'gait', cadence: .34, steps: 6, sideStep: true, displacement: [11, 0, 0] });
define('side_shuffle_right', '向右快速并步', 'running', 3.3, { kind: 'gait', cadence: .34, steps: 6, sideStep: true, displacement: [-11, 0, 0] });
for (const [id, name, options] of [
  ['jump_vertical', '原地起跳落地', {}], ['jump_forward', '向前跳', { displacement: [0, 0, 4.5] }],
  ['jump_left', '向左跳', { displacement: [3.6, 0, 0] }], ['jump_right', '向右跳', { displacement: [-3.6, 0, 0] }],
  ['jump_backward', '小幅后跳', { displacement: [0, 0, -2.8], height: 1.8 }],
  ['small_hop', '轻轻弹跳', { height: 1.0, flight: .5 }], ['jump_turn', '跳起转身', { turn: Math.PI / 2, height: 2.2 }],
  ['jumping_jack', '开合跳', { jack: true, height: 1.6, flight: .7 }],
]) define(id, name, 'jumping', 3.1, { kind: 'jump', ...options, description: `${name}：下蹲蓄力、腾空、屈膝缓冲，停止时先落地。` });
define('sit_down', '靠近椅子坐下', 'seated', 4.1, { kind: 'sit_down', endSupport: 'seated', requires: ['chair'] });
define('sit_down_carefully', '扶稳慢慢坐下', 'seated', 5.2, { kind: 'sit_down', slow: true, endSupport: 'seated', requires: ['chair'] });
define('stand_up', '从椅子上站起', 'seated', 3.3, { kind: 'stand_up', initialSupport: 'seated', endSupport: 'standing', requires: ['chair'] });
define('stand_up_from_desk', '退椅离桌后起身', 'seated', 6.85, { kind: 'stand_up_from_desk', initialSupport: 'seated', endSupport: 'standing', requires: ['chair', 'table'],
  description: '保持坐姿把椅子向后移，双脚交替后移，再在桌外站起；桌子留在原处。',
  descriptionEn: 'Retreat with the chair using alternating backward foot placements, then stand clear of the table retained in place.' });
for (const [id, name, kind, duration] of [
  ['sit_listen', '坐着认真倾听', 'sit_listen', 7], ['sit_relax', '坐着放松休息', 'sit_relax', 8],
  ['sit_talk', '坐着抬手交谈', 'sit_talk', 6], ['sit_stretch', '坐着伸个懒腰', 'sit_stretch', 6],
  ['sit_cross_ankles', '坐着轻交脚踝', 'ankle_cross', 6],
]) define(id, name, 'seated', duration, { kind, initialSupport: 'seated', requires: ['chair'] });
for (const [id, name, seated, kind, pageTurn] of [
  ['read_standing', '站着读书', false, 'read', false], ['read_seated', '坐着读书', true, 'read', false],
  ['page_turn_standing', '站着翻页', false, 'read', true], ['page_turn_seated', '坐着翻页', true, 'read', true],
  ['read_look_up', '读书时抬头回应', true, 'look_up_book', false], ['close_book', '合上书想一想', true, 'close_book', false],
  ['study_at_desk', '桌前边读边思考', true, 'study', true],
]) define(id, name, 'reading', kind === 'study' ? 9 : 6, { kind, pageTurn, reading: true, initialSupport: seated ? 'seated' : 'standing', requires: seated ? ['chair', 'book'] : ['book'] });
for (const [id, name, kind, extra] of [
  ['squat', '完整深蹲一次', 'squat', {}], ['squat_hold', '下蹲保持再站起', 'squat_hold', {}],
  ['lunge_left', '左腿前弓步', 'lunge', { side: 'L' }], ['lunge_right', '右腿前弓步', 'lunge', { side: 'R' }],
  ['side_lunge_left', '左侧弓步', 'side_lunge', { side: 'L' }], ['side_lunge_right', '右侧弓步', 'side_lunge', { side: 'R' }],
  ['balance_left', '抬左脚单腿平衡', 'balance', { side: 'L' }], ['balance_right', '抬右脚单腿平衡', 'balance', { side: 'R' }],
  ['stretch_up', '双臂向上伸展', 'stretch_up', {}], ['stretch_left', '向左侧伸展', 'side_stretch', { side: 'L' }],
  ['stretch_right', '向右侧伸展', 'side_stretch', { side: 'R' }], ['torso_twist', '站姿左右转体', 'torso_twist', {}],
  ['forward_fold', '站姿向前舒展', 'forward_fold', {}], ['shoulder_roll', '舒展肩膀', 'shoulder_roll', {}],
  ['tai_chi_shift', '重心流动与推掌', 'tai_chi', {}],
]) define(id, name, 'exercise', kind === 'balance' ? 7 : 6, { kind, ...extra, requires: ['mat'] });
define('drink_standing', '站着举杯喝水', 'daily', 6, { kind: 'drink', requires: ['mug'] });
define('drink_seated', '坐着举杯喝水', 'daily', 6, { kind: 'drink', initialSupport: 'seated', requires: ['chair', 'mug'] });
define('write_at_desk', '坐着写字', 'daily', 8, { kind: 'write', initialSupport: 'seated', requires: ['chair', 'table', 'paper', 'pencil'] });
define('type_at_desk', '坐着打字', 'daily', 8, { kind: 'keyboard', initialSupport: 'seated', requires: ['chair', 'table', 'laptop'] });
define('pickup_box', '从台面抱起物品', 'daily', 5.5, { kind: 'pickup', requires: ['table', 'box'] });
define('carry_box', '抱着物品后退离桌', 'daily', 4.4, { kind: 'carry', requires: ['box'],
  description: '双手托住箱子向后退四步，离开仍保留在原处的桌子。',
  descriptionEn: 'Keep holding the box and take four steps backward, away from the table retained in place.' });

export const ACTIVITY_LIBRARY = deepFreeze(library);
export const ACTIVITY_IDS = Object.freeze(Object.keys(ACTIVITY_LIBRARY));

export function sampleActivity(id, time, context = {}) {
  if (!Object.hasOwn(ACTIVITY_LIBRARY, id)) throw new RangeError(`Unknown activity: ${id}`);
  const d = ACTIVITY_LIBRARY[id];
  if (!Number.isFinite(time)) throw new TypeError('Activity time must be finite');
  const t = clamp(time, 0, d.duration);
  let p = d.initialSupport === 'seated' ? seat(context) : neutral(context);
  if (d.kind === 'gait') gait(p, t, d, context);
  else if (d.kind === 'jump') jump(p, t, d, context);
  else if (d.kind === 'sit_down') p = sitDown(t, context, d.slow);
  else if (d.kind === 'stand_up') p = standUp(t, context);
  else if (d.kind === 'stand_up_from_desk') p = standUpFromDesk(t, context);
  else if (d.reading) reading(p, t, d);
  else if (d.category === 'exercise') exercise(p, t, d, context);
  else daily(p, t, d, context);
  return { ...p, id, time: t, duration: d.duration, done: time >= d.duration, endSupport: d.endSupport };
}

export const ACTIVITY_SEQUENCES = deepFreeze({
  reading_break: { name: '走来坐下，读书再起身', description: '行走、落座、阅读、翻页、抬头、合书、站起和离开。', steps: ['walk_stop', 'sit_down', 'read_seated', 'page_turn_seated', 'read_look_up', 'close_book', 'stand_up', 'walk_forward'] },
  morning_movement: { name: '晨间舒展与慢跑', description: '肩膀和侧腰热身，深蹲、左右弓步、慢跑，最后拉伸。', steps: ['shoulder_roll', 'stretch_up', 'stretch_left', 'stretch_right', 'squat', 'lunge_left', 'lunge_right', 'jog_forward', 'forward_fold'] },
  agility_practice: { name: '多方向步伐与跳跃', description: '前后左右移动，转向、开合跳、向前跳和缓冲落地。', steps: ['walk_forward', 'walk_backward', 'side_shuffle_left', 'side_shuffle_right', 'turn_left', 'jumping_jack', 'jump_forward', 'balance_right'] },
  desk_session: { name: '坐下写作与休息', description: '入座、写字、阅读、打字、喝水、伸腰，然后退椅离桌再起身。', steps: ['sit_down', 'write_at_desk', 'study_at_desk', 'type_at_desk', 'drink_seated', 'sit_stretch', 'stand_up_from_desk'] },
  quiet_afternoon: { name: '安静的午后阅读', description: '慢慢落座，保持坐姿读书、翻页、聆听、喝水和放松。', steps: ['sit_down_carefully', 'read_seated', 'page_turn_seated', 'sit_listen', 'drink_seated', 'sit_relax'] },
  balance_flow: { name: '平衡与重心流动', description: '左右单腿平衡、侧弓步、缓慢转体和推掌。', steps: ['balance_left', 'balance_right', 'side_lunge_left', 'side_lunge_right', 'torso_twist', 'tai_chi_shift', 'stretch_up'] },
  carry_delivery: { name: '取起物品后退离桌', description: '从台面取起箱子，双手保持托举后向后退，避开保留在原处的桌子。',
    descriptionEn: 'Pick up the box from the table, then keep holding it while stepping backward clear of the retained furniture.', steps: ['pickup_box', 'carry_box'] },
});
