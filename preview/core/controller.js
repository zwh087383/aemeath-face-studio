import { ACTIONS, C, CHANNELS, PRESET_BY_ID, VOWELS } from './profile.js';

export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const mix = (a, b, k) => a + (b - a) * k;
const envelope = (age, duration, attack, release) => Math.min(smooth(age / attack), smooth((duration - age) / release));
const curve = (keys, age) => {
  for (let i = 1; i < keys.length; i++) {
    if (age <= keys[i][0]) {
      const [ta, a] = keys[i - 1], [tb, b] = keys[i];
      return mix(a, b, smooth((age - ta) / (tb - ta)));
    }
  }
  return 0;
};

/** Pure local animation controller. All times are seconds, supplied by the caller.
 * Audio-scoped cues require a monotonically increasing utterance epoch.
 * One update produces a borrowed, reusable semantic weight array; no renderer IO.
 */
export class FaceController {
  constructor() {
    this.weights = new Float32Array(CHANNELS.length);
    this.target = new Float32Array(CHANNELS.length);
    this.base = 'neutral';
    this.strength = .8;
    this.epoch = 0;
    this.active = false;
    this.status = 'idle';
    this.time = 0;
    this.now = 0;
    this.cues = [];
    this.seen = new Set();
    this.cooldown = new Map();
    this.head = { pitch: 0, yaw: 0, roll: 0 };
    this.activePreset = 'neutral';
    this.activeActions = [];
    this.nextBlink = 2.4;
    this.blinkStart = -100;
    this.random = 173;
    this.rejected = 0;
    // Idle head sway. A body-motion layer that composes head/gaze itself turns this off.
    this.headSway = true;
  }

  setPreset(id, strength = this.strength) {
    if (!Object.hasOwn(PRESET_BY_ID, id) || !Number.isFinite(strength)) return false;
    this.base = id;
    this.strength = clamp(strength);
    return true;
  }

  begin(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) return false;
    this.epoch = epoch;
    this.active = true;
    this.status = 'playing';
    this.time = 0;
    this.cues.length = 0;
    this.seen.clear();
    this.cooldown.clear();
    return true;
  }

  playback(epoch, status, time) {
    if (!this.active || epoch !== this.epoch || !['playing', 'paused', 'ended'].includes(status) || !Number.isFinite(time)) return false;
    this.status = status;
    this.time = Math.max(0, time);
    if (status === 'ended') {
      this.active = false;
      this.cues.length = 0;
    }
    return true;
  }

  cancel(epoch) {
    if (!this.active || epoch !== this.epoch) return false;
    this.active = false;
    this.status = 'cancelled';
    this.cues.length = 0;
    this.cooldown.clear();
    this.base = 'neutral';
    return true;
  }

  clearCues() { this.cues.length = 0; }

  enqueue(cue) {
    const reject = () => { this.rejected++; return false; };
    if (!cue || typeof cue.id !== 'string' || !cue.id || cue.id.length > 128 || this.cues.length >= 128) return reject();
    const audio = cue.clock !== 'wall';
    if (cue.clock !== undefined && !['wall', 'audio'].includes(cue.clock)) return reject();
    if (audio && (!this.active || cue.epoch !== this.epoch)) return reject();
    if (cue.kind !== 'expression' && cue.kind !== 'action') return reject();
    if (cue.kind === 'expression' ? !Object.hasOwn(PRESET_BY_ID, cue.preset) : !Object.hasOwn(ACTIONS, cue.action)) return reject();
    if (!Number.isFinite(cue.at) || cue.at < 0 || !Number.isFinite(cue.duration) || cue.duration <= 0 || cue.duration > 30) return reject();
    if (cue.strength !== undefined && !Number.isFinite(cue.strength)) return reject();
    const clock = audio ? this.time : this.now;
    if (cue.at + cue.duration <= clock || cue.at > clock + 60 || this.seen.has(cue.id)) return reject();
    // Never replay a gesture that arrived after its meaningful start window.
    if (cue.kind === 'action' && clock - cue.at > .20) return reject();
    this.seen.add(cue.id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
    this.cues.push({ ...cue, clock: audio ? 'audio' : 'wall', strength: clamp(cue.strength ?? 1) });
    return true;
  }

  trigger(action, id, now = this.now) {
    if (!Object.hasOwn(ACTIONS, action) || !Number.isFinite(now)) return false;
    if (now - (this.cooldown.get(action) ?? -100) < .45) return false;
    const audio = this.active;
    const accepted = this.enqueue({ id, kind: 'action', action, epoch: this.epoch,
      clock: audio ? 'audio' : 'wall', at: audio ? this.time : now, duration: ACTIONS[action].duration });
    if (accepted) this.cooldown.set(action, now);
    return accepted;
  }

  update(now, dt, lip = null, idle = true) {
    this.now = now;
    dt = clamp(dt, 0, .1);
    const t = this.target;
    t.fill(0);
    const base = PRESET_BY_ID[this.base];
    for (const [name, value] of Object.entries(base.morphs)) t[C[name]] = clamp(value * this.strength);
    let tilt = base.tilt * this.strength;
    this.activePreset = this.base;
    this.activeActions.length = 0;
    let actionPitch = 0, actionYaw = 0, actionRoll = 0, forcedBlink = 0;
    this.cues = this.cues.filter(cue => {
      const clock = cue.clock === 'audio' ? this.time : now;
      return clock < cue.at + cue.duration && (cue.clock !== 'audio' || this.active);
    });
    // Most recently enqueued expression wins in overlaps. Gestures are bounded below.
    let selected = null;
    for (const cue of this.cues) {
      const age = (cue.clock === 'audio' ? this.time : now) - cue.at;
      if (age < 0) continue;
      if (cue.kind === 'expression') { selected = { cue, age }; continue; }
      const action = ACTIONS[cue.action];
      const localAge = age * action.duration / cue.duration;
      this.activeActions.push(cue.action);
      if (cue.action === 'blink') forcedBlink = Math.max(forcedBlink, Math.sin(Math.PI * localAge / action.duration) ** 1.5);
      else {
        const v = curve(action.keys, localAge) * cue.strength;
        if (action.axis === 'pitch') actionPitch += v;
        if (action.axis === 'yaw') actionYaw += v;
        if (action.axis === 'roll') actionRoll += v;
      }
    }
    if (selected) {
      const { cue, age } = selected, p = PRESET_BY_ID[cue.preset];
      const fade = envelope(age, cue.duration, Math.min(.18, cue.duration / 3), Math.min(.28, cue.duration / 3));
      for (let i = 0; i < t.length; i++) t[i] *= 1 - fade;
      for (const [name, value] of Object.entries(p.morphs)) t[C[name]] += clamp(value * this.strength * cue.strength) * fade;
      tilt = mix(tilt, p.tilt * this.strength * cue.strength, fade);
      this.activePreset = p.id;
    }

    const speaking = this.status === 'playing' && this.active;
    const closed = ['paused', 'cancelled', 'ended'].includes(this.status);
    if (speaking || closed) {
      for (const i of VOWELS) t[i] = speaking ? clamp(lip?.weights?.[i] ?? 0) : 0;
      t[C.mouthWide] = speaking ? clamp(lip?.weights?.[C.mouthWide] ?? 0) : 0;
      t[C.mouthNarrow] = speaking ? clamp(lip?.weights?.[C.mouthNarrow] ?? 0) : 0;
      t[C.mouthFlat] = 0;
      const seal = speaking ? clamp(lip?.closure ?? 0) : 0;
      t[C.smile] = clamp(t[C.smile] + (speaking ? (lip?.weights?.[C.smile] ?? 0) : 0), 0, .65) * (1 - .7 * seal);
      t[C.frown] = clamp(t[C.frown] + (speaking ? (lip?.weights?.[C.frown] ?? 0) : 0), 0, .5) * (1 - .5 * seal);
    }

    if (idle && now >= this.nextBlink) {
      this.blinkStart = now;
      this.random = (1664525 * this.random + 1013904223) >>> 0;
      this.nextBlink = now + 3.2 + this.random / 4294967296 * 2.4;
    }
    const blinkAge = now - this.blinkStart;
    const blink = Math.max(forcedBlink, idle && blinkAge >= 0 && blinkAge < .24 ? Math.sin(blinkAge / .24 * Math.PI) ** 1.5 : 0);
    // Full-eye blink is attenuated for a closed-eye smile or wink; wide eyes yield to it.
    t[C.blink] = blink * (1 - Math.max(t[C.smileEyes], t[C.wink]));
    for (const i of [C.eyeSharp, C.eyeDroop, C.eyeHalf, C.eyeSmile, C.eyeWide, C.pupilSmall]) t[i] *= 1 - t[C.blink];
    for (let i = 0; i < t.length; i++) {
      const mouth = VOWELS.includes(i) || i === C.mouthWide || i === C.mouthNarrow;
      const tau = mouth ? (speaking ? .025 : .018) : i === C.blink ? .012 : i === C.blush ? .16 : .09;
      this.weights[i] = clamp(mix(this.weights[i], clamp(t[i]), 1 - Math.exp(-dt / tau)));
    }
    const total = VOWELS.reduce((sum, i) => sum + this.weights[i], 0);
    if (total > .72) for (const i of VOWELS) this.weights[i] *= .72 / total;
    // Enforce eye exclusions after smoothing, not only on the target pose.
    const lid = Math.max(this.weights[C.smileEyes], this.weights[C.wink]);
    this.weights[C.blink] = Math.min(this.weights[C.blink], 1 - lid);
    this.weights[C.eyeWide] = Math.min(this.weights[C.eyeWide], 1 - Math.max(lid, this.weights[C.blink]));
    const k = 1 - Math.exp(-dt / .06);
    this.head.pitch = mix(this.head.pitch, clamp(actionPitch, -.14, .14), k);
    const sway = idle && this.headSway;
    this.head.yaw = mix(this.head.yaw, clamp(actionYaw + (sway ? .012 * Math.sin(now * .49) : 0), -.2, .2), k);
    this.head.roll = mix(this.head.roll, clamp(tilt + actionRoll + (sway ? .006 * Math.sin(now * .78) : 0), -.2, .2), k);
    return this.weights;
  }

  snapshot() {
    return { epoch: this.epoch, active: this.active, status: this.status, time: this.time,
      preset: this.activePreset, actions: [...this.activeActions], queued: this.cues.length,
      rejected: this.rejected, mouthOpen: VOWELS.reduce((s, i) => s + this.weights[i], 0),
      head: { ...this.head }, weights: Array.from(this.weights) };
  }
}
