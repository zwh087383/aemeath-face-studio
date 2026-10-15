import { selectSubtitleCues } from './subtitle-rules.mjs';

const OPEN = new Map([['（', '）'], ['(', ')'], ['[', ']'], ['【', '】'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"']]);
const CLOSE = new Set(OPEN.values());
// ASCII periods may be decimals/abbreviations. Keep them in the same unit until
// a strong boundary or finish instead of risking an early affirmative fragment.
const END = /[。！？!?；;\n]/u;

/** Stateful only inside a disposable worker. A segment is never truncated: a
 * missing delta or overflowing segment disables the sidecar instead. */
export function createSubtitleWorkerHandler(select = selectSubtitleCues) {
  let generation = null, items = new Map(), segments = 0, failed = false;
  return function process(job) {
    const reply = { type: 'result', generation: job.generation, jobId: job.jobId, owner: job.owner, decisions: [] };
    if (job.generation !== generation) {
      generation = job.generation; items = new Map(); segments = 0; failed = false;
    }
    const fail = reason => { failed = true; return { ...reply, decisions: [], error: reason }; };
    if (failed) return fail('worker_turn_disabled');
    const { maxSegmentChars, maxSegments, maxItems } = job.limits;
    const analyze = (state, anchor, receivedAt) => {
      const text = state.text.trim();
      state.text = ''; state.stack = [];
      if (!text) return;
      if (++segments > maxSegments) throw new Error('segment_capacity');
      const result = select(text, job.context);
      reply.decisions.push({ ...result, anchor, receivedAt });
    };
    try {
      for (const chunk of job.chunks) {
        if (!items.has(chunk.itemId)) {
          if (items.size >= maxItems) return fail('item_capacity');
          items.set(chunk.itemId, { text: '', stack: [], anchor: chunk.anchor, receivedAt: chunk.receivedAt });
        }
        const state = items.get(chunk.itemId);
        state.anchor = chunk.anchor; state.receivedAt = chunk.receivedAt;
        for (const character of chunk.text) {
          state.text += character;
          if (state.text.length > maxSegmentChars) return fail('segment_capacity');
          if (character === '"' && state.stack.at(-1) === '"') state.stack.pop();
          else if (OPEN.has(character)) state.stack.push(OPEN.get(character));
          else if (CLOSE.has(character)) {
            if (state.stack.at(-1) !== character) return fail('unbalanced_delimiter');
            state.stack.pop();
          }
          if (END.test(character) && state.stack.length === 0) analyze(state, chunk.anchor, chunk.receivedAt);
        }
      }
      if (job.finish) {
        for (const state of items.values()) {
          // An unterminated quoted/stage direction is not a complete utterance.
          if (state.stack.length) return fail('unclosed_delimiter');
          analyze(state, state.anchor, state.receivedAt);
        }
      }
      return reply;
    } catch (error) {
      return fail(error?.message === 'segment_capacity' ? 'segment_capacity' : 'analysis_failed');
    }
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const process = createSubtitleWorkerHandler();
  self.onmessage = event => self.postMessage(process(event.data));
}
