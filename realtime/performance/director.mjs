import { GESTURES, GESTURE_IDS } from '../../preview/core/motion-profile.js';
import { ACTIONS, PRESET_BY_ID } from '../../preview/core/profile.js';
import { EXPANDED_STORIES } from './expanded-sequences.mjs';

export const STORIES = Object.freeze({
  wave_review: { name: '近身挥手', description: '短促挥动，完整收回；分别看普通挥手和轻快招呼的肘部与袖子。', gestures: ['wave', 'greet'], waitForRecovery: true },
  coordination: { name: '身体联动', description: '解释、挥手、耸肩、抚胸，再俯身和仰头。留意肘部、胸肩与重心怎样配合。', gestures: ['explain', 'wave', 'shrug', 'chest', 'bow_smile', 'look_up'] },
  greeting: { name: '见到你', description: '先招呼，再靠近，笑着回应。', gestures: ['greet', 'bow_smile', 'laugh', 'agree'] },
  conversation: { name: '听你说', description: '倾听、好奇、思考，再认真解释。', gestures: ['listen', 'curious', 'think', 'explain_firm', 'agree'] },
  affection: { name: '轻声陪伴', description: '目光移开又回来，动作放轻，温柔回应。', gestures: ['shy', 'comfort', 'chest', 'bow_smile'] },
  discovery: { name: '一个新发现', description: '抬头、惊讶、想一想，最后轻轻笑起来。', gestures: ['look_up', 'surprise', 'think', 'laugh'] },
  all: { name: '全部动作', description: '逐个观看全部表达，收势时进入下一动作。', gestures: GESTURE_IDS },
  ...EXPANDED_STORIES,
});

const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const validStrength = value => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);
const validDuration = value => value === undefined || (Number.isFinite(value) && value > 0 && value <= 30);

/** Validate the entire script before claiming a new epoch. A malformed later
 * step must not replace a performance that is already playing. */
export function performanceSteps(story) {
  const steps = story.steps ?? story.gestures?.map(gesture => ({ gesture }));
  if (!Array.isArray(steps) || !steps.length || steps.length > 128) return null;
  return steps.every(step => step && typeof step === 'object'
    && (step.gesture === undefined || (own(GESTURES, step.gesture) && !GESTURES[step.gesture].internal))
    && (step.delay === undefined || nonnegative(step.delay)) && (step.rest === undefined || nonnegative(step.rest))
    && (step.duration === undefined || nonnegative(step.duration))
    && (step.waitForRecovery === undefined || typeof step.waitForRecovery === 'boolean')
    && (!step.face || (own(PRESET_BY_ID, step.face.preset) && validStrength(step.face.intensity)
      && validDuration(step.face.duration) && (step.face.offset === undefined || nonnegative(step.face.offset))))
    && (!step.action || (own(ACTIONS, step.action.action) && validStrength(step.action.intensity)
      && validDuration(step.action.duration) && (step.action.offset === undefined || nonnegative(step.action.offset))))
    && [step.delay ?? 0, step.rest ?? 0, step.duration ?? 0, step.face?.offset ?? 0, step.action?.offset ?? 0].every(v => v <= 60))
    ? steps : null;
}

/** Local performance clock. It never opens audio, network or microphone resources.
 * The same controller API is used for manual preview and media-driven replies.
 */
export class PerformanceDirector {
  constructor({ motion, face }) {
    this.motion = motion; this.face = face;
    this.now = 0; this.lastWall = null; this.paused = false; this.serial = 0;
    this.story = null; this.repeat = true; this.index = -1; this.activeId = null;
    this.sequence = null; this.generation = 0;
    this.epoch = Math.max(motion.epoch, face.epoch) + 1; this.startedAt = 0;
    this.events = []; this.selected = 'bow_smile';
    this.motion.setPosture('relaxed');
  }
  record(type, details = {}) {
    this.events.push({ type, at: this.now, ...details });
    if (this.events.length > 80) this.events.shift();
  }
  ensureActive() {
    if (this.motion.active && this.face.active && this.motion.epoch === this.epoch && this.face.epoch === this.epoch) return;
    this.epoch = Math.max(this.epoch, this.motion.epoch, this.face.epoch) + 1;
    this.startedAt = this.now;
    this.face.begin(this.epoch); this.motion.begin(this.epoch);
    this.motion.setPosture('relaxed', this.now);
  }
  syncClocks() {
    const state = this.paused ? 'paused' : 'playing', time = this.now - this.startedAt;
    this.face.playback(this.epoch, state, time); this.motion.playback(this.epoch, state, time);
  }
  canPlay(id) {
    if (!own(GESTURES, id) || GESTURES[id].internal) return false;
    const cooldown = this.motion.profile?.gestures[id]?.cooldown ?? GESTURES[id].cooldown;
    return this.now - (this.motion.lastStart?.get(id) ?? -100) >= cooldown
      && !this.motion.gestures.some(g => g.gesture === id && !g.recovering)
      && !this.motion.pending.some(c => c.gesture === id && c.at - this.motion.clockOf(c) < cooldown);
  }
  /** One owner for body, expressions and future steps. Retiring it snapshots the
   * live body pose; the next owner blends from that pose rather than snapping. */
  replaceOwner() {
    this.generation++; this.sequence = null; this.story = null; this.index = -1; this.activeId = null;
    this.face.cancel(this.epoch); this.face.clearCues(); this.face.setPreset('neutral', 1);
    this.motion.cancel(this.epoch, this.now); this.motion.retract(this.now);
    this.paused = false; this.ensureActive(); this.syncClocks();
  }
  play(id, { keepStory = false } = {}) {
    if (!this.canPlay(id)) return false;
    if (!keepStory) this.replaceOwner();
    this.paused = false; this.ensureActive(); this.syncClocks();
    const cueId = `performance-${++this.serial}`;
    const accepted = this.motion.trigger(id, cueId, this.now);
    if (accepted) {
      this.activeId = cueId; this.selected = id;
      this.record('gesture', { gesture: id, cueId });
    }
    return accepted;
  }
  playExpression(preset, intensity = .8) {
    if (!own(PRESET_BY_ID, preset) || !validStrength(intensity)) return false;
    this.replaceOwner();
    this.face.setPreset(preset, intensity);
    this.record('expression', { preset, intensity });
    return true;
  }
  playAction(action, { intensity = .8, duration } = {}) {
    if (!own(ACTIONS, action) || !validStrength(intensity) || !validDuration(duration)) return false;
    this.replaceOwner();
    const accepted = this.face.enqueue({ id: `performance-${++this.serial}`, kind: 'action', action,
      epoch: this.epoch, clock: 'audio', at: this.now - this.startedAt,
      duration: duration ?? ACTIONS[action].duration, strength: intensity });
    if (accepted) this.record('action', { action, intensity });
    return accepted;
  }
  playStory(id, repeat = true) {
    if (!own(STORIES, id)) return false;
    const story = STORIES[id], steps = performanceSteps(story);
    if (!steps || (!(steps[0].delay > 0) && steps[0].gesture && !this.canPlay(steps[0].gesture))) return false;
    this.replaceOwner();
    this.story = id; this.repeat = Boolean(repeat); this.index = 0;
    this.sequence = { generation: this.generation, epoch: this.epoch, steps, phase: 'delay',
      dueAt: this.now + (steps[0].delay ?? 0), stepStarted: null, cycle: 1, completedCycles: 0 };
    this.record('story', { story: id, steps: steps.length });
    if (this.sequence.dueAt <= this.now) this.startStep();
    return true;
  }
  startStep() {
    const sequence = this.sequence, step = sequence.steps[this.index];
    if (step.gesture && !this.canPlay(step.gesture)) {
      // Inspect availability without repeatedly calling trigger(), so cooldowns
      // and a same-gesture outgoing recovery never turn into a rejection storm.
      const cooldown = this.motion.profile.gestures[step.gesture].cooldown;
      sequence.phase = 'cooldown';
      sequence.dueAt = Math.max(this.now + .15, (this.motion.lastStart.get(step.gesture) ?? -100) + cooldown);
      return;
    }
    if (step.gesture && !this.play(step.gesture, { keepStory: true })) {
      this.record('sequence-error', { story: this.story, step: this.index, reason: 'gesture-rejected' });
      this.stop(); return;
    }
    if (!step.gesture) this.activeId = null;
    this.face.clearCues();
    const at = this.now - this.startedAt;
    const faceDuration = step.face ? step.face.duration
      ?? Math.min(30, Math.max(.6, GESTURES[step.gesture]?.duration ?? step.duration ?? 2)) : 0;
    const actionDuration = step.action ? step.action.duration ?? ACTIONS[step.action.action].duration : 0;
    if (step.face) {
      this.face.enqueue({ id: `performance-${++this.serial}`, kind: 'expression', preset: step.face.preset,
        epoch: this.epoch, clock: 'audio', at: at + (step.face.offset ?? 0), duration: faceDuration, strength: step.face.intensity ?? .6 });
    }
    if (step.action) this.face.enqueue({ id: `performance-${++this.serial}`, kind: 'action', action: step.action.action,
      epoch: this.epoch, clock: 'audio', at: at + (step.action.offset ?? 0),
      duration: actionDuration, strength: step.action.intensity ?? .5 });
    sequence.phase = 'playing'; sequence.stepStarted = this.now;
    sequence.dueAt = this.now + (step.duration ?? (step.gesture ? 0 : Math.max(.1,
      (step.face?.offset ?? 0) + faceDuration,
      (step.action?.offset ?? 0) + actionDuration)));
    this.record('step', { story: this.story, step: this.index, cycle: sequence.cycle,
      gesture: step.gesture ?? null, preset: step.face?.preset ?? null });
  }
  nextStep() {
    const sequence = this.sequence, story = STORIES[this.story];
    if (this.index + 1 >= sequence.steps.length) {
      sequence.completedCycles++;
      if (!this.repeat || sequence.cycle >= (story.maxCycles ?? Infinity)) {
        this.record('story-ended', { story: this.story, cycles: sequence.completedCycles });
        this.story = null; this.activeId = null; this.sequence = null; this.face.clearCues(); return;
      }
      sequence.cycle++; this.index = 0;
    } else this.index++;
    sequence.phase = 'delay'; sequence.dueAt = this.now + (sequence.steps[this.index].delay ?? 0);
    if (sequence.dueAt <= this.now) this.startStep();
  }
  pause() {
    this.paused = !this.paused;
    this.record(this.paused ? 'pause' : 'resume');
    return this.paused;
  }
  stop() {
    this.generation++; this.sequence = null;
    this.story = null; this.index = -1; this.activeId = null; this.paused = false;
    this.face.cancel(this.epoch); this.face.clearCues(); this.face.setPreset('neutral', 1);
    const stopped = this.motion.cancel(this.epoch, this.now);
    this.motion.retract(this.now);
    this.record('interrupt');
    return stopped;
  }
  tick(wallSeconds) {
    const dt = this.lastWall === null ? 0 : Math.max(0, Math.min(.1, wallSeconds-this.lastWall));
    this.lastWall = wallSeconds;
    if (!this.paused) this.now += dt;
    if (this.motion.active) this.syncClocks();
    if (!this.paused && this.story && this.sequence) {
      const sequence = this.sequence;
      // An external audio owner may have replaced these controllers. Never
      // wake old rest/delay steps or cancel the newer owner's motion.
      if (sequence.generation !== this.generation || sequence.epoch !== this.epoch
        || this.motion.epoch !== this.epoch || this.face.epoch !== this.epoch
        || !this.motion.active || !this.face.active) {
        this.story = null; this.sequence = null; this.activeId = null;
        return { now: this.now, dt: this.paused ? 0 : dt };
      }
      if (sequence.phase === 'delay' || sequence.phase === 'cooldown') {
        if (this.now >= sequence.dueAt) this.startStep();
        return { now: this.now, dt };
      }
      if (sequence.phase === 'rest') {
        if (this.now >= sequence.dueAt) this.nextStep();
        return { now: this.now, dt };
      }
      const current = this.motion.snapshot().gestures.find(g => g.id === this.activeId);
      // Hand off during authored recovery, not after returning to a neutral pose.
      // Starting a successor uses the controller's live-pose transition.
      const story = STORIES[this.story], step = sequence.steps[this.index];
      const last = this.index === sequence.steps.length - 1;
      const complete = !current && !this.motion.pending.length;
      const recoveryHandoff = !last && !(step.rest > 0) && !(step.waitForRecovery ?? story.waitForRecovery)
        && current?.phase === 'recover';
      if (this.now >= sequence.dueAt && (!step.gesture || complete || recoveryHandoff)) {
        if (step.rest > 0) { sequence.phase = 'rest'; sequence.dueAt = this.now + step.rest; }
        else this.nextStep();
      }
    }
    return { now: this.now, dt: this.paused ? 0 : dt };
  }
  snapshot() {
    return { time: this.now, paused: this.paused, story: this.story, repeat: this.repeat,
      selected: this.selected, epoch: this.epoch, activeId: this.activeId, events: this.events.slice(),
      sequence: this.sequence ? { step: this.index + 1, total: this.sequence.steps.length, phase: this.sequence.phase,
        remaining: Math.max(0, this.sequence.dueAt - this.now), cycle: this.sequence.cycle,
        completedCycles: this.sequence.completedCycles } : null };
  }
}
