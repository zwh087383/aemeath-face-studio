import { GESTURES } from '../../preview/core/motion-profile.js';
import { READING_ACTIONS } from './catalog.mjs';

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

  update({ active = null, gestures = [], activityFace = null, executor = null, paused = false } = {}) {
    if (!active || !['admitted', 'playing'].includes(active.status)) return this.clear('no_active_body');
    if (!active.owner?.sourceKey || this.current(active.owner) !== true) return this.clear('retired_body_source');
    const id = `body:${active.id}`, source = active.owner.sourceKey;
    if (this.installed && (this.installed.id !== id || this.installed.source !== source)) this.clear('body_changed');
    // Owner retirement above still clears a paused/cancelling character. Pause
    // never gives a new body permission to start a face before it has moved.
    if (paused) return this.last = { overlay: this.installed && { ...this.installed },
      mapped: !!this.installed, reason: 'paused' };
    if (!finite(active.displayedAt)) return this.clear('body_not_displayed');

    let kind, phase, strength, timing;
    if (executor === 'conversation' && active.action?.startsWith('gesture:')) {
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
      experimental: true, shapeSource: 'reviewed-face-profile', oldMorphChannelsForwarded: false };
  }

  snapshot() { return structuredClone(this.last); }
}
