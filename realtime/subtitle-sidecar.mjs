import { validBehaviorCandidate } from './behavior-planner.mjs';

const ACTIVE = new Set(['buffering', 'playing', 'paused']);
const PROFILES = new Set(['gentle', 'balanced', 'lively']);
const FIELDS = { expression: 'preset', action: 'action', gesture: 'gesture' };
const finite = x => typeof x === 'number' && Number.isFinite(x);
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 128;
const ownerValid = x => x && id(x.connectionId) && id(x.responseId) && Number.isSafeInteger(x.epoch) && x.epoch > 0;
const equal = (a, b) => a && b && a.connectionId === b.connectionId && a.responseId === b.responseId && a.epoch === b.epoch;
const ownerOf = x => ({ connectionId: x.connectionId, responseId: x.responseId, epoch: x.epoch });

/** Optional, nonblocking subtitle consumer. No audio ownership, provider SDK,
 * renderer imports or scheduler.tick/interrupt calls. Hosts cancel the scheduler
 * separately to retract cues which have already crossed its enqueue boundary. */
export class SubtitleSidecar {
  constructor({ scheduler, workerFactory = () => new Worker(new URL('./subtitle-worker.mjs', import.meta.url), { type: 'module' }),
    clock = () => performance.now() / 1000, onDecision = () => {}, planner = null,
    maxChunkChars = 1024, maxTurnChars = 16384, maxChunks = 256, maxPendingChunks = 32,
    maxSegmentChars = 512, maxSegments = 64, maxItems = 8, maxCues = 24,
    workerTimeoutMs = 1200, maxResultAgeSeconds = 1.2, motionGapSeconds = 3,
    repeatMotionSeconds = 8, repeatExpressionSeconds = 6, fallbackCooldownSeconds = 12 } = {}) {
    if (!scheduler || typeof scheduler.enqueue !== 'function' || typeof workerFactory !== 'function'
      || typeof clock !== 'function' || typeof onDecision !== 'function'
      || (planner && !['planCandidate', 'snapshot', 'feedback'].every(key => typeof planner[key] === 'function')))
      throw new TypeError('invalid sidecar dependencies');
    const bounds = { maxChunkChars: [1, 4096], maxTurnChars: [1, 65536], maxChunks: [1, 1024], maxPendingChunks: [1, 128],
      maxSegmentChars: [1, 512], maxSegments: [1, 256], maxItems: [1, 32], maxCues: [1, 128], workerTimeoutMs: [10, 10000] };
    const config = { maxChunkChars, maxTurnChars, maxChunks, maxPendingChunks, maxSegmentChars, maxSegments, maxItems, maxCues, workerTimeoutMs,
      maxResultAgeSeconds, motionGapSeconds, repeatMotionSeconds, repeatExpressionSeconds, fallbackCooldownSeconds };
    for (const [key, [min, max]] of Object.entries(bounds)) {
      if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new RangeError(key);
    }
    for (const key of ['maxResultAgeSeconds', 'motionGapSeconds', 'repeatMotionSeconds', 'repeatExpressionSeconds', 'fallbackCooldownSeconds']) {
      if (!finite(config[key]) || config[key] < 0 || config[key] > 120) throw new RangeError(key);
    }
    Object.assign(this, config, { scheduler, workerFactory, clock, onDecision, planner });
    this.plannerGeneration = null; this.lastPlan = null; this.cuePlans = new Map(); this.motionReservations = new Map();
    this.status = 'idle'; this.owner = null; this.generation = 0; this.jobSequence = 0; this.worker = null;
    this.inFlight = null; this.timer = null; this.pending = []; this.items = new Map(); this.inputFinished = false;
    this.receivedChunks = 0; this.receivedChars = 0; this.turnCues = 0; this.lastWall = -Infinity; this.anchors = new Set();
    // Density limits span response boundaries: quick new replies must not reset
    // the twelve-second fallback budget or repeatedly restart the same gesture.
    this.lastMotion = -Infinity; this.lastFallback = -Infinity; this.lastByCue = new Map(); this.lastDecision = null;
    this.counts = { acceptedChunks: 0, rejectedChunks: 0, jobs: 0, decisions: 0, queuedCues: 0, suppressedCues: 0, dropped: 0, disabled: 0 };
  }
  _notify(status, reason, details = {}) {
    const event = { status, reason, owner: this.owner ? { ...this.owner } : null, generation: this.generation, ...details };
    this.lastDecision = event;
    try { const result = this.onDecision(structuredClone(event)); if (result?.catch) result.catch(() => {}); } catch { /* diagnostics never control playback */ }
  }
  _now() {
    let now; try { now = this.clock(); } catch { return null; }
    if (!finite(now) || now < 0 || now < this.lastWall) return null;
    this.lastWall = now; return now;
  }
  _schedulerActive() {
    return equal(this.owner, this.scheduler.identity) && ACTIVE.has(this.scheduler.status) && !this.scheduler.fault
      && finite(this.scheduler.time) && this.scheduler.time >= 0;
  }
  _stopWorker() {
    clearTimeout(this.timer); this.timer = null; this.inFlight = null;
    const worker = this.worker; this.worker = null;
    if (worker) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { const result = worker.terminate(); if (result?.catch) result.catch(() => {}); } catch { /* isolated worker */ }
    }
  }
  _disable(reason) {
    if (this.status === 'disabled' || this.status === 'disposed') return false;
    this.status = 'disabled'; this.pending = []; this._stopWorker(); this.counts.disabled++;
    this._notify('disabled', reason); return false;
  }
  _reject(reason) { this.counts.rejectedChunks++; return { accepted: false, reason }; }
  _planFeedback(reason) {
    if (!this.lastPlan || !this.planner) return;
    try {
      this.planner.feedback(this.lastPlan.planId, { accepted: false, reason });
      this.lastPlan = this.planner.snapshot().lastPlan;
    } catch { this._disable('planner_failed'); }
  }
  _releaseDroppedReservations() {
    // Scheduler late/busy drops do not cross the sink boundary. A queued cue
    // that disappeared without admission therefore cannot consume seen history.
    if (!this.motionReservations.size) return;
    const queued = new Set(this.scheduler.queue.map(entry => entry.cue.id));
    for (const [cueId, reservation] of this.motionReservations) {
      if (!reservation.accepted && !queued.has(cueId))
        this.executionFeedback(cueId, { accepted: false, reason: 'scheduler_dropped' });
    }
  }
  _motionBudget(key) {
    let any = this.lastMotion, same = this.lastByCue.get(key) ?? -Infinity;
    for (const reservation of this.motionReservations.values()) {
      any = Math.max(any, reservation.at);
      if (reservation.key === key) same = Math.max(same, reservation.at);
    }
    return { any, same };
  }
  begin(owner, { userText = '', profile = 'balanced', policy = 'legacy' } = {}) {
    if (this.status === 'disposed' || !ownerValid(owner) || !equal(owner, this.scheduler.identity)
      || !ACTIVE.has(this.scheduler.status) || this.scheduler.fault || equal(owner, this.owner)
      || typeof userText !== 'string' || userText.length > 512 || !PROFILES.has(profile)
      || !['legacy', 'natural'].includes(policy)) return false;
    this._stopWorker(); this.generation++; this.owner = ownerOf(owner); this.context = { userText, profile, policy };
    this.lastPlan = null; this.plannerGeneration = null; this.cuePlans.clear(); this.motionReservations.clear();
    if (policy === 'natural' && this.planner) {
      try {
        const snapshot = this.planner.snapshot();
        if (!equal(snapshot.owner, owner)) return this._disable('planner_owner_mismatch');
        this.plannerGeneration = snapshot.interactionGeneration;
      } catch { return this._disable('planner_unavailable'); }
    }
    this.pending = []; this.items = new Map(); this.anchors = new Set(); this.receivedChunks = 0; this.receivedChars = 0;
    this.turnCues = 0; this.inputFinished = false; this.lastDecision = null; this.status = 'active';
    if (this._now() === null) return this._disable('invalid_clock');
    try {
      const worker = this.workerFactory();
      if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw new Error('invalid worker');
      this.worker = worker;
      const generation = this.generation;
      worker.onmessage = event => { if (this.worker === worker && this.generation === generation) this._receive(event?.data); };
      worker.onerror = () => { if (this.worker === worker && this.generation === generation) this._disable('worker_error'); };
      worker.onmessageerror = () => { if (this.worker === worker && this.generation === generation) this._disable('worker_message_error'); };
    } catch { return this._disable('worker_unavailable'); }
    return true;
  }
  push(input) {
    if (this.status !== 'active' || this.inputFinished) return this._reject('inactive');
    if (!ownerValid(input) || !equal(input, this.owner)) return this._reject('wrong_owner');
    if (!this._schedulerActive()) { this._disable('scheduler_inactive'); return this._reject('scheduler_inactive'); }
    if (!id(input.itemId) || !Number.isSafeInteger(input.sequence) || input.sequence < 0
      || typeof input.text !== 'string' || !input.text.length || input.text.length > this.maxChunkChars) {
      this._disable('invalid_chunk'); return this._reject('invalid_chunk');
    }
    let item = this.items.get(input.itemId);
    if (!item) {
      if (this.items.size >= this.maxItems) { this._disable('item_capacity'); return this._reject('item_capacity'); }
      item = { next: 0, chunks: new Map() }; this.items.set(input.itemId, item);
    }
    if (input.sequence < item.next) {
      if (item.chunks.get(input.sequence) === input.text) return this._reject('duplicate');
      this._disable('conflicting_duplicate'); return this._reject('conflicting_duplicate');
    }
    if (input.sequence !== item.next) { this._disable('sequence_gap'); return this._reject('sequence_gap'); }
    if (this.receivedChunks >= this.maxChunks || this.receivedChars + input.text.length > this.maxTurnChars
      || this.pending.length >= this.maxPendingChunks) { this._disable('input_capacity'); return this._reject('input_capacity'); }
    const now = this._now();
    if (now === null) { this._disable('invalid_clock'); return this._reject('invalid_clock'); }
    item.chunks.set(input.sequence, input.text); item.next++;
    this.receivedChunks++; this.receivedChars += input.text.length; this.counts.acceptedChunks++;
    // The host, not incoming subtitle text or worker output, owns this anchor.
    const anchor = this.scheduler.time + (this.scheduler.leadSeconds || 0);
    this.anchors.add(`${anchor}:${now}`);
    this.pending.push({ itemId: input.itemId, text: input.text, anchor, receivedAt: now });
    this._pump();
    return this.status === 'active' ? { accepted: true, reason: 'buffered' } : this._reject('worker_failed');
  }
  finish(owner) {
    if (!equal(owner, this.owner) || this.status !== 'active') return false;
    if (!this._schedulerActive()) return this._disable('scheduler_inactive');
    if (this.inputFinished) return true;
    this.inputFinished = true; this._pump(); return this.status !== 'disabled';
  }
  _pump() {
    if (this.status !== 'active' || this.inFlight || (!this.pending.length && !this.inputFinished)) return;
    if (!this._schedulerActive()) { this._disable('scheduler_inactive'); return; }
    const job = { type: 'process', generation: this.generation, jobId: ++this.jobSequence, owner: { ...this.owner },
      context: this.context, limits: { maxSegmentChars: this.maxSegmentChars, maxSegments: this.maxSegments, maxItems: this.maxItems },
      chunks: this.pending.splice(0), finish: this.inputFinished };
    this.inFlight = job; this.counts.jobs++;
    this.timer = setTimeout(() => { if (this.inFlight === job) this._disable('worker_timeout'); }, this.workerTimeoutMs);
    try { this.worker.postMessage(job); } catch { this._disable('worker_post_failed'); }
  }
  _receive(result) {
    const job = this.inFlight;
    if (!job || this.status !== 'active') return;
    if (!result || result.generation !== job.generation || result.jobId !== job.jobId || !equal(result.owner, this.owner)) {
      this.counts.dropped++; return;
    }
    clearTimeout(this.timer); this.timer = null; this.inFlight = null;
    if (!this._schedulerActive()) { this._disable('scheduler_inactive'); return; }
    if (result.error) { this._disable(String(result.error).slice(0, 80)); return; }
    if (!Array.isArray(result.decisions) || result.decisions.length > this.maxSegments) { this._disable('invalid_worker_result'); return; }
    for (const decision of result.decisions) {
      if (!this._schedulerActive() || this.status !== 'active') break;
      this._apply(decision);
    }
    if (job.finish && this.status === 'active') { this.status = 'finished'; this._stopWorker(); }
    else this._pump();
  }
  _apply(decision) {
    const now = this._now();
    if (now === null) { this._disable('invalid_clock'); return; }
    if (!decision || !finite(decision.anchor) || !finite(decision.receivedAt) || decision.receivedAt > now
      || !this.anchors.has(`${decision.anchor}:${decision.receivedAt}`)
      || !Array.isArray(decision.cues) || decision.cues.length > 2) { this._disable('invalid_worker_result'); return; }
    this.counts.decisions++;
    if (now - decision.receivedAt > this.maxResultAgeSeconds || this.scheduler.time - decision.anchor > this.scheduler.lateTolerance) {
      this.counts.dropped++; this._notify('dropped', 'late_result', { anchor: decision.anchor }); return;
    }
    this._releaseDroppedReservations();
    if (this.status !== 'active') return;
    let cues = [];
    const slots = new Set();
    for (const candidate of decision.cues) {
      const field = Object.hasOwn(FIELDS, candidate?.kind) ? FIELDS[candidate.kind] : null;
      const slot = candidate?.kind === 'expression' ? 'face' : 'motion';
      if (!field || !id(candidate[field]) || !this.scheduler.catalog?.has(`${candidate.kind}:${candidate[field]}`)
        || !finite(candidate.strength) || candidate.strength < 0 || candidate.strength > 1 || slots.has(slot)) {
        this._disable('invalid_worker_cue'); return;
      }
      slots.add(slot); cues.push({ kind: candidate.kind, [field]: candidate[field], strength: candidate.strength,
        reason: typeof candidate.reason === 'string' ? candidate.reason.slice(0, 128) : 'semantic' });
    }
    if (this.context.policy === 'natural') {
      if (!validBehaviorCandidate(decision.behavior)) { this._disable('invalid_worker_behavior'); return; }
      // none/micro/defer are explicit decisions. They never grant permission to
      // synthesize a missing authored explain gesture, even without a planner.
      const level = decision.behavior.reaction.level;
      cues = cues.filter(cue => cue.kind === 'expression' || (level === 'micro' && cue.kind === 'action')
        || (level === 'authored' && cue.kind === 'gesture'));
      if (this.planner) {
        try {
          const bodyBusy = (this.scheduler.slots?.get('body') ?? -Infinity) > decision.anchor
            || this.scheduler.queue.some(entry => entry.def?.slot === 'body'
              && entry.requestedAt <= decision.anchor && entry.requestedAt + entry.def.duration > decision.anchor);
          const observedParts = this.planner.snapshot().parts;
          // Current executor availability is more precise than a global body
          // lock. Pending authored body cues still reserve arms/torso, while a
          // gaze-only reaction can remain eligible during an arm exit.
          const parts = observedParts ? structuredClone(observedParts) : null;
          if (parts && bodyBusy) { parts.arms = { L: 'occupied', R: 'occupied' }; parts.torso = 'occupied'; }
          const planned = this.planner.planCandidate({ behavior: decision.behavior, cues }, {
            owner: this.owner, interactionGeneration: this.plannerGeneration, anchor: decision.anchor,
            nowAudio: this.scheduler.time, receivedAt: decision.receivedAt, nowWall: now, bodyBusy, parts,
            candidateId: `subtitle:${this.generation}:${this.counts.decisions}`,
          });
          if (!planned?.accepted) { this.counts.dropped++; this._notify('dropped', planned?.reason ?? 'planner_rejected', { anchor: decision.anchor }); return; }
          cues = planned.cues; this.lastPlan = planned.plan;
          this._notify('planned', planned.reason, { anchor: decision.anchor, plan: this.lastPlan, cues });
        } catch { this._disable('planner_failed'); return; }
      }
    }
    if (this.context.policy !== 'natural' && !slots.has('motion') && decision.fallbackEligible === true && now - this.lastFallback >= this.fallbackCooldownSeconds) {
      cues.push({ kind: 'gesture', gesture: 'explain', strength: this.context.profile === 'gentle' ? .35 : this.context.profile === 'lively' ? .7 : .5,
        reason: 'conversation_fallback' });
    }
    if (!cues.length) { this._notify('suppressed', String(decision.suppressedReason || 'no_cue').slice(0, 128), { anchor: decision.anchor, cues: [] }); return; }
    for (const cue of cues) {
      if (this.status !== 'active' || !this._schedulerActive()) break;
      const field = FIELDS[cue.kind], key = `${cue.kind}:${cue[field]}`, motion = cue.kind !== 'expression';
      const budget = motion ? this._motionBudget(key) : { same: this.lastByCue.get(key) ?? -Infinity };
      const repeated = now - budget.same < (motion ? this.repeatMotionSeconds : this.repeatExpressionSeconds);
      if (repeated || (motion && now - budget.any < this.motionGapSeconds) || this.turnCues >= this.maxCues) {
        if (motion) this._planFeedback('density_limit');
        this.counts.suppressedCues++; this._notify('suppressed', 'density_limit', { anchor: decision.anchor, cues: [cue] }); continue;
      }
      let queued;
      const cueId = `subtitle:${this.generation}:${this.counts.decisions}:${cue.kind}`;
      try { queued = this.scheduler.enqueue({ ...this.owner, id: cueId,
        kind: cue.kind, [field]: cue[field], strength: cue.strength, at: decision.anchor }); }
      catch { this._disable('scheduler_enqueue_failed'); return; }
      if (queued?.accepted) {
        if (motion && this.lastPlan) {
          // Natural execution history commits only after a composed display
          // acknowledgement. The pending reservation still prevents queue bursts.
          this.cuePlans.set(cueId, this.lastPlan.planId);
          this.motionReservations.set(cueId, { key, at: now, accepted: false });
        } else {
          this.lastByCue.set(key, now);
          if (motion) this.lastMotion = now;
        }
        this.turnCues++; this.counts.queuedCues++;
        if (cue.reason === 'conversation_fallback') this.lastFallback = now;
        this._notify('queued', cue.reason, { anchor: decision.anchor, cues: [cue], accepted: true });
      } else {
        if (motion) this._planFeedback(queued?.reason || 'scheduler_rejected');
        this.counts.dropped++; this._notify('dropped', queued?.reason || 'scheduler_rejected', { anchor: decision.anchor, cues: [cue], accepted: false });
      }
    }
  }
  /** Host executor acknowledgement, not enqueue success. Rendering evidence is
   * explicit so a queued or rejected proposal never counts as already played. */
  executionFeedback(cueId, { accepted, displayed = false, reason } = {}) {
    const planId = this.cuePlans.get(cueId);
    // Disabling analysis does not retract already queued visual commands. Their
    // current-generation execution acknowledgements still settle reservations.
    if (!planId || !this.planner || !['active', 'finished', 'disabled'].includes(this.status)
      || typeof accepted !== 'boolean' || typeof displayed !== 'boolean' || (displayed && !accepted)) return false;
    try {
      const result = this.planner.feedback(planId, { accepted, displayed, reason });
      const reservation = this.motionReservations.get(cueId);
      if (result && accepted && reservation) {
        reservation.accepted = true;
        if (displayed) {
          const now = this._now();
          if (now === null) return this._disable('invalid_clock');
          this.lastMotion = Math.max(this.lastMotion, now);
          this.lastByCue.set(reservation.key, Math.max(this.lastByCue.get(reservation.key) ?? -Infinity, now));
        }
      }
      // maxCues reserves capacity while pending, then charges actual displays.
      // A refused/uncredited command must not exhaust the remainder of the turn.
      if (reservation && (!accepted || (displayed && !result))) this.turnCues = Math.max(0, this.turnCues - 1);
      if (!accepted || displayed) { this.cuePlans.delete(cueId); this.motionReservations.delete(cueId); }
      return result;
    } catch { return this._disable('planner_failed'); }
  }
  cancel(owner) {
    if (!equal(owner, this.owner) || this.status === 'disposed') return false;
    this.status = 'cancelled'; this.pending = []; this.cuePlans.clear(); this.motionReservations.clear(); this._stopWorker(); return true;
  }
  snapshot() {
    return { status: this.status, owner: this.owner ? { ...this.owner } : null, generation: this.generation,
      inFlight: !!this.inFlight, pendingChunks: this.pending.length, receivedChunks: this.receivedChunks, receivedChars: this.receivedChars,
      counts: { ...this.counts }, lastDecision: this.lastDecision ? structuredClone(this.lastDecision) : null,
      policy: this.context?.policy ?? 'legacy', plannerGeneration: this.plannerGeneration,
      pendingMotionReservations: this.motionReservations.size,
      lastPlan: this.lastPlan ? structuredClone(this.lastPlan) : null };
  }
  dispose() { this.status = 'disposed'; this.pending = []; this.items.clear(); this.cuePlans.clear(); this.motionReservations.clear(); this._stopWorker(); }
}
