const textId = x => typeof x === 'string' && x.length > 0 && x.length <= 128;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const identityOf = x => ({ connectionId: x.connectionId, responseId: x.responseId, epoch: x.epoch });
const validIdentity = x => x && textId(x.connectionId) && textId(x.responseId) && Number.isSafeInteger(x.epoch) && x.epoch > 0;
const identityEqual = (a, b) => a && b && a.connectionId === b.connectionId && a.responseId === b.responseId && a.epoch === b.epoch;
const ACTIVE = new Set(['buffering', 'playing', 'paused']);
const keyField = { gesture: 'gesture', action: 'action', expression: 'preset' };
const presets = ['neutral', 'smile', 'happy', 'curious', 'focus', 'surprise', 'shy', 'playful'];
export const DEFAULT_CATALOG = Object.freeze(Object.fromEntries([
  ...[['wave', 2.65, .82, 1.5], ['explain', 2.45, .66, 1.2], ['shrug', 1.6, .44, 1.2], ['chest', 2.8, .72, 1.5]]
    .map(([id, duration, apex, cooldown]) => [`gesture:${id}`, Object.freeze({ duration, apex, cooldown, slot: 'body' })]),
  ...[['nod', .86], ['shake', 1.15], ['tilt', 1.65], ['glance', 1.4], ['blink', .24]]
    .map(([id, duration]) => [`action:${id}`, Object.freeze({ duration, apex: 0, cooldown: .45, slot: id === 'blink' ? 'blink' : 'head' })]),
  ...presets.map(id => [`expression:${id}`, Object.freeze({ duration: 1.8, apex: 0, cooldown: 0, slot: 'face' })]),
]));

/** No timers, network or renderer ownership: the host supplies fresh playback snapshots.
 * emit is a synchronous, acknowledged boundary. A failed effect invalidates the turn.
 */
export class RealtimeScheduler {
  constructor({ clock = () => performance.now() / 1000, emit = () => true, catalog = DEFAULT_CATALOG,
    maxQueue = 64, maxSeen = 4096, maxFutureSeconds = 30, lateTolerance = .2, leadSeconds = .06,
    watchdogSeconds = .5 } = {}) {
    if (typeof clock !== 'function' || typeof emit !== 'function') throw new TypeError('clock and emit must be functions');
    for (const [key, value] of Object.entries({ maxQueue, maxSeen })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 65536) throw new RangeError(key);
    }
    for (const [key, value] of Object.entries({ maxFutureSeconds, lateTolerance, leadSeconds, watchdogSeconds })) {
      if (!finite(value) || value < 0 || (key === 'watchdogSeconds' && value === 0)) throw new RangeError(key);
    }
    this.catalog = new Map();
    for (const [key, def] of Object.entries(catalog)) {
      if (!/^(gesture|action|expression):[a-z][a-z0-9_]*$/.test(key) || !def || !finite(def.duration) || def.duration <= 0 || def.duration > 30
        || !finite(def.apex ?? 0) || (def.apex ?? 0) < 0 || (def.apex ?? 0) > def.duration || !textId(def.slot)
        || !finite(def.cooldown ?? 0) || (def.cooldown ?? 0) < 0) throw new TypeError(`Invalid catalog entry: ${key}`);
      this.catalog.set(key, Object.freeze({ ...def, apex: def.apex ?? 0, cooldown: def.cooldown ?? 0 }));
    }
    Object.assign(this, { clock, emit, maxQueue, maxSeen, maxFutureSeconds, lateTolerance, leadSeconds, watchdogSeconds });
    this.status = 'idle'; this.identity = null; this.highestEpoch = 0; this.time = 0;
    this.fault = null; this.queue = []; this.seen = new Set(); this.slots = new Map(); this.cooldowns = new Map();
    this.events = []; this.lastWall = -Infinity; this.lastPlaybackWall = 0; this.generated = false; this.inEmit = false;
    this.counts = { accepted: 0, rejected: 0, dispatched: 0, dropped: 0, interrupted: 0, commands: 0, faults: 0 };
  }
  _record(type, details = {}) {
    this.events.push({ type, atWall: this.lastWall, time: this.time, epoch: this.identity?.epoch ?? null, ...details });
    if (this.events.length > 128) this.events.shift();
  }
  _wall() {
    if (this.inEmit) throw new Error('Scheduler effects must not reenter the scheduler');
    let now;
    try { now = this.clock(); } catch { now = NaN; }
    if (!finite(now) || now < 0 || now < this.lastWall) { this._fail('invalid_wall_clock'); return null; }
    this.lastWall = now; return now;
  }
  _raw(type, fields = {}) {
    const command = { type, identity: this.identity ? { ...this.identity } : null, atWall: this.lastWall, ...fields };
    this.counts.commands++;
    try {
      this.inEmit = true;
      const result = this.emit(command);
      // Async effects are not accepted. Consume rejection so the diagnostic fault
      // does not additionally become an unhandled rejection in the host process.
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); return false; }
      return result === true;
    }
    catch { return false; }
    finally { this.inEmit = false; }
  }
  _clear() { this.queue.length = 0; this.slots.clear(); this.cooldowns.clear(); }
  _cleanup(reason) {
    // Attempt every cleanup effect even if one fails. Never throw past the stop path.
    const stopped = this._raw('stop_audio', { reason });
    const retracted = this._raw('retract', { reason });
    const listening = this._raw('posture', { posture: 'listening', reason });
    return stopped && retracted && listening;
  }
  _fail(reason, cleanup = true) {
    if (this.fault) return false;
    this.fault = reason; this.status = 'fault'; this._clear(); this.counts.faults++;
    this._record('fault', { reason });
    if (cleanup && this.identity) this._cleanup(reason);
    return false;
  }
  _send(type, fields = {}) { return this._raw(type, fields) || this._fail(`effect_failed:${type}`); }
  _reject(reason) { this.counts.rejected++; this._record('rejected', { reason }); return { accepted: false, reason }; }
  _owned(x) { return validIdentity(x) && identityEqual(x, this.identity); }
  _terminate(reason) {
    this.status = 'cancelled'; this._clear(); this.counts.interrupted++;
    this._record('interrupted', { reason });
    return this._cleanup(reason) || this._fail('cleanup_failed', false);
  }
  begin(input) {
    const now = this._wall();
    if (now === null || this.fault) return false;
    if (!validIdentity(input) || input.epoch <= this.highestEpoch || !finite(input.offset ?? 0) || (input.offset ?? 0) < 0) return false;
    if (this.identity && ACTIVE.has(this.status) && !this._terminate('replaced')) return false;
    this.identity = identityOf(input); this.highestEpoch = input.epoch;
    this.time = input.offset ?? 0; this.status = 'buffering'; this.lastPlaybackWall = now;
    this.generated = false; this._clear(); this.seen.clear(); this._record('began');
    return this._send('begin', { time: this.time }) && this._send('playback', { status: 'buffering', time: this.time });
  }
  playback(input) {
    const now = this._wall();
    if (now === null || this.fault || !this._owned(input) || !ACTIVE.has(this.status)) return false;
    if (!['buffering', 'playing', 'paused', 'ended'].includes(input.status) || !finite(input.time) || input.time < this.time) return false;
    // Explicit pause freezes content. Consecutive buffering snapshots may include
    // a short PCM chunk completely consumed between RAF samples; acknowledge its
    // real media position, but never dispatch actions until playback is active.
    if ((this.status === 'paused' || input.status === 'paused')
      && ['paused', 'buffering'].includes(this.status) && ['paused', 'buffering'].includes(input.status) && input.time !== this.time) return false;
    this.time = input.time; this.status = input.status; this.lastPlaybackWall = now;
    if (!this._send('playback', { status: this.status, time: this.time })) return false;
    if (this.status === 'ended') {
      this._clear(); this._record('drained');
      return this._send('posture', { posture: 'listening', reason: 'drained' });
    }
    return this.tick();
  }
  enqueue(input) {
    if (this._wall() === null || this.fault) return this._reject('fault');
    if (!this._owned(input) || !ACTIVE.has(this.status)) return this._reject('inactive_or_wrong_owner');
    if (!textId(input.id)) return this._reject('invalid_id');
    if (this.seen.has(input.id)) return this._reject('duplicate');
    if (this.seen.size >= this.maxSeen) return this._reject('dedup_capacity');
    if (this.queue.length >= this.maxQueue) return this._reject('queue_full');
    const kind = input.kind ?? 'gesture', field = keyField[kind];
    if (!Object.hasOwn(keyField, kind) || !textId(input[field])) return this._reject('unknown_kind');
    const key = `${kind}:${input[field]}`, def = this.catalog.get(key);
    if (!def) return this._reject('unknown_action');
    if (input.at !== undefined && input.apexAt !== undefined) return this._reject('ambiguous_time');
    if (input.duration !== undefined) return this._reject('duration_owned_by_catalog');
    if (input.clock !== undefined && input.clock !== 'audio') return this._reject('invalid_clock');
    const strength = input.strength ?? 1;
    if (!finite(strength) || strength < 0 || strength > 1) return this._reject('invalid_strength');
    let at = input.at;
    if (input.apexAt !== undefined) {
      if (!finite(input.apexAt) || input.apexAt < def.apex) return this._reject('insufficient_prepare_time');
      at = input.apexAt - def.apex;
    }
    if (at === undefined) at = this.time + this.leadSeconds;
    if (!finite(at) || at < 0 || at > this.time + this.maxFutureSeconds) return this._reject('invalid_time');
    if (this.time - at > this.lateTolerance) return this._reject('late');
    this.seen.add(input.id);
    this.queue.push({ key, def, requestedAt: at, cue: { id: input.id, epoch: this.identity.epoch, clock: 'audio', kind,
      [field]: input[field], at, duration: def.duration, strength } });
    this.queue.sort((a, b) => a.requestedAt - b.requestedAt);
    this.counts.accepted++; this._record('queued', { id: input.id, key, at });
    return { accepted: true, reason: 'queued', at };
  }
  tick() {
    if (this._wall() === null || this.fault) return false;
    if (this.status !== 'playing') return true;
    if (this.lastWall - this.lastPlaybackWall > this.watchdogSeconds) return this._terminate('playback_watchdog');
    while (this.queue.length && this.queue[0].requestedAt <= this.time) {
      const entry = this.queue.shift(), { def, key, cue, requestedAt } = entry;
      if (this.time - requestedAt > this.lateTolerance) {
        this.counts.dropped++; this._record('dropped', { id: cue.id, reason: 'missed_window' }); continue;
      }
      if ((this.slots.get(def.slot) ?? -Infinity) > this.time || (this.cooldowns.get(key) ?? -Infinity) > this.time) {
        // Do not silently postpone a semantic gesture until it expresses the wrong sentence.
        this.counts.dropped++; this._record('dropped', { id: cue.id, reason: 'busy_or_cooldown' }); continue;
      }
      // Start from the current pose; a slightly late cue must not skip its preparation.
      const emitted = { ...cue, at: this.time };
      if (!this._send('cue', { cue: emitted, requestedAt })) return false;
      this.slots.set(def.slot, this.time + def.duration); this.cooldowns.set(key, this.time + def.cooldown);
      this.counts.dispatched++; this._record('dispatched', { id: cue.id, key, start: this.time });
    }
    return true;
  }
  providerDone(input) {
    if (this._wall() === null || this.fault || !this._owned(input) || !ACTIVE.has(this.status)) return false;
    if (this.generated) return true;
    this.generated = true; this._record('provider_done'); return this._send('provider_done');
  }
  interrupt(input) {
    if (this._wall() === null || this.fault || !this._owned(input) || !ACTIVE.has(this.status)) return false;
    return this._terminate(textId(input.reason) ? input.reason : 'barge_in');
  }
  recover() {
    if (this._wall() === null || !this.fault) return false;
    this.fault = null; this.status = 'idle'; this.identity = null; this.time = 0; this._clear();
    this._record('host_confirmed_recovery'); return true;
  }
  snapshot() {
    return { status: this.status, identity: this.identity ? { ...this.identity } : null, time: this.time,
      queued: this.queue.length, fault: this.fault, generated: this.generated, highestEpoch: this.highestEpoch,
      counts: { ...this.counts }, events: this.events.map(e => ({ ...e })) };
  }
}
