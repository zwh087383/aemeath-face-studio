import { ACTIVITY_LIBRARY, sampleActivity } from './activity-library.js';
import { POSTURES } from './motion-profile.js';
import { buildFullBodyRig, solveFullBodyPose, toWorld, toModel, rootRotation } from './full-body-ik.js';
import { add, sub, len, lerp3, qmul, qconj, qslerp, qrotate, qeuler, smoother, clamp } from './motion-math.js';
import { blendTrajectoryChannels, inheritHeldProps, measurePoseVelocity, quinticBoundary, velocityMagnitude, heldPropSides, propAdmissionConflict, activityPropNeed } from './activity-continuity.js';
import { enforceActivityPropContacts, buildHeldPropBridge, applyHeldPropBridge, applyHeldPropTableClearance, propPlacementPreparationSeconds } from './activity-prop-execution.js';
import { ACTIVITY_PROP_LAYOUT, propGripPair } from './activity-prop-layout.js';
import { createActivityContinuation, sampleActivityContinuation, releaseActivityContinuation } from './activity-continuation.js';
import { SupportedConversationOverlay } from './supported-conversation.js';
import { seatAccess, seatEntryStandingRoot } from './activity-seat-access.js';
import { needsActivityRouteCheck, validateActivityRoute } from './activity-route-access.js';

const SIDES = ['L', 'R'];
const ROUTE_PROBE = Symbol('isolated-route-preparation');
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
    this.afterSeatBrake = null;
    this.propTransferReceipts = {}; this.releaseBlendPending = false;
    this.revision = 0; this.done = true; this.now = 0;
    this.velocity = measurePoseVelocity(null, this.pose, 0); this.sceneProps = {};
    this.previousDisplayedPose = null; this.displayedDt = 0;
    this.continuation = null; this.attention = null; this.attentionRate = 1;
    this.attentionOverlay = new SupportedConversationOverlay(); this.displayPose = null;
    this.solve();
  }

  standing(root, feet) {
    return { root: clone(root), pelvis: { offset: [0, 0, 0], pitch: 0, roll: 0 }, body: {},
      hands: clone(POSTURES.relaxed), feet: feet ? clone(feet) : Object.fromEntries(SIDES.map(side => [side, {
        position: toWorld(root, this.context.feet[side]), rotation: rootRotation(root), contact: true }])),
      face: { preset: 'neutral', intensity: .5 }, props: {}, support: 'standing', phase: 'idle', terminal: true };
  }

  /** Read-only start/duration preparation on an isolated controller state.
   * The shared rig/library are immutable descriptions; pose, clocks, transfers,
   * maps and attention ownership are copied. This never advances the live body
   * or creates a prop receipt. totalSeconds includes the actual entry bridge.
   * A range is a hard permission boundary; a scalar reports the nearest longer
   * source-preserving duration if entry plus exit cannot fit the desired time. */
  preparationProbe() {
    const probe = Object.create(FullBodyController.prototype);
    for (const [key, value] of Object.entries(this)) {
      if (['rig', 'library', 'sampler'].includes(key)) probe[key] = value;
      else if (key === 'attentionOverlay') {
        probe[key] = new SupportedConversationOverlay(); probe[key].active = clone(value.active);
      } else probe[key] = clone(value);
    }
    probe[ROUTE_PROBE] = true;
    return probe;
  }

  /** Uses a disposable prepared trajectory; neither this method nor a refusal
   * changes the current displayed owner, prop receipts, clock or furniture. */
  routeAdmission(id, options = {}) {
    if (!needsActivityRouteCheck(this.library[id])) return { accepted: true, reason: 'route_not_required' };
    const probe = this.preparationProbe();
    if (!probe.play(id, options)) return { accepted: false, reason: 'activity_start_refused' };
    if (probe.activeId !== id || probe.queued || probe.afterPrerequisite || probe.afterSeatBrake)
      return { accepted: false, reason: 'activity_requires_explicit_prerequisite' };
    return validateActivityRoute(probe);
  }

  preparePlay(id, { totalSeconds, durationChoice = .5, ...options } = {}, { adopt = null } = {}) {
    const probe = this.preparationProbe();
    const rejected = (reason, detail = {}) => ({ accepted: false, reason, sourceRevision: this.revision, ...detail });
    if (adopt && !probe.adoptSupportedState(adopt)) return rejected('supported_pose_capture_failed');
    const seatAdmission = seatAccess(probe, id);
    if (!seatAdmission.accepted) return rejected(seatAdmission.reason, seatAdmission);
    const baselineOptions = { ...options };
    if (totalSeconds !== undefined) { delete baselineOptions.targetDuration; baselineOptions.hold = false; baselineOptions.speed = 1; }
    let accepted;
    try { accepted = probe.play(id, baselineOptions); } catch (error) { return rejected('activity_prepare_error:' + error.message); }
    if (!accepted) return rejected('activity_start_refused');
    if (probe.activeId !== id || probe.afterPrerequisite || probe.queued || probe.afterSeatBrake)
      return rejected('activity_requires_explicit_prerequisite');
    const route = validateActivityRoute(probe);
    if (!route.accepted) return rejected(route.reason, route);
    if (this.library[id].kind === 'take_prop') {
      const gate = probe.sample(this.library[id].takeRequestAt ?? 1.45);
      if (gate.preparationBlocker) return rejected(gate.preparationBlocker);
      if (gate.propContacts?.ready !== true) return rejected('actual_prop_grip_unreachable', { contact: clone(gate.propContacts) });
    }
    const entrySeconds = probe.bridge?.duration ?? 0, sourceRemainingSeconds = (probe.duration - probe.elapsed) / probe.speed;
    const minimumSeconds = entrySeconds + sourceRemainingSeconds;
    if (totalSeconds === undefined) return { accepted: true, sourceRevision: this.revision, options: clone(options),
      entrySeconds, bodySeconds: probe.duration, elapsedAtStart: probe.elapsed, totalSeconds: minimumSeconds, minimumSeconds };
    const range = Array.isArray(totalSeconds) ? totalSeconds : [totalSeconds, totalSeconds];
    if (range.length !== 2 || range.some(value => !Number.isFinite(value) || value <= 0) || range[0] > range[1]
      || !Number.isFinite(durationChoice)) return rejected('invalid_total_seconds');
    if (!this.library[id]?.continuation) return rejected('activity_has_no_extendable_middle');
    if (Array.isArray(totalSeconds) && range[1] + 1e-9 < minimumSeconds)
      return rejected('unreachable_total_duration', { minimumSeconds, entrySeconds });
    const desired = range[0] + (range[1] - range[0]) * clamp(durationChoice);
    const actual = Math.max(minimumSeconds, desired), targetDuration = actual - entrySeconds + probe.elapsed;
    return { accepted: true, sourceRevision: this.revision,
      options: { ...clone(options), targetDuration, speed: 1, hold: false },
      entrySeconds, bodySeconds: targetDuration, elapsedAtStart: probe.elapsed, minimumSeconds, totalSeconds: actual,
      requested: clone(totalSeconds), exact: Math.abs(actual - desired) < 1e-9, preservesSourceSpeed: true };
  }

  /** Invalid commands do not disturb the current owner. A replacement in flight
   * is queued until the next landing instead of snapping the character down. */
  play(id, { loop = false, speed = 1, context = {}, targetDuration, hold = false, microSet = [] } = {}) {
    if (typeof id !== 'string' || !Object.hasOwn(this.library, id) || !Number.isFinite(speed) || speed <= 0) return false;
    const seatAdmission = seatAccess(this, id);
    if (!seatAdmission.accepted) return false;
    context = { ...context, ...seatAdmission.context };
    if (propAdmissionConflict(this.library[id], this.pose.props)) return false;
    if (this.library[id].kind === 'take_prop' && heldPropSides(this.pose.props?.[this.library[id].propId]).length) return false;
    let continuation;
    try { continuation = createActivityContinuation(this.library[id], { targetDuration, hold, microSet }); } catch { return false; }
    if (!this[ROUTE_PROBE] && needsActivityRouteCheck(this.library[id])) {
      const route = this.routeAdmission(id, { loop, speed, context, targetDuration, hold, microSet });
      if (!route.accepted) return false;
    }
    const request = { id, options: { loop: !!loop && !continuation, speed: continuation ? 1 : clamp(speed, .5, 1.6), context,
      targetDuration, hold: !!hold, microSet: [...microSet] } };
    this.clearAttention(true);
    this.retirePropTransfers(); this.paused = false; this.revision++;
    this.propTransferReceipts = {}; this.releaseBlendPending = false;
    if (this.airborne()) { this.queued = request; this.stopMode = 'landing'; this.status = 'landing'; return true; }
    if (this.pose.support === 'seated' && Math.hypot(...(this.velocity?.root?.position ?? [0, 0, 0])) > .03) {
      this.queued = null; this.afterPrerequisite = null; this.afterSeatBrake = request;
      this.holdSeat(); this.status = 'seat-braking'; return true;
    }
    this.afterSeatBrake = null;
    this.queued = null; this.afterPrerequisite = null; this.start(request); return true;
  }

  /** Explicit scene reset/approach helpers. This only computes a target; it
   * never teleports the current avatar or changes existing furniture. */
  seatEntryStandingRoot() { return seatEntryStandingRoot(this.sceneProps, this.context); }
  seatAccess(id) { return seatAccess(this, id); }

  start({ id, options }) {
    // Internal prerequisite/landing boundaries may enter here before the outer
    // update has solved its new final pose. Refresh those actual frames before
    // re-expressing a held object in the next activity's chest coordinates.
    this.root = clone(this.pose.root); this.solve();
    // A movable chair can leave the original activity frame while the person
    // remains seated. Adopt that attained seat before admitting the next clip.
    this.rebaseSeat();
    const previous = this.heldPoseInChestFrame(this.pose), definition = this.library[id];
    const sceneSetupProps = Object.fromEntries(Object.entries(options.context.sceneSetupProps ?? {}).filter(([propId]) =>
      !heldPropSides(previous.props?.[propId]).length && !this.sceneProps[propId]?.visible));
    const seated = previous.support === 'seated';
    const needsSeat = (definition.initialSupport ?? definition.startState) === 'seated';
    if (needsSeat && !seated && this.library.sit_down && id !== 'sit_down') {
      this.afterPrerequisite = { id, options };
      this.start({ id: 'sit_down', options: { ...options, loop: false, targetDuration: undefined, hold: false, microSet: [] } }); return;
    }
    if (seated && !needsSeat && definition.seatedStartTime === undefined && id !== 'stand_up' && this.library.stand_up) {
      this.afterPrerequisite = { id, options };
      this.start({ id: 'stand_up', options: { ...options, loop: false, targetDuration: undefined, hold: false, microSet: [] } }); return;
    }
    const heldProp = definition.reading ? 'book' : definition.kind === 'drink' ? 'mug' : definition.kind === 'write' ? 'pencil' : definition.kind === 'carry' ? 'box' : null;
    const heldState = heldProp && previous.props?.[heldProp];
    const alreadyHeld = heldState?.visible && ['both', 'left', 'right'].includes(heldState.attachment);
    const takeId = heldProp === 'box' ? 'pickup_box' : heldProp ? `take_${heldProp}_${seated ? 'seated' : 'standing'}` : null;
    if (takeId && !alreadyHeld && this.library[takeId]) {
      this.afterPrerequisite = { id, options };
      this.start({ id: takeId, options: { ...options, loop: false, targetDuration: undefined, hold: false, microSet: [] } }); return;
    }
    const continueSeat = seated && (definition.seatedStartTime !== undefined || needsSeat || id === 'stand_up');
    if (!continueSeat) this.anchor = { position: [...this.root.position], yaw: this.root.yaw };
    const existingChair = this.sceneProps.chair?.worldTransform, existingDesk = this.sceneProps.table?.worldTransform;
    const existingSeat = existingChair ?? existingDesk;
    if (['sit_down', 'sit_down_carefully'].includes(id) && existingSeat?.position && existingSeat?.quaternion) {
      const q = existingSeat.quaternion;
      const yaw = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] ** 2 + q[2] ** 2));
      const placement = existingChair ? ACTIVITY_PROP_LAYOUT.chair.position : ACTIVITY_PROP_LAYOUT.table.position;
      this.anchor = { position: sub(existingSeat.position, qrotate(rootRotation({ yaw }), placement)), yaw };
    }
    this.activeId = id; this.speed = options.speed; this.loop = options.loop; this.cycle = 0;
    this.sampleContext = { ...this.context, ...options.context, sceneSetupProps, initialSupport: previous.support,
      initialPose: clone(previous), initialProps: clone({ ...sceneSetupProps, ...previous.props, ...this.sceneProps }),
      initialHandAnchors: this.handAnchors(), activityAnchor: clone(this.anchor),
      sceneProps: clone({ ...sceneSetupProps, ...this.sceneProps, ...options.context.sceneProps }) };
    this.elapsed = continueSeat ? (definition.seatedStartTime ?? 0) : 0;
    this.continuation = createActivityContinuation(definition, options);
    this.duration = this.continuation?.duration ?? definition.duration + propPlacementPreparationSeconds(definition, this.sampleContext);
    this.done = false; this.stopMode = null; this.status = 'playing'; this.lastRouteRejection = null;
    const target = this.sample(this.elapsed);
    // Before a new activity's clock starts, move from the actual pose to its
    // starting stance. Feet relocate one at a time with lift; planted contacts
    // never slide while the old and new poses are crossfaded.
    const probe = this.sample(Math.min(this.duration, this.elapsed + .001 * this.speed));
    const targetVelocity = measurePoseVelocity(target, probe, .001);
    const travel = len(sub(target.root.position, previous.root.position));
    this.beginBridge(previous, target, Math.max(previous.support !== target.support ? 1.45 : .42, travel > .2 ? .55 + travel / 4 : 0), 'playing', targetVelocity, { targetProbe: probe });
  }

  sample(time) {
    const sample = sampleActivityContinuation(this.continuation, time, sourceTime => this.sampler(this.activeId, sourceTime, this.sampleContext),
      { occupiedHands: Object.values(this.sampleContext?.initialPose?.props ?? {}).flatMap(heldPropSides) });
    const q = rootRotation(this.anchor), localRoot = sample.root ?? { position: [0, 0, 0], yaw: 0 };
    sample.root = { position: toWorld(this.anchor, localRoot.position), yaw: this.anchor.yaw + (localRoot.yaw ?? 0) };
    for (const side of SIDES) {
      const foot = sample.feet[side];
      foot.position = toWorld(this.anchor, foot.position);
      foot.rotation = qmul(q, foot.rotation ?? rootRotation(localRoot));
    }
    sample.anchor = clone(this.anchor);
    sample.props = { ...this.sampleContext?.sceneSetupProps, ...sample.props };
    inheritHeldProps(sample, this.sampleContext?.initialPose, { releaseReceipts: this.propTransferReceipts });
    const hasHeldProp = Object.values(sample.props ?? {}).some(state => heldPropSides(state).length);
    sample.variant = hasHeldProp ? this.library[this.activeId]?.heldVariant ?? (activityPropNeed(this.library[this.activeId]) ? 'authored-object-action' : 'held-variant-not-declared') : 'authored';
    for (const [id, state] of Object.entries(sample.props ?? {})) if (state?.transfer) {
      state.transfer.id = `${this.revision}:${this.activeId}:${id}:${state.transfer.operation}`;
    }
    const explicitTransfer = ['take_prop', 'put_prop'].includes(this.library[this.activeId]?.kind);
    sample.propClearance = explicitTransfer ? { ready: true, corrections: [], reason: 'explicit-contact-trajectory' }
      : applyHeldPropTableClearance(this.rig, sample, this.sceneProps.table ?? this.sampleContext?.sceneProps?.table);
    sample.propContacts = enforceActivityPropContacts(this.rig, sample);
    return sample;
  }

  beginBridge(from, target, duration, after, velocityTarget = null, { targetProbe = null } = {}) {
    // Old props retain their actual scene transform when the next activity has
    // adopted a new anchor. Newly staged props already belong to that new one.
    from = clone(from);
    for (const [id, state] of Object.entries(from.props ?? {})) {
      const actual = this.sceneProps[id];
      if (actual?.worldTransform && (state === true || state?.visible) && !['both', 'left', 'right'].includes(state?.attachment)) {
        from.props[id] = { ...(state === true ? { visible: true } : state), worldTransform: clone(actual.worldTransform) };
      }
    }
    const moveSeat = after === 'seated' && from.support === 'seated' && target.support === 'seated';
    if (moveSeat) {
      this.attachSeatToBridge(target, from);
      if (Array.isArray(target.props?.chair?.position)) target.seatOffset = add(target.props.chair.position, [0, 0, 1.2]);
    }
    const explicitTransfer = ['take_prop', 'put_prop'].includes(this.library[this.activeId]?.kind);
    const sourceClearance = explicitTransfer ? { corrections: [] } : applyHeldPropTableClearance(this.rig, clone(from), this.sceneProps.table);
    const useBridgeClearance = !explicitTransfer && !sourceClearance.corrections?.some(correction => correction.lift > 1e-5);
    this.bridge = { from: clone(from), target: clone(target), elapsed: 0, duration, after,
      useBridgeClearance,
      velocityFrom: clone(this.velocity), velocityTarget: velocityTarget ?? measurePoseVelocity(null, target, 0),
      velocityFeet: clone(this.velocityFeet ?? {}), moveSeat,
      propFrames: buildHeldPropBridge(from, target, { previousFrom: this.previousDisplayedPose, fromDt: this.displayedDt,
        targetProbe, targetDt: .001, duration }) };
    this.status = after === 'playing' ? 'preparing' : 'recovering';
  }

  airborne() { return this.pose.support === 'airborne' || (this.activeId && SIDES.every(side => !this.pose.feet[side].contact)); }

  stop() {
    this.clearAttention(true);
    this.releaseHold();
    this.retirePropTransfers();
    this.queued = null; this.afterPrerequisite = null; this.afterSeatBrake = null; this.paused = false; this.loop = false; this.revision++;
    this.propTransferReceipts = {}; this.releaseBlendPending = false;
    if (['stand_up', 'stand_up_from_desk'].includes(this.library[this.activeId]?.kind) && /(^|_)rise$/.test(this.pose.phase ?? '')) {
      this.stopMode = 'rise'; this.status = 'rising'; return;
    }
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
    // A moving hand/head must decelerate from the displayed velocity. Keep the
    // attained seat and object ownership while that bounded settling runs.
    if (velocityMagnitude(this.velocity) > 1e-5) {
      const target = clone(this.pose);
      const rootVelocity = this.velocity?.root?.position ?? [0, 0, 0];
      for (const i of [0, 2]) target.root.position[i] += rootVelocity[i] * .38 * .4;
      target.seatOffset = toModel(this.anchor, target.root.position);
      for (const side of SIDES) if (!target.feet[side].contact) {
        target.feet[side].position[1] = this.anchor.position[1] + this.context.feet[side][1];
        target.feet[side].contact = true;
      }
      this.beginBridge(this.pose, target, .38, 'seated');
      this.status = 'seated'; this.done = false;
    }
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
    const previous = this.heldPoseInChestFrame(this.pose), target = this.standing(root, feet);
    inheritHeldProps(target, previous); target.props = { ...clone(previous.props ?? {}), ...target.props };
    // Retaining the prop value alone is insufficient: keep its current hand
    // ownership so a conversational stop cannot drop a book to relaxed hands.
    for (const [id, prop] of Object.entries(this.pose.props ?? {})) if (prop && typeof prop === 'object'
      && prop.visible !== false && ['both', 'left', 'right'].includes(prop.attachment)) {
      for (const side of prop.attachment === 'both' ? SIDES : [prop.attachment === 'left' ? 'L' : 'R']) target.hands[side] = clone(this.pose.hands[side]);
    }
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
    target.propContacts = enforceActivityPropContacts(this.rig, target);
    this.stopMode = null; this.beginBridge(this.pose, target, .55, 'idle'); this.done = false;
  }

  pause(value = !this.paused) { this.paused = !!value; return this.paused; }

  releaseHold() {
    if (!releaseActivityContinuation(this.continuation, this.elapsed)) return false;
    // Finishing the task is an explicit new command. A stopped activity clock
    // must not prevent its already-authorized safe exit from completing.
    if (this.attention) {
      this.attention.paused = false; this.attentionOverlay.cancel(this.attention.id); this.status = 'finishing';
    }
    this.duration = this.continuation.duration; return true;
  }

  /** Pause only a supported, event-free working middle. Its clock and object
   * ownership remain alive until an explicit matching resume or cancellation. */
  pauseForAttention({ id, kind = 'listen', strength = .7 } = {}) {
    if (!id || this.done || this.bridge || !this.activeId || !['standing', 'seated'].includes(this.pose.support)) return false;
    const window = this.library[this.activeId]?.continuation;
    const tailStart = this.duration - (this.library[this.activeId].duration - (window?.end ?? 0));
    if (!window || this.elapsed < window.start || this.elapsed + this.attentionRate * .11 >= tailStart) return false;
    if (this.attention) return this.attention.id === id && this.attention.paused;
    if (!this.attentionOverlay.begin({ id, kind, strength, hold: true })) return false;
    this.attention = { id, revision: this.revision, paused: true, activeId: this.activeId };
    this.status = 'attention-pausing'; return true;
  }

  resumeFromAttention(id) {
    const a = this.attention;
    if (!a || a.id !== id || a.revision !== this.revision || a.activeId !== this.activeId || !a.paused || this.done) return false;
    a.paused = false; this.attentionOverlay.cancel(id); this.status = 'attention-resuming'; return true;
  }

  clearAttention(adoptDisplayed = false) {
    if (adoptDisplayed && this.attention && this.displayPose) this.pose = clone(this.displayPose);
    this.attention = null; this.attentionRate = 1; this.attentionOverlay?.clear(); this.displayPose = null;
  }

  /** A scene handoff supplies measured canonical coordinates. A support label
   * alone never manufactures a chair or resets a native pose to standing. */
  adoptSupportedState({ pose, sceneProps = {} } = {}) {
    if (!pose || !['standing', 'seated'].includes(pose.support) || !Array.isArray(pose.root?.position)
      || pose.root.position.length !== 3 || !pose.root.position.every(Number.isFinite) || !Number.isFinite(pose.root.yaw)
      || SIDES.some(side => !Array.isArray(pose.feet?.[side]?.position) || pose.feet[side].position.length !== 3 || !pose.feet[side].position.every(Number.isFinite))
      || pose.support === 'standing' && !SIDES.some(side => pose.feet[side].contact)
      || pose.support === 'seated' && !(sceneProps.chair?.visible || pose.props?.chair)) return false;
    if (!Array.isArray(pose.pelvis?.offset) || pose.pelvis.offset.length !== 3 || !pose.pelvis.offset.every(Number.isFinite)
      || SIDES.some(side => !Array.isArray(pose.hands?.[side]?.hand) || pose.hands[side].hand.length !== 3 || !pose.hands[side].hand.every(Number.isFinite))) return false;
    const candidate = clone(pose); let contact, check;
    try { contact = enforceActivityPropContacts(this.rig, candidate); check = solveFullBodyPose(this.rig, candidate, new Map(), new Map()); } catch { return false; }
    if (!contact.ready || !check.finite || Object.values(check.legs).some(leg => leg.error > .08)) return false;
    this.clearAttention(); this.pose = candidate; this.root = clone(candidate.root); this.anchor = clone(candidate.anchor ?? candidate.root);
    this.sceneProps = clone(sceneProps); this.activeId = null; this.elapsed = this.duration = 0; this.continuation = null;
    this.queued = this.afterPrerequisite = this.afterSeatBrake = this.bridge = this.stopMode = null;
    this.propTransferReceipts = {}; this.releaseBlendPending = false; this.loop = false; this.paused = false;
    this.done = true; this.status = candidate.support === 'seated' ? 'seated' : 'idle'; this.revision++;
    this.velocity = measurePoseVelocity(null, candidate, 0); this.velocityFeet = {}; this.previousDisplayedPose = null; this.displayedDt = 0;
    this.solve(); return true;
  }

  /** Explicit laboratory reset, distinct from a conversational stop. Only this
   * operation returns the whole character to the origin and clears its seat. */
  reset() {
    this.clearAttention(); this.continuation = null;
    this.anchor = { position: [0, 0, 0], yaw: 0 }; this.root = clone(this.anchor);
    this.pose = this.standing(this.root); this.status = 'idle'; this.paused = false;
    this.activeId = null; this.elapsed = 0; this.duration = 0; this.speed = 1;
    this.loop = false; this.cycle = 0; this.queued = null; this.afterPrerequisite = null;
    this.afterSeatBrake = null;
    this.propTransferReceipts = {}; this.releaseBlendPending = false;
    this.bridge = null; this.stopMode = null; this.sampleContext = null;
    this.velocity = measurePoseVelocity(null, this.pose, 0); this.sceneProps = {};
    this.velocityFeet = {};
    this.previousDisplayedPose = null; this.displayedDt = 0;
    this.revision++; this.done = true; this.solve(); return true;
  }

  bridgePose(bridge) {
    const { from: a, target: b, elapsed, duration } = bridge;
    const raw = clamp(elapsed / duration), k = smoother(raw), out = clone(a);
    out.anchor = clone(b.anchor ?? this.anchor);
    Object.assign(out, blendTrajectoryChannels(a, b, bridge.velocityFrom, bridge.velocityTarget, elapsed, duration));
    for (const side of SIDES) {
      const oldHand = { ...POSTURES.relaxed[side], ...a.hands?.[side] }, newHand = { ...POSTURES.relaxed[side], ...b.hands?.[side] };
      out.hands[side] = { ...oldHand, ...out.hands[side] };
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
      if (!start.contact && moving) {
        const previousFoot = bridge.velocityFeet?.[side] ?? [0, 0, 0];
        out.feet[side].position = start.position.map((value, i) => quinticBoundary(value, end.position[i], previousFoot[i], 0, elapsed, duration));
        out.feet[side].contact = raw >= 1 && !!end.contact;
      }
    }
    out.phase = bridge.after === 'playing' ? 'prepare-transition' : 'recover-transition';
    out.support = a.support === 'seated' && b.support === 'seated' ? 'seated' : 'transition';
    out.face = raw > .5 ? b.face : a.face; out.props = raw >= 1 ? b.props : { ...b.props, ...a.props };
    // The bridge already carries the corrected displayed wrist trajectories.
    // Applying a final-frame grip constraint here would teleport those hands.
    delete out.propContactPlans;
    for (const [id, state] of Object.entries(out.props ?? {})) if (state && typeof state === 'object') {
      const targetState = b.props?.[id];
      if (state.orientationQuaternion && targetState?.orientationQuaternion) state.orientationQuaternion = qslerp(state.orientationQuaternion, targetState.orientationQuaternion, k);
    }
    if (out.support === 'seated' && bridge.moveSeat) {
      this.attachSeatToBridge(out, a);
      if (Array.isArray(out.props?.chair?.position)) out.seatOffset = add(out.props.chair.position, [0, 0, 1.2]);
    }
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
    out.propContacts = applyHeldPropBridge(this.rig, out, bridge.propFrames, elapsed, duration);
    out.propClearance = bridge.useBridgeClearance ? applyHeldPropTableClearance(this.rig, out, this.sceneProps.table)
      : { ready: true, corrections: [], reason: 'continuous-source-contact-or-explicit-transfer' };
    if (out.propClearance.props) out.propContacts = out.propClearance;
    out.terminal = false; return out;
  }

  update(now, dt, { paused = false } = {}) {
    if (this.paused || paused) return this.locals;
    this.now = Number.isFinite(now) ? now : this.now;
    dt = clamp(dt, 0, .1);
    const displayedBefore = clone(this.displayPose ?? this.pose);
    const targetRate = this.attention?.paused ? 0 : 1, rateDecay = Math.exp(-dt / .11);
    const activityDt = targetRate * dt + (this.attentionRate - targetRate) * .11 * (1 - rateDecay);
    this.attentionRate = targetRate + (this.attentionRate - targetRate) * rateDecay;
    if (this.releaseBlendPending && !this.bridge && this.activeId) {
      this.releaseBlendPending = false;
      const target = this.sample(this.elapsed);
      this.beginBridge(this.pose, target, .5, 'playing');
    }
    if (this.bridge) {
      const bridge = this.bridge, remainder = Math.max(0, bridge.elapsed + dt - bridge.duration);
      bridge.elapsed = Math.min(bridge.duration, bridge.elapsed + dt);
      this.pose = this.bridgePose(bridge);
      if (bridge.elapsed >= bridge.duration - 1e-10) {
        this.pose = clone(bridge.target); this.bridge = null; this.status = bridge.after;
        this.velocity = clone(bridge.velocityTarget); this.velocityFeet = {};
        if (bridge.after === 'idle') { this.done = true; this.activeId = null; }
        if (bridge.after === 'seated') {
          this.done = true;
          if (this.afterSeatBrake) {
            const request = this.afterSeatBrake; this.afterSeatBrake = null; this.start(request);
          }
        }
        // Preserve the application's clock when a bridge duration falls
        // between display frames. Discarding this remainder produces a single
        // slow frame precisely at a nonzero-velocity trajectory boundary.
        if (bridge.after === 'playing' && remainder > 1e-10 && this.activeId && !this.done && !this.bridge) {
          this.elapsed = Math.min(this.duration, this.elapsed + remainder * this.speed * this.attentionRate);
          this.pose = this.sample(this.elapsed);
        }
        if (this.bridge && remainder > 1e-10) {
          this.bridge.elapsed = Math.min(this.bridge.duration, remainder);
          this.pose = this.bridgePose(this.bridge);
        }
      }
    } else if (this.activeId && !this.done) {
      const previousElapsed = this.elapsed, requestedElapsed = this.elapsed + activityDt * this.speed;
      const remainder = Math.max(0, (requestedElapsed - this.duration) / this.speed);
      this.elapsed = Math.min(this.duration, requestedElapsed);
      const activeDefinition = this.library[this.activeId], operation = this.transferOperation(activeDefinition);
      if (operation === 'take' && !this.propTransferReceipts[activeDefinition.propId]?.released) {
        this.elapsed = Math.min(this.elapsed, activeDefinition.takeRequestAt ?? 1.45);
      }
      this.pose = this.sample(this.elapsed);
      const landed = !this.airborne() && this.pose.root.position[1] <= this.anchor.position[1] + .08;
      if (this.stopMode === 'landing' && landed) {
        const queued = this.queued; this.queued = null;
        this.root = clone(this.pose.root);
        if (queued) this.start(queued); else this.recover();
      } else if (this.stopMode === 'seat' && this.pose.support === 'seated') {
        this.holdSeat();
      } else if (this.stopMode === 'rise' && /(^|_)standing$/.test(this.pose.phase ?? '')) {
        this.stopMode = null; this.recover();
      } else if (operation && !this.propTransferReceipts[activeDefinition.propId]?.released
        && (this.elapsed >= this.duration - 1e-9 || operation === 'take' && this.elapsed >= (activeDefinition.takeRequestAt ?? 1.45) - 1e-9)) {
        this.status = this.pose.preparationBlocker ? `${operation}-blocked` : operation === 'place' ? 'awaiting-prop-release' : 'awaiting-prop-grasp';
      } else if (this.elapsed >= this.duration - 1e-9 || this.pose.terminal || this.pose.done) {
        if (this.afterPrerequisite) {
          const request = this.afterPrerequisite; this.afterPrerequisite = null;
          this.velocity = measurePoseVelocity(displayedBefore, this.pose, Math.max(1e-8, (this.duration - previousElapsed) / this.speed));
          this.root = clone(this.pose.root); this.start(request);
          if (this.bridge && remainder > 1e-10) { this.bridge.elapsed = Math.min(this.bridge.duration, remainder); this.pose = this.bridgePose(this.bridge); }
        } else if (this.loop && (this.library[this.activeId].initialSupport ?? this.library[this.activeId].startState ?? 'standing') === this.pose.support) {
          const cycle = this.cycle + 1;
          this.velocity = measurePoseVelocity(displayedBefore, this.pose, Math.max(1e-8, (this.duration - previousElapsed) / this.speed));
          this.root = clone(this.pose.root);
          const options = { loop: true, speed: this.speed, context: this.sampleContext };
          const route = this.routeAdmission(this.activeId, options);
          if (!route.accepted) {
            this.loop = false; this.done = true; this.status = 'route-blocked'; this.lastRouteRejection = route;
          } else {
            this.start({ id: this.activeId, options }); this.cycle = cycle;
            if (this.bridge && remainder > 1e-10) { this.bridge.elapsed = Math.min(this.bridge.duration, remainder); this.pose = this.bridgePose(this.bridge); }
          }
        } else { this.done = true; this.status = this.pose.support === 'seated' ? 'seated' : 'ended'; }
      }
    }
    this.root = clone(this.pose.root); this.solve(dt);
    if (this.attention?.paused && this.attentionRate < .001) this.status = 'attention-paused';
    else if (this.attention && !this.attention.paused && !this.attentionOverlay.active && this.attentionRate > .999) {
      this.attention = null; this.attentionRate = 1; this.status = this.done ? this.status : 'playing';
    }
    this.previousDisplayedPose = displayedBefore; this.displayedDt = dt;
    this.velocity = measurePoseVelocity(displayedBefore, this.displayPose ?? this.pose, dt);
    this.velocityFeet = Object.fromEntries(SIDES.map(side => [side, this.pose.feet[side].position.map((value, i) => dt > 0 ? (value - displayedBefore.feet[side].position[i]) / dt : 0)]));
    for (const [id, prop] of Object.entries(this.pose.props ?? {})) {
      if (prop === false || prop?.visible === false) delete this.sceneProps[id];
      else if (prop === true || ['floor', 'table'].includes(prop?.attachment) || (!prop?.attachment && prop?.visible)) this.sceneProps[id] = clone(prop);
    }
    return this.locals;
  }

  handAnchors() {
    const result = {}, rootQ = rootRotation(this.root);
    for (const [side, key] of [['L', 'left'], ['R', 'right']]) {
      const names = this.rig.sides[side].names, wrist = this.fk.get(names.wrist);
      const middle = this.fk.get(names.fingers.middle[0]);
      if (!wrist) continue;
      const palm = middle ? wrist.position.map((value, i) => value + .45 * (middle.position[i] - value)) : wrist.position;
      result[key] = { position: toWorld(this.root, palm), quaternion: qmul(rootQ, wrist.rotation), measured: !!middle };
      result[side] = clone(result[key]); result[`${key}Hand`] = clone(result[key]);
    }
    return result;
  }

  heldPoseInChestFrame(pose) {
    const previous = clone(pose), chest = this.fk.get(this.rig.torso.upperChest.name);
    if (!chest) return previous;
    for (const [id, state] of Object.entries(previous.props ?? {})) {
      if (!state || !['both', 'left', 'right'].includes(state.attachment) || !state.worldTransform) continue;
      const frame = state.worldTransform, localPoint = toModel(pose.root, frame.position);
      const position = add(this.rig.torso.upperChest.rest, qrotate(qconj(chest.rotation), sub(localPoint, chest.position)));
      const quaternion = qmul(qconj(chest.rotation), qmul(qconj(rootRotation(pose.root)), frame.quaternion));
      previous.propContactPlans ??= {};
      previous.propContactPlans[id] = { frame: { position, quaternion, space: 'chest' }, openness: state.openness,
        attachment: state.attachment, hands: state.attachment === 'both' ? SIDES : [state.attachment === 'left' ? 'L' : 'R'],
        ...(state.grip ? { grip: clone(state.grip) } : {}) };
    }
    return previous;
  }

  setPropTransferReceipts(snapshot) {
    if (!this.activeId || !this.sampleContext) return 0;
    let accepted = 0;
    for (const [id, report] of Object.entries(snapshot?.props ?? {})) {
      const definition = this.library[this.activeId], operation = this.transferOperation(definition);
      const receipt = report?.transfer, expected = `${this.revision}:${this.activeId}:${id}:${operation}`;
      if (!receipt?.released || !operation || receipt.operation !== operation || receipt.owner !== expected
        || definition?.propId !== id
        || this.pose.props?.[id]?.transfer?.id !== expected || !(operation === 'place' ? this.pose.props[id].transfer.requestRelease : this.pose.props[id].transfer.requestTake)
        || !receipt.transform?.position?.every(Number.isFinite) || receipt.transform.position.length !== 3
        || !receipt.transform?.quaternion?.every(Number.isFinite) || receipt.transform.quaternion.length !== 4
        || this.propTransferReceipts[id]?.released) continue;
      this.propTransferReceipts[id] = { ...clone(receipt), activityElapsed: this.elapsed }; accepted++;
      if (operation === 'take') this.adoptTakenProp(id, receipt);
      else if (operation === 'place') this.adoptPlacedProp(id, receipt);
    }
    if (accepted) {
      this.sampleContext.propTransferReceipts = clone(this.propTransferReceipts);
      this.releaseBlendPending = this.transferOperation(this.library[this.activeId]) === 'place';
    }
    return accepted;
  }

  retirePropTransfers() {
    for (const [id, state] of Object.entries(this.pose?.props ?? {})) {
      if (!state || typeof state !== 'object' || !state.transfer) continue;
      const receipt = this.propTransferReceipts?.[id];
      if (receipt?.released && receipt.operation === 'place') {
        this.adoptPlacedProp(id, receipt);
      }
      if (receipt?.released && receipt.operation === 'take') this.adoptTakenProp(id, receipt);
      delete state.transfer;
    }
  }

  adoptTakenProp(id, receipt) {
    const state = this.pose.props?.[id];
    if (!state || typeof state !== 'object') return;
    // The displayed scene and body must agree in the acceptance frame. Leaving
    // a stale table entry here can override the held source of an immediate
    // put/play request before the next rendered-prop feedback has arrived.
    delete this.sceneProps[id];
    // Acceptance is an atomic ownership change even if a stop/new request
    // arrives before the following sampler frame. The source pose is unchanged.
    if (!['both', 'left', 'right'].includes(state.attachment)) {
      state.attachment = receipt.attachment;
      state.worldTransform = clone(receipt.transform);
      const plan = this.pose.propContactPlans?.[id];
      if (plan) {
        plan.frame = { ...clone(receipt.transform), space: 'world' }; plan.attachment = receipt.attachment;
        plan.hands = receipt.attachment === 'both' ? SIDES : [receipt.attachment === 'left' ? 'L' : 'R'];
        delete plan.approachFrom; delete plan.approachProgress;
      }
    }
  }

  adoptPlacedProp(id, receipt) {
    const state = this.pose.props?.[id];
    if (!state || typeof state !== 'object') return;
    state.attachment = 'table'; state.worldTransform = clone(receipt.transform);
    if (this.pose.propContactPlans) delete this.pose.propContactPlans[id];
    this.sceneProps[id] = { visible: true, attachment: 'table', worldTransform: clone(receipt.transform), openness: state.openness };
  }

  transferOperation(definition) {
    return definition?.kind === 'put_prop' ? 'place' : definition?.kind === 'take_prop' || definition?.kind === 'pickup' && definition?.propId ? 'take' : null;
  }

  setRenderedPropsSnapshot(snapshot) {
    for (const [id, report] of Object.entries(snapshot?.props ?? {})) {
      if (!report?.visible) { delete this.sceneProps[id]; continue; }
      const worldTransform = { position: clone(report.position), quaternion: clone(report.quaternion) };
      if (['floor', 'table'].includes(report.attachment)) {
        this.sceneProps[id] = { visible: true, attachment: report.attachment, worldTransform,
          ...(Number.isFinite(report.openness) ? { openness: report.openness } : {}) };
      } else if (this.pose.props?.[id]?.attachment === report.attachment) {
        delete this.sceneProps[id];
        this.pose.props[id].worldTransform = worldTransform;
      }
    }
  }

  attachSeatToBridge(pose, previous) {
    const chair = previous.props?.chair;
    if (!chair || chair?.visible === false) return;
    const frame = previous.anchor ?? this.anchor;
    const chairPosition = typeof chair === 'object' && Array.isArray(chair.position) ? chair.position : [0, 0, -1.2];
    const world = toWorld(frame, chairPosition);
    const seatPoint = p => toWorld(p.root, add(p.pelvis?.offset ?? [0, 0, 0], [0, this.context.pelvisHeight, 0]));
    const fromSeat = seatPoint(previous), nextSeat = seatPoint(pose);
    for (const i of [0, 2]) world[i] += nextSeat[i] - fromSeat[i];
    pose.props ??= {};
    pose.props.chair = { ...(typeof chair === 'object' ? clone(chair) : {}), visible: true,
      position: toModel(pose.anchor ?? this.anchor, world) };
    delete pose.props.chair.worldTransform;
  }

  solve(dt = 0) {
    const overlay = this.attentionOverlay?.active ? this.attentionOverlay.update(dt, this.pose, { rig: this.rig }) : null;
    this.displayPose = overlay?.pose ?? null;
    const displayed = this.displayPose ?? this.pose;
    this.diagnostics = solveFullBodyPose(this.rig, displayed, this.locals, this.fk);
    this.diagnostics.propContacts = clone(overlay?.contact ?? displayed.propContacts ?? { ready: true, props: {} });
    if (overlay) this.diagnostics.attention = { accepted: overlay.accepted, reason: overlay.reason };
    const anchors = this.handAnchors();
    for (const [id, state] of Object.entries(this.pose.props ?? {})) {
      if (!state || !['both', 'left', 'right'].includes(state.attachment) || !ACTIVITY_PROP_LAYOUT[id]) continue;
      const rotation = state.orientationQuaternion;
      if (!Array.isArray(rotation) || rotation.length !== 4) continue;
      const pair = propGripPair(id, state.openness), left = anchors.L, right = anchors.R;
      const sides = state.attachment === 'both' ? [['L', pair?.left], ['R', pair?.right]]
        : [[state.attachment === 'left' ? 'L' : 'R', state.grip ?? ACTIVITY_PROP_LAYOUT[id].grip]];
      const positions = sides.filter(([side, grip]) => anchors[side] && grip)
        .map(([side, grip]) => sub(anchors[side].position, qrotate(rotation, grip)));
      if (positions.length) state.worldTransform = { position: positions[0].map((value, i) => positions.reduce((n, p) => n + p[i], 0) / positions.length), quaternion: clone(rotation) };
    }
  }

  snapshot() {
    return { activeId: this.activeId, status: this.status, paused: this.paused, done: this.done,
      elapsed: this.elapsed, duration: Number.isFinite(this.duration) ? this.duration : null, phase: this.pose.phase, support: this.pose.support, variant: this.pose.variant ?? 'authored',
      root: clone(this.root), anchor: clone(this.anchor), pose: clone(this.displayPose ?? this.pose), diagnostics: clone(this.diagnostics),
      continuation: this.continuation ? { ...clone(this.continuation), duration: Number.isFinite(this.duration) ? this.duration : null } : null,
      attention: this.attention ? { ...clone(this.attention), rate: this.attentionRate } : null,
      contacts: Object.fromEntries(SIDES.map(side => [side, !!this.pose.feet[side].contact])),
      revision: this.revision, cycle: this.cycle, lastRouteRejection: clone(this.lastRouteRejection ?? null),
      queued: this.queued?.id ?? this.afterPrerequisite?.id ?? this.afterSeatBrake?.id ?? null, stopMode: this.stopMode };
  }
}
