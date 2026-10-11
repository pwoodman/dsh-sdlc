/**
 * eval/lib/usage.mjs — turn-usage extraction for the cost/speed endpoints.
 *
 * DSH exposes token counts but no currency (spec P20/P28), and the shapes differ
 * between the headless NDJSON stream and persisted session logs. Cost accounting
 * is only as good as this parser, so it is explicit about what it could not read:
 * an unrecognised usage object is counted in `unknown`, never as zero.
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { splitZstdFrames } from './zstd-frames.mjs';

const IN_KEYS = ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'];
const OUT_KEYS = ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'];
const WRAPPER_KEYS = ['tokenUsage', 'usage', 'token_usage', 'tokenUsageTotal'];

function pick(obj, keys) {
  for (const k of keys) if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) return obj[k];
  return null;
}

/**
 * Extract usage from one object that may carry it directly, under a wrapper key,
 * or as the committed `data.usage` of a persisted event.
 * @returns {{input:number|null, output:number|null, total?:number, unknown?:boolean, totalOnly?:boolean}|null}
 */
function usageIn(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const wrap of WRAPPER_KEYS) {
    const w = obj[wrap];
    if (w && typeof w === 'object') {
      const input = pick(w, IN_KEYS);
      const output = pick(w, OUT_KEYS);
      if (input != null || output != null) return { input: input ?? 0, output: output ?? 0 };
      if (typeof w.total === 'number' || typeof w.total_tokens === 'number' || typeof w.totalTokens === 'number') {
        return { input: null, output: null, total: w.total ?? w.total_tokens ?? w.totalTokens, unknown: false, totalOnly: true };
      }
      return { input: null, output: null, unknown: true };
    }
  }
  // Some shapes put the counters at the top level.
  const input = pick(obj, IN_KEYS);
  const output = pick(obj, OUT_KEYS);
  if (input != null || output != null) return { input: input ?? 0, output: output ?? 0 };
  return null;
}

/**
 * Extract `{input, output}` from one event, or null when it carries no usage.
 * A recognised wrapper with an unreadable shape returns `{unknown:true}`.
 *
 * Two shapes are recognised, because the two sources differ:
 *   - the headless `--json` stream puts usage at the top level of a `status`
 *     `step_end` event, where DSH has already de-duplicated retried attempts;
 *   - a persisted session log carries the committed usage at `data.usage` on an
 *     `assistant/message` event.
 * The streamed `data.chunk.usage` on `assistant/chunk` is deliberately NOT
 * counted: it is the same attempt's usage reported again, so counting both
 * would double every step.
 */
export function extractUsageFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return usageIn(ev) ?? usageIn(ev.data);
}

/**
 * Sum usage across events.
 * @returns {{tokensIn:number|null, tokensOut:number|null, eventsWithUsage:number, totalOnly:number, unknown:number}}
 */
export function sumUsage(events = []) {
  let tokensIn = null;
  let tokensOut = null;
  let eventsWithUsage = 0;
  let totalOnly = 0;
  let unknown = 0;
  for (const ev of events) {
    const u = extractUsageFromEvent(ev);
    if (!u) continue;
    if (u.unknown) { unknown += 1; continue; }
    if (u.totalOnly) { totalOnly += 1; continue; }
    eventsWithUsage += 1;
    tokensIn = (tokensIn ?? 0) + (u.input ?? 0);
    tokensOut = (tokensOut ?? 0) + (u.output ?? 0);
  }
  return { tokensIn, tokensOut, eventsWithUsage, totalOnly, unknown };
}

/** Parse JSONL text into events, counting malformed lines instead of throwing. */
export function parseJsonl(text) {
  const events = [];
  let malformed = 0;
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

/**
 * Read a session log: plain `.jsonl` or zstd-compressed `.jsonl.zstd`.
 *
 * A live `.jsonl.zstd` is a CONCATENATION of one frame per appended event, so
 * it must be split frame-by-frame; `zstdDecompressSync` on the whole buffer
 * decodes only the first frame. `truncated` reports whether every frame was
 * read, so a caller can treat a missing count as unreadable rather than zero.
 * @returns {{events:object[], malformed:number, compressed:boolean, frames:number, framesFailed:number, truncated:boolean}}
 */
export function readSessionLog(path) {
  const buf = readFileSync(path);
  // zstd magic number 0x28 B5 2F FD (little-endian bytes 28 b5 2f fd).
  const isZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
  if (!isZstd) {
    return { ...parseJsonl(buf.toString('utf8')), compressed: false, frames: 1, framesFailed: 0, truncated: false };
  }
  const { frames, complete } = splitZstdFrames(buf);
  const parts = [];
  let framesFailed = 0;
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(frame));
    } catch {
      framesFailed += 1;
    }
  }
  return {
    ...parseJsonl(Buffer.concat(parts).toString('utf8')),
    compressed: true,
    frames: frames.length,
    framesFailed,
    truncated: !complete || framesFailed > 0,
  };
}

/** Convenience: usage totals straight from a session-log path. */
export function usageFromSessionLog(path) {
  const { events, malformed, compressed, frames, framesFailed, truncated } = readSessionLog(path);
  return { ...sumUsage(events), malformed, compressed, frames, framesFailed, truncated };
}

export default { extractUsageFromEvent, sumUsage, parseJsonl, readSessionLog, usageFromSessionLog };
