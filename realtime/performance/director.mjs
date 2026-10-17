import { GESTURES, GESTURE_IDS } from '../../preview/core/motion-profile.js';

export const STORIES = Object.freeze({
  coordination: { name: '身体联动', description: '解释、挥手、耸肩、抚胸，再俯身和仰头。留意肘部、胸肩与重心怎样配合。', gestures: ['explain', 'wave', 'shrug', 'chest', 'bow_smile', 'look_up'] },
  greeting: { name: '见到你', description: '先招呼，再靠近，笑着回应。', gestures: ['greet', 'bow_smile', 'laugh', 'agree'] },
  conversation: { name: '听你说', description: '倾听、好奇、思考，再认真解释。', gestures: ['listen', 'curious', 'think', 'explain_firm', 'agree'] },
  affection: { name: '轻声陪伴', description: '目光移开又回来，动作放轻，温柔回应。', gestures: ['shy', 'comfort', 'chest', 'bow_smile'] },
  discovery: { name: '一个新发现', description: '抬头、惊讶、想一想，最后轻轻笑起来。', gestures: ['look_up', 'surprise', 'think', 'laugh'] },
  all: { name: '全部动作', description: '逐个观看全部表达，收势时进入下一动作。', gestures: GESTURE_IDS },
});

/** Local performance clock. It never opens audio, network or microphone resources.
 * The same controller API is used for manual preview and media-driven replies.
 */
export class PerformanceDirector {
  constructor({ motion, face }) {
    this.motion = motion; this.face = face;
    this.now = 0; this.lastWall = null; this.paused = false; this.serial = 0;
    this.story = null; this.repeat = true; this.index = -1; this.activeId = null;
    this.epoch = Math.max(motion.epoch, face.epoch) + 1; this.startedAt = 0;
    this.events = []; this.selected = 'bow_smile';
    this.motion.setPosture('relaxed');
  }
  record(type, details = {}) {
    this.events.push({ type, at: this.now, ...details });
    if (this.events.length > 80) this.events.shift();
  }
  ensureActive() {
    if (this.motion.active) return;
    this.epoch = Math.max(this.epoch, this.motion.epoch, this.face.epoch) + 1;
    this.startedAt = this.now;
    this.face.begin(this.epoch); this.motion.begin(this.epoch);
    this.motion.setPosture('relaxed', this.now);
  }
  play(id, { keepStory = false } = {}) {
    if (!GESTURES[id] || GESTURES[id].internal) return false;
    if (!keepStory) { this.story = null; this.index = -1; }
    this.paused = false; this.ensureActive();
    const cueId = `performance-${++this.serial}`;
    const accepted = this.motion.trigger(id, cueId, this.now);
    if (accepted) {
      this.activeId = cueId; this.selected = id;
      this.record('gesture', { gesture: id, cueId });
    }
    return accepted;
  }
  playStory(id, repeat = true) {
    if (!STORIES[id]) return false;
    if (!this.play(STORIES[id].gestures[0], { keepStory: true })) return false;
    this.story = id; this.repeat = repeat; this.index = 0;
    return true;
  }
  pause() {
    this.paused = !this.paused;
    this.record(this.paused ? 'pause' : 'resume');
    return this.paused;
  }
  stop() {
    this.story = null; this.index = -1; this.activeId = null; this.paused = false;
    this.face.cancel(this.epoch);
    const stopped = this.motion.cancel(this.epoch, this.now);
    this.motion.retract(this.now);
    this.record('interrupt');
    return stopped;
  }
  tick(wallSeconds) {
    const dt = this.lastWall === null ? 0 : Math.max(0, Math.min(.1, wallSeconds-this.lastWall));
    this.lastWall = wallSeconds;
    if (!this.paused) this.now += dt;
    if (this.motion.active) {
      const state = this.paused ? 'paused' : 'playing', time = this.now-this.startedAt;
      this.face.playback(this.epoch, state, time); this.motion.playback(this.epoch, state, time);
    }
    if (!this.paused && this.story) {
      const current = this.motion.snapshot().gestures.find(g => g.id === this.activeId);
      // Hand off during authored recovery, not after returning to a neutral pose.
      // Starting a successor uses the controller's live-pose transition.
      if (current?.phase === 'recover' || (!current && this.activeId && !this.motion.pending.length)) {
        const story = STORIES[this.story];
        let next = this.index+1;
        if (next >= story.gestures.length) next = this.repeat ? 0 : -1;
        if (next < 0) { this.story = null; this.activeId = null; }
        else if (this.play(story.gestures[next], { keepStory: true })) this.index = next;
      }
    }
    return { now: this.now, dt: this.paused ? 0 : dt };
  }
  snapshot() {
    return { time: this.now, paused: this.paused, story: this.story, repeat: this.repeat,
      selected: this.selected, epoch: this.epoch, activeId: this.activeId, events: this.events.slice() };
  }
}
