import { GESTURES } from '../../preview/core/motion-profile.js';
import { CHARACTER_ACTIONS, READING_ACTIONS } from './catalog.mjs';
import { FACE_PROFILES } from './face-profiles.mjs';

// These are deliberately small experimental aesthetic mappings, not recovered
// game formulas. Shapes come from ContinuousFaceController's reviewed recipes;
// the older expression keys supply only the executed gesture's timing envelope.
export const ACTION_FACE_KINDS = Object.freeze({
  wave: 'warm', warm_welcome: 'warm', celebration_compact: 'excited', comfort: 'concern',
  compare_options: 'serious', think: 'serious', curious: 'curious',
});
export const READING_FACE_KINDS = Object.freeze({
  attentive: 'attention', considering: 'serious', serene: 'attention', relieved: 'warm',
});
// Reviewed meaning of the authored gestures, not their legacy smile tail or a
// filename-based emotion guess. Legacy callers retain the small pilot mapping;
// the centre's actual scene snapshot enables the complete library below.
export const LIBRARY_GESTURE_FACE_KINDS = Object.freeze({
  explain: 'serious', wave: 'warm', shrug: 'confused', chest: 'warm', beat: 'attention',
  bow_smile: 'warm', laugh: 'excited', curious: 'curious', shy: 'playful',
  explain_firm: 'serious', surprise: 'surprise', think: 'serious', greet: 'warm',
  listen: 'attention', comfort: 'concern', look_up: 'attention', agree: 'warm',
  micro_ack: 'attention', double_ack: 'attention', attentive_tilt: 'curious', refocus: 'attention',
  thinking_glance: 'serious', recall_up: 'curious', doubtful_tilt: 'confused',
  breath_settle: 'attention', weight_settle: 'attention', finger_release: 'attention', listening_pause: 'attention',
  small_no: 'serious', offer_turn: 'warm', invite_continue: 'warm', clarify: 'serious',
  compare_options: 'serious', enumerate_two: 'serious', outline_space: 'serious', emphasize_down: 'serious',
  gently_decline: 'concern', reassure: 'concern', ask_check: 'curious', present_left: 'warm', present_right: 'warm',
  relieved: 'warm', proud_soft: 'playful', disappointed: 'sad', embarrassed: 'playful', skeptical: 'confused',
  delighted: 'excited', concerned: 'concern', determined: 'serious', grateful: 'warm', amused: 'playful',
  warm_welcome: 'warm', explain_sequence: 'serious', celebration_compact: 'excited',
  storytelling_arc: 'curious', reset_and_resolve: 'serious', farewell_linger: 'warm',
});
export const ACTIVITY_FACE_KINDS = Object.freeze({
  ...READING_FACE_KINDS, neutral: 'attention', determined: 'serious',
  acknowledge_soft: 'warm', understanding: 'warm',
});
const readings = new Set(READING_ACTIONS.map(id => `activity:${id}`));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const unit = value => Math.min(1, Math.max(0, finite(value) ? value : 0));
const smooth = value => { const t = unit(value); return t * t * t * (t * (t * 6 - 15) + 10); };
const magnitude = values => Math.max(0, ...Object.values(values ?? {}).filter(finite).map(Math.abs));

/** No legacy morph leaves escape this function. Its sole output is a scalar
 * envelope at the ACTUAL warped gesture age supplied by MotionController. */
export function gestureFacePhase(gesture, age) {
  const definition = GESTURES[gesture], keys = definition?.expression?.keys;
  if (!keys?.length || !finite(age) || age < 0 || age > definition.duration) return null;
  const peak = Math.max(0, ...keys.map(([, values]) => magnitude(values)));
  if (!(peak > 0)) return null;
  let index = 0;
  while (index < keys.length - 2 && age > keys[index + 1][0]) index++;
  const [ta, a] = keys[index], [tb, b] = keys[Math.min(index + 1, keys.length - 1)];
  const amount = tb > ta ? smooth((age - ta) / (tb - ta)) : 1;
  let value = 0;
  for (const channel of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const start = a[channel] ?? 0, end = b[channel] ?? 0;
    if (finite(start) && finite(end)) value = Math.max(value, Math.abs(start * (1 - amount) + end * amount));
  }
  return unit(value / peak);
}

const association = value => value && Object.hasOwn(FACE_PROFILES, value.kind)
  && finite(value.strength) && value.strength >= 0 && value.strength <= 1 ? value : null;
const boundedEnvelope = (age, duration) => {
  if (!finite(age) || !finite(duration) || duration <= 0 || age < 0 || age > duration) return null;
  const edge = Math.min(.3, duration * .2);
  return smooth(age / edge) * smooth((duration - age) / edge);
};

/** Describe only what this executor actually sampled. This is diagnostic
 * association metadata, never an acknowledgement that a background task ended.
 * A native return/stop is not a new source clip and carries no old expression. */
export function describeExecutedFace(active, snapshot, { gestures = [], activityFace = null,
  definitions = CHARACTER_ACTIONS } = {}) {
  if (!active || !['admitted', 'playing'].includes(active.status)) return { reason: 'no_active_body' };
  if (!finite(active.displayedAt)) return { reason: 'body_not_displayed' };
  const definition = definitions[active.action];
  if (!definition) return { reason: 'unregistered_body' };
  if (!snapshot || snapshot.body?.active?.id && snapshot.body.active.id !== active.id)
    return { reason: 'snapshot_body_mismatch' };
  const executor = snapshot.executor;
  const supportVariant = active.selectedVariant === 'support-preserving'
    && active.performance?.variant_set?.includes('support-preserving')
    && definition.variants?.['support-preserving']?.executor === 'activity-overlay';
  if ((supportVariant ? 'supported' : definition.executor) !== executor) return { reason: 'snapshot_executor_mismatch' };
  const explicit = association(definition.faceAssociation);
  if (executor === 'supported') {
    const state = snapshot.supported;
    const kind = supportVariant ? definition.variants['support-preserving'].kind : definition.name;
    if (!state || state.id !== active.id || state.kind !== kind || state.cancelElapsed !== null
      || !finite(state.elapsed) || state.elapsed < 0 || !finite(state.duration) || state.elapsed > state.duration)
      return { reason: 'supported_not_active' };
    if (!finite(state.weight) || !finite(state.strength)) return { reason: 'supported_face_unverified' };
    return { kind: explicit?.kind ?? 'attention', strength: (explicit?.strength ?? .15) * unit(state.strength),
      phase: unit(state.weight), timing: 'executed-supported-gesture', executedPhase: 'single', sampleTime: state.elapsed };
  }
  if (executor === 'conversation' && active.action.startsWith('gesture:')) {
    const name = active.action.slice(8), gesture = gestures.find(row => row.id === active.id && row.gesture === name);
    if (!gesture || gesture.recovering || ['retract', 'recovery'].includes(gesture.phase)) return { reason: 'gesture_not_active' };
    const kind = explicit?.kind ?? LIBRARY_GESTURE_FACE_KINDS[name];
    if (!kind) return { reason: 'unmapped_gesture' };
    // Old expression tracks contribute timing only; their leaf values never
    // bypass the final compositor. A gesture with no face track stays neutral.
    const phase = gestureFacePhase(name, gesture.age) ?? (kind === 'attention'
      ? boundedEnvelope(gesture.age, GESTURES[name]?.duration) : null);
    if (phase === null) return { reason: 'missing_authored_face_timing' };
    return { kind, strength: unit(gesture.expressionWeight ?? gesture.strength) * (explicit?.strength ?? 1),
      phase, timing: 'executed-gesture-expression-envelope', executedPhase: gesture.phase, sampleTime: gesture.age };
  }
  if (executor === 'conversation' && definition.channel === 'head') {
    const cue = snapshot.actionLayer?.executedCues?.find(row => row.id === active.id && row.action === definition.name);
    if (!cue) return { reason: 'head_not_executed' };
    const phase = boundedEnvelope(cue.age, definition.duration);
    if (phase === null) return { reason: 'head_outside_source' };
    return { kind: explicit?.kind ?? 'attention', strength: explicit?.strength ?? .15, phase,
      timing: 'executed-head-cue', executedPhase: 'single', sampleTime: cue.age };
  }
  if (executor === 'native') {
    const state = snapshot.native;
    if (!state || state.cancelled || state.state !== 'playing' || ['entry', 'return'].includes(state.phase))
      return { reason: 'native_not_active' };
    const part = definition.phaseData?.find(row => row.id === state.id);
    if (!part || !definition.phases?.includes(state.id) || part.phase !== state.phase
      || !finite(state.phaseTime) || state.phaseTime < 0 || state.phaseTime > part.duration + 1e-6)
      return { reason: 'native_phase_unverified' };
    if (!explicit) return { reason: 'unmapped_native_face' };
    const edge = Math.min(.3, part.duration * .2);
    const phase = part.phase === 'loop' ? 1 : part.phase === 'start' ? smooth(state.phaseTime / edge)
      : part.phase === 'end' ? smooth((part.duration - state.phaseTime) / edge)
      : boundedEnvelope(Math.min(state.phaseTime, part.duration), part.duration);
    if (phase === null) return { reason: 'native_phase_unverified' };
    return { ...explicit, phase, timing: 'executed-native-source-phase', executedPhase: state.phase,
      sampleTime: state.phaseTime, sourceId: state.id };
  }
  if (executor === 'activity') {
    const state = snapshot.activity;
    if (!state || state.activeId !== definition.name || state.done || state.stopMode
      || !['playing', 'attention-pausing', 'attention-paused', 'attention-resuming',
        'awaiting-prop-release', 'awaiting-prop-grasp', 'take-blocked', 'place-blocked'].includes(state.status))
      return { reason: 'activity_not_active' };
    // The full-body controller owns continuation source time and held variants.
    // Use its displayed pose, including an actual attention pause, not a fresh
    // resample at a guessed elapsed time or the catalogue's nominal duration.
    const face = state.pose?.face ?? state.face ?? activityFace;
    const kind = ACTIVITY_FACE_KINDS[face?.preset];
    if (!kind || !finite(face?.intensity)) return { reason: 'unmapped_activity_face' };
    return { kind, strength: unit(face.intensity), phase: 1, timing: 'executed-activity-face-target',
      executedPhase: state.pose?.phase ?? state.phase, sampleTime: state.elapsed, preset: face.preset };
  }
  return { reason: definition.channel === 'face' ? 'mechanical_face_owned' : 'unmapped_body' };
}

/** Observes an already executed body row. It never chooses or queues a body
 * action, reads text, issues model calls, or directly writes PMX morph values. */
export class ActionFaceAdapter {
  constructor({ face, current, nextRevision } = {}) {
    if (!face?.setActionOverlay || !face?.clearActionOverlay || typeof current !== 'function'
      || typeof nextRevision !== 'function') throw Error('action_face_dependencies_required');
    this.face = face; this.current = current; this.nextRevision = nextRevision;
    this.installed = null; this.last = { overlay: null, mapped: false, reason: 'no_active_body' };
  }

  clear(reason) {
    if (this.installed) this.face.clearActionOverlay({ id: this.installed.id, source: this.installed.source,
      revision: this.nextRevision() });
    this.installed = null;
    return this.last = { overlay: null, mapped: false, reason };
  }

  update({ active = null, gestures = [], activityFace = null, executor = null, paused = false, snapshot = null } = {}) {
    if (!active || !['admitted', 'playing'].includes(active.status)) return this.clear('no_active_body');
    if (!active.owner?.sourceKey || this.current(active.owner) !== true) return this.clear('retired_body_source');
    const id = `body:${active.id}`, source = active.owner.sourceKey;
    if (this.installed && (this.installed.id !== id || this.installed.source !== source)) this.clear('body_changed');
    // Owner retirement above still clears a paused/cancelling character. Pause
    // never gives a new body permission to start a face before it has moved.
    if (paused) return this.last = { overlay: this.installed && { ...this.installed },
      mapped: !!this.installed, reason: 'paused' };
    if (!finite(active.displayedAt)) return this.clear('body_not_displayed');

    let kind, phase, strength, timing, executedFace;
    if (snapshot) {
      executedFace = describeExecutedFace(active, snapshot, { gestures, activityFace });
      if (executedFace.reason) return this.clear(executedFace.reason);
      ({ kind, phase, strength, timing } = executedFace);
    } else if (executor === 'conversation' && active.action?.startsWith('gesture:')) {
      const name = active.action.slice(8), gesture = gestures.find(row => row.id === active.id && row.gesture === name);
      kind = ACTION_FACE_KINDS[name];
      if (!kind) return this.clear('unmapped_gesture');
      if (!gesture || gesture.recovering || gesture.phase === 'retract') return this.clear('gesture_not_active');
      phase = gestureFacePhase(name, gesture.age);
      if (phase === null) return this.clear('missing_authored_face_timing');
      strength = unit(gesture.expressionWeight ?? gesture.strength);
      timing = 'executed-gesture-expression-envelope';
    } else if (executor === 'activity' && readings.has(active.action)) {
      kind = READING_FACE_KINDS[activityFace?.preset];
      if (!kind || !finite(activityFace?.intensity)) return this.clear('unmapped_activity_face');
      phase = 1; strength = unit(activityFace.intensity); timing = 'executed-activity-face-target';
    } else return this.clear('unmapped_body');

    const command = { id, source, kind, phase, strength };
    const same = this.installed && ['id', 'source', 'kind', 'phase', 'strength'].every(key => this.installed[key] === command[key]);
    if (!same) {
      command.revision = this.nextRevision();
      if (!this.face.setActionOverlay(command)) return this.clear('face_rejected');
      this.installed = { ...command };
    }
    return this.last = { overlay: { ...this.installed }, mapped: true, reason: timing,
      ...(executedFace ? { executedFace: { ...executedFace } } : {}),
      experimental: true, shapeSource: 'reviewed-face-profile', oldMorphChannelsForwarded: false };
  }

  snapshot() { return structuredClone(this.last); }
}
