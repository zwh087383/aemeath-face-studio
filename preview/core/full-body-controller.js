import { ACTIVITY_LIBRARY, sampleActivity } from './activity-library.js';
import { POSTURES } from './motion-profile.js';
import { buildFullBodyRig, solveFullBodyPose, toWorld, toModel, rootRotation } from './full-body-ik.js';
import { add, sub, len, lerp3, qmul, qslerp, qrotate, qeuler, smoother, clamp } from './motion-math.js';

const SIDES = ['L', 'R'];
const clone = value => structuredClone(value);
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const numbers = (a = {}, b = {}, k) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])]
  .filter(key => typeof (b[key] ?? a[key]) === 'number').map(key => [key, (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * k]));

/** Call update(nowSeconds, dtSeconds). The application owns the clock and applies
 * locals to the PMX, followed by MMD grants. Root position/yaw belongs to an outer
 * scene group; it must never be added to the bone translations a second time. */
export class FullBodyController {
  constructor({ skeleton, library = ACTIVITY_LIBRARY, sampler = sampleActivity } = {}) {
    this.rig = buildFullBodyRig(skeleton); this.context = clone(this.rig.context);
    this.library = library; this.sampler = sampler; this.locals = new Map(); this.fk = new Map();
    this.anchor = { position: [0, 0, 0], yaw: 0 }; this.root = clone(this.anchor);
    this.pose = this.standing(this.root); this.status = 'idle'; this.paused = false;
    this.activeId = null; this.elapsed = 0; this.duration = 0; this.speed = 1;
    this.loop = false; this.cycle = 0; this.queued = null; this.afterPrerequisite = null; this.bridge = null; this.stopMode = null;
    this.revision = 0; this.done = true; this.now = 0;
    this.solve();
  }

  standing(root, feet) {
    return { root: clone(root), pelvis: { offset: [0, 0, 0], pitch: 0, roll: 0 }, body: {},
      hands: clone(POSTURES.relaxed), feet: feet ? clone(feet) : Object.fromEntries(SIDES.map(side => [side, {
        position: toWorld(root, this.context.feet[side]), rotation: rootRotation(root), contact: true }])),
      face: { preset: 'neutral', intensity: .5 }, props: {}, support: 'standing', phase: 'idle', terminal: true };
  }

  /** Invalid commands do not disturb the current owner. A replacement in flight
   * is queued until the next landing instead of snapping the character down. */
  play(id, { loop = false, speed = 1, context = {} } = {}) {
    if (typeof id !== 'string' || !Object.hasOwn(this.library, id) || !Number.isFinite(speed) || speed <= 0) return false;
    const request = { id, options: { loop: !!loop, speed: clamp(speed, .5, 1.6), context } };
    this.paused = false; this.revision++;
    if (this.airborne()) { this.queued = request; this.stopMode = 'landing'; this.status = 'landing'; return true; }
    this.queued = null; this.afterPrerequisite = null; this.start(request); return true;
  }

  start({ id, options }) {
    // A movable chair can leave the original activity frame while the person
    // remains seated. Adopt that attained seat before admitting the next clip.
    this.rebaseSeat();
    const previous = clone(this.pose), definition = this.library[id];
    const seated = previous.support === 'seated';
    const needsSeat = (definition.initialSupport ?? definition.startState) === 'seated';
    if (needsSeat && !seated && this.library.sit_down && id !== 'sit_down') {
      this.afterPrerequisite = { id, options };
      this.start({ id: 'sit_down', options: { ...options, loop: false } }); return;
    }
    if (seated && !needsSeat && definition.seatedStartTime === undefined && id !== 'stand_up' && this.library.stand_up) {
      this.afterPrerequisite = { id, options };
      this.start({ id: 'stand_up', options: { ...options, loop: false } }); return;
    }
    const continueSeat = seated && (definition.seatedStartTime !== undefined || needsSeat || id === 'stand_up');
    if (!continueSeat) this.anchor = { position: [...this.root.position], yaw: this.root.yaw };
    this.activeId = id; this.speed = options.speed; this.loop = options.loop; this.cycle = 0;
    this.sampleContext = { ...this.context, ...options.context, initialSupport: previous.support };
    this.elapsed = continueSeat ? (definition.seatedStartTime ?? 0) : 0;
    this.duration = definition.duration; this.done = false; this.stopMode = null; this.status = 'playing';
    const target = this.sample(this.elapsed);
    // Before a new activity's clock starts, move from the actual pose to its
    // starting stance. Feet relocate one at a time with lift; planted contacts
    // never slide while the old and new poses are crossfaded.
    this.beginBridge(previous, target, previous.support !== target.support ? 1.45 : .42, 'playing');
  }

  sample(time) {
    const sample = clone(this.sampler(this.activeId, time, this.sampleContext));
    const q = rootRotation(this.anchor), localRoot = sample.root ?? { position: [0, 0, 0], yaw: 0 };
    sample.root = { position: toWorld(this.anchor, localRoot.position), yaw: this.anchor.yaw + (localRoot.yaw ?? 0) };
    for (const side of SIDES) {
      const foot = sample.feet[side];
      foot.position = toWorld(this.anchor, foot.position);
      foot.rotation = qmul(q, foot.rotation ?? rootRotation(localRoot));
    }
    sample.anchor = clone(this.anchor); return sample;
  }

  beginBridge(from, target, duration, after) {
    this.bridge = { from: clone(from), target: clone(target), elapsed: 0, duration, after };
    this.status = after === 'playing' ? 'preparing' : 'recovering';
  }

  airborne() { return this.pose.support === 'airborne' || (this.activeId && SIDES.every(side => !this.pose.feet[side].contact)); }

  stop() {
    this.queued = null; this.afterPrerequisite = null; this.paused = false; this.loop = false; this.revision++;
    if (this.pose.support === 'seated') { this.holdSeat(); return; }
    if (this.airborne()) { this.stopMode = 'landing'; this.status = 'landing'; return; }
    // A stop while lowering onto the chair finishes that supported transfer.
    const definition = this.library[this.activeId];
    if ((definition?.endSupport ?? definition?.endState) === 'seated' && (this.pose.pelvis?.offset?.[1] ?? 0) < -1) {
      this.stopMode = 'seat'; this.status = 'seating'; return;
    }
    this.recover();
  }

  holdSeat() {
    this.rebaseSeat();
    this.status = 'seated'; this.done = true; this.bridge = null; this.stopMode = null;
    this.pose.phase = 'seated-hold'; this.pose.terminal = true;
    // Keep hands, chair and book as displayed. Clearing props here would leave a
    // seated avatar unsupported or make an object vanish out of the fingers.
  }

  rebaseSeat() {
    const displacement = this.pose.seatOffset;
    if (this.pose.support !== 'seated' || !Array.isArray(displacement) || displacement.length !== 3
      || !displacement.every(Number.isFinite) || len(displacement) < 1e-9) return;
    const previousAnchor = clone(this.anchor);
    const nextAnchor = { position: toWorld(previousAnchor, displacement), yaw: previousAnchor.yaw };
    const props = this.pose.props ?? {};
    if (props.chair && typeof props.chair === 'object' && Array.isArray(props.chair.position)) {
      props.chair = { ...props.chair, position: toModel(nextAnchor, toWorld(previousAnchor, props.chair.position)) };
    }
    // Scene-owned furniture stays at its attained world transform when omitted.
    // Re-emitting it with a new seat anchor would incorrectly pull the desk back
    // together with the chair. Hand-held objects still follow the measured palms.
    for (const id of ['table', 'paper', 'laptop', 'platform', 'mat']) delete props[id];
    this.anchor = nextAnchor; this.pose.anchor = clone(nextAnchor); this.pose.seatOffset = [0, 0, 0];
  }

  recover() {
    const root = clone(this.root), feet = clone(this.pose.feet);
    root.position[1] = this.anchor.position[1];
    for (const side of SIDES) {
      feet[side].position[1] = this.anchor.position[1] + this.context.feet[side][1];
      feet[side].rotation = rootRotation(root); feet[side].contact = true;
    }
    const target = this.standing(root, feet); target.props = clone(this.pose.props ?? {});
    // A stopped gait can retain a split stance. Raising the pelvis to its almost
    // straight bind height would make that stance unreachable and slide a foot.
    // Keep enough knee flexion for both actual ground contacts instead.
    let drop = 0;
    for (const side of SIDES) {
      const leg = this.rig.legs[side], hip = this.rig.pos(leg.names.hip), foot = toModel(root, feet[side].position);
      const horizontal = Math.hypot(hip[0] - foot[0], hip[2] - foot[2]);
      const vertical = Math.sqrt(Math.max(0, (leg.L1 + leg.L2 - .025) ** 2 - horizontal ** 2));
      drop = Math.max(drop, hip[1] - foot[1] - vertical);
    }
    target.pelvis.offset[1] = -Math.max(0, drop);
    this.stopMode = null; this.beginBridge(this.pose, target, .55, 'idle'); this.done = false;
  }

  pause(value = !this.paused) { this.paused = !!value; return this.paused; }

  /** Explicit laboratory reset, distinct from a conversational stop. Only this
   * operation returns the whole character to the origin and clears its seat. */
  reset() {
    this.anchor = { position: [0, 0, 0], yaw: 0 }; this.root = clone(this.anchor);
    this.pose = this.standing(this.root); this.status = 'idle'; this.paused = false;
    this.activeId = null; this.elapsed = 0; this.duration = 0; this.speed = 1;
    this.loop = false; this.cycle = 0; this.queued = null; this.afterPrerequisite = null;
    this.bridge = null; this.stopMode = null; this.sampleContext = null;
    this.revision++; this.done = true; this.solve(); return true;
  }

  bridgePose(bridge) {
    const { from: a, target: b, elapsed, duration } = bridge;
    const raw = clamp(elapsed / duration), k = smoother(raw), out = clone(a);
    out.root.position = lerp3(a.root.position, b.root.position, k);
    out.root.yaw = a.root.yaw + angleDelta(a.root.yaw, b.root.yaw) * k;
    out.pelvis = { ...numbers(a.pelvis, b.pelvis, k), offset: lerp3(a.pelvis?.offset ?? [0, 0, 0], b.pelvis?.offset ?? [0, 0, 0], k) };
    out.body = numbers(a.body, b.body, k); out.hands = {};
    for (const side of SIDES) {
      const oldHand = { ...POSTURES.relaxed[side], ...a.hands?.[side] }, newHand = { ...POSTURES.relaxed[side], ...b.hands?.[side] };
      out.hands[side] = { ...oldHand, ...numbers(oldHand, newHand, k) };
      for (const key of ['hand', 'pole', 'palm', 'point']) out.hands[side][key] = lerp3(oldHand[key], newHand[key], k);
      const start = a.feet[side], end = b.feet[side];
      const distance = len(sub(start.position, end.position));
      const startRotation = start.rotation ?? rootRotation(a.root), endRotation = end.rotation ?? rootRotation(b.root);
      const rotationDistance = 2 * Math.acos(clamp(Math.abs(startRotation.reduce((n, value, index) => n + value * endRotation[index], 0)), 0, 1));
      const moving = distance > .002 || rotationDistance > .002;
      // Grounded adjustments are sequential steps. Airborne landing recovery
      // instead lowers the released foot directly, with no extra hopping arc.
      const local = clamp(raw * 2 - (side === 'L' ? 0 : 1));
      const lift = start.contact && end.contact && moving ? .35 * Math.sin(Math.PI * local) : 0;
      out.feet[side] = { ...end, position: lerp3(start.position, end.position, smoother(local)),
        rotation: qslerp(startRotation, endRotation, smoother(local)),
        contact: !moving ? !!start.contact && !!end.contact : local <= 0 ? !!start.contact : local >= 1 ? !!end.contact : false };
      out.feet[side].position[1] += lift;
    }
    out.phase = bridge.after === 'playing' ? 'prepare-transition' : 'recover-transition';
    out.support = a.support === 'seated' && b.support === 'seated' ? 'seated' : 'transition';
    out.face = raw > .5 ? b.face : a.face; out.props = raw >= 1 ? b.props : { ...b.props, ...a.props };
    // Interpolating two reachable poses need not remain reachable while a swing
    // foot lowers. Preserve that exact ankle goal by flexing the knees enough
    // at every transition frame, including a running stop's released foot.
    const lower = this.rig.pos(this.rig.support.pelvis);
    const pelvisRotation = qeuler(out.pelvis.pitch ?? 0, out.pelvis.yaw ?? 0, out.pelvis.roll ?? 0);
    let drop = 0;
    for (const side of SIDES) {
      const leg = this.rig.legs[side];
      const hip = add(add(lower, qrotate(pelvisRotation, sub(this.rig.pos(leg.names.hip), lower))), out.pelvis.offset);
      const foot = toModel(out.root, out.feet[side].position);
      const horizontal = Math.hypot(hip[0] - foot[0], hip[2] - foot[2]);
      const available = Math.sqrt(Math.max(0, (leg.L1 + leg.L2 - .001) ** 2 - horizontal ** 2));
      drop = Math.max(drop, hip[1] - foot[1] - available);
    }
    out.pelvis.offset[1] -= Math.max(0, drop);
    out.terminal = false; return out;
  }

  update(now, dt, { paused = false } = {}) {
    this.now = Number.isFinite(now) ? now : this.now;
    if (this.paused || paused) return this.locals;
    dt = clamp(dt, 0, .1);
    if (this.bridge) {
      const bridge = this.bridge; bridge.elapsed = Math.min(bridge.duration, bridge.elapsed + dt);
      this.pose = this.bridgePose(bridge);
      if (bridge.elapsed >= bridge.duration - 1e-10) {
        this.pose = clone(bridge.target); this.bridge = null; this.status = bridge.after;
        if (bridge.after === 'idle') { this.done = true; this.activeId = null; }
      }
    } else if (this.activeId && !this.done) {
      this.elapsed = Math.min(this.duration, this.elapsed + dt * this.speed);
      this.pose = this.sample(this.elapsed);
      const landed = !this.airborne() && this.pose.root.position[1] <= this.anchor.position[1] + .08;
      if (this.stopMode === 'landing' && landed) {
        const queued = this.queued; this.queued = null;
        this.root = clone(this.pose.root);
        if (queued) this.start(queued); else this.recover();
      } else if (this.stopMode === 'seat' && this.pose.support === 'seated') {
        this.holdSeat();
      } else if (this.elapsed >= this.duration - 1e-9 || this.pose.terminal || this.pose.done) {
        if (this.afterPrerequisite) {
          const request = this.afterPrerequisite; this.afterPrerequisite = null;
          this.root = clone(this.pose.root); this.start(request);
        } else if (this.loop && (this.library[this.activeId].initialSupport ?? this.library[this.activeId].startState ?? 'standing') === this.pose.support) {
          const cycle = this.cycle + 1;
          this.root = clone(this.pose.root);
          this.start({ id: this.activeId, options: { loop: true, speed: this.speed, context: this.sampleContext } }); this.cycle = cycle;
        } else { this.done = true; this.status = this.pose.support === 'seated' ? 'seated' : 'ended'; }
      }
    }
    this.root = clone(this.pose.root); this.solve(); return this.locals;
  }

  solve() { this.diagnostics = solveFullBodyPose(this.rig, this.pose, this.locals, this.fk); }

  snapshot() {
    return { activeId: this.activeId, status: this.status, paused: this.paused, done: this.done,
      elapsed: this.elapsed, duration: this.duration, phase: this.pose.phase, support: this.pose.support,
      root: clone(this.root), anchor: clone(this.anchor), pose: clone(this.pose), diagnostics: clone(this.diagnostics),
      contacts: Object.fromEntries(SIDES.map(side => [side, !!this.pose.feet[side].contact])),
      revision: this.revision, cycle: this.cycle, queued: this.queued?.id ?? this.afterPrerequisite?.id ?? null, stopMode: this.stopMode };
  }
}
