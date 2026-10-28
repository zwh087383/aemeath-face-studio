/** Preparing a resource never grants it ownership. Callers recheck the live
 * source, scene and catalogue after readiness and before starting playback. */
export class BehaviorResourceCache {
  constructor(load, { timeoutMs = 30000, clock = () => performance.now(),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    unschedule = timer => globalThis.clearTimeout(timer) } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('invalid_resource_timeout');
    this.load = load; this.entries = new Map(); this.timeoutMs = timeoutMs;
    this.clock = clock; this.schedule = schedule; this.unschedule = unschedule;
  }
  prepare(key) {
    let entry = this.entries.get(key);
    if (entry) return entry.promise;
    entry = { state: 'loading', started: this.clock(), value: null, error: null };
    this.entries.set(key, entry);
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => { timer = this.schedule(() => {
      const error = Error('resource_preparation_timeout'); controller.abort(error); reject(error);
    }, this.timeoutMs); });
    const loading = Promise.resolve().then(() => this.load(key, { signal: controller.signal }));
    entry.promise = Promise.race([loading, deadline]).then(value => {
      // A long synchronous decode can finish before an overdue timer is given
      // its event-loop turn. Deadline semantics use the clock, not timer order.
      if (this.clock() - entry.started >= this.timeoutMs) {
        const error = Error('resource_preparation_timeout'); controller.abort(error); throw error;
      }
      entry.state = 'ready'; entry.value = value; entry.elapsedMs = this.clock() - entry.started; return value;
    }).catch(error => {
      entry.state = 'failed'; entry.error = String(error?.message ?? error); entry.elapsedMs = this.clock() - entry.started;
      throw error;
    }).finally(() => this.unschedule(timer));
    // Callers may only observe status during render ticks; retain the rejection
    // for their receipts without generating an unhandled rejection.
    entry.promise.catch(() => {});
    return entry.promise;
  }
  status(key) { const e = this.entries.get(key); return e ? { state: e.state, error: e.error, elapsedMs: e.elapsedMs } : { state: 'unloaded' }; }
  get(key) { return this.entries.get(key)?.value; }
  snapshot() { return Object.fromEntries([...this.entries].map(([key]) => [key, this.status(key)])); }
}
