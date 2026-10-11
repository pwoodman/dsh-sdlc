/**
 * tests/unit/eval-usage.test.mjs — cost/speed usage extraction (eval/lib/usage.mjs).
 *
 * The cost endpoint is only as trustworthy as this parser, so an unreadable usage
 * shape must be counted as unknown, never silently as zero tokens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { extractUsageFromEvent, sumUsage, parseJsonl, readSessionLog, usageFromSessionLog } from '../../eval/lib/usage.mjs';

test('extractUsageFromEvent handles the documented and common shapes', () => {
  assert.deepEqual(extractUsageFromEvent({ tokenUsage: { input: 1, output: 2 } }), { input: 1, output: 2 });
  assert.deepEqual(extractUsageFromEvent({ usage: { inputTokens: 3, outputTokens: 4 } }), { input: 3, output: 4 });
  assert.deepEqual(extractUsageFromEvent({ usage: { prompt_tokens: 5, completion_tokens: 6 } }), { input: 5, output: 6 });
  assert.deepEqual(extractUsageFromEvent({ inputTokens: 7, outputTokens: 8 }), { input: 7, output: 8 });
  assert.deepEqual(extractUsageFromEvent({ usage: { total: 9 } }), { input: null, output: null, total: 9, unknown: false, totalOnly: true });
  assert.deepEqual(extractUsageFromEvent({ usage: { unexpected: true } }), { input: null, output: null, unknown: true });
  assert.equal(extractUsageFromEvent({}), null);
  assert.equal(extractUsageFromEvent(null), null);
});

test('sumUsage aggregates, and separates unknown from unreadable', () => {
  const u = sumUsage([
    { tokenUsage: { input: 10, output: 5 } },
    { usage: { inputTokens: 1, outputTokens: 2 } },
    { usage: { total: 99 } },
    { usage: { mystery: 1 } },
    { type: 'text', text: 'no usage' },
  ]);
  assert.equal(u.tokensIn, 11);
  assert.equal(u.tokensOut, 7);
  assert.equal(u.eventsWithUsage, 2);
  assert.equal(u.totalOnly, 1);
  assert.equal(u.unknown, 1);
});

test('sumUsage reports null (not zero) when nothing was readable', () => {
  const u = sumUsage([{ usage: { weird: 1 } }, {}]);
  assert.equal(u.tokensIn, null);
  assert.equal(u.tokensOut, null);
  assert.equal(u.unknown, 1);
});

test('parseJsonl counts malformed lines instead of throwing', () => {
  const { events, malformed } = parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n');
  assert.equal(events.length, 2);
  assert.equal(malformed, 1);
});

test('readSessionLog reads plain and zstd session logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-usage-'));
  try {
    const lines = '{"usage":{"input":2,"output":3}}\n{"usage":{"input":1,"output":1}}\n';
    const plain = join(dir, 'plain.jsonl');
    const zst = join(dir, 'plain.jsonl.zstd');
    writeFileSync(plain, lines);
    writeFileSync(zst, zstdCompressSync(Buffer.from(lines, 'utf8')));

    const p = readSessionLog(plain);
    assert.equal(p.compressed, false);
    assert.equal(p.events.length, 2);

    const z = readSessionLog(zst);
    assert.equal(z.compressed, true, 'a zstd magic header must be detected');
    assert.deepEqual(z.events, p.events);

    const totals = usageFromSessionLog(zst);
    assert.equal(totals.tokensIn, 3);
    assert.equal(totals.tokensOut, 4);
    assert.equal(totals.malformed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionLog decodes EVERY concatenated frame of an append log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-usage-'));
  try {
    // DSH appends one frame per event; only the first holds the session header.
    const per = [
      '{"type":"session","id":"s1"}\n',
      '{"type":"assistant/chunk","data":{"chunk":{"type":"usage","usage":{"inputTokens":5,"outputTokens":2}}}}\n',
      '{"type":"assistant/message","data":{"usage":{"inputTokens":5,"outputTokens":2}}}\n',
      '{"type":"assistant/message","data":{"usage":{"inputTokens":7,"outputTokens":3}}}\n',
    ];
    const zst = join(dir, 'appended.jsonl.zstd');
    writeFileSync(zst, Buffer.concat(per.map((l) => zstdCompressSync(Buffer.from(l, 'utf8')))));

    const r = readSessionLog(zst);
    assert.equal(r.compressed, true);
    assert.equal(r.frames, 4, 'every appended frame must be read, not just the first');
    assert.equal(r.truncated, false);
    assert.equal(r.events.length, 4);

    // Committed message usage counts; the SAME attempt's streamed chunk usage
    // does not, or every step would be double-counted.
    const u = usageFromSessionLog(zst);
    assert.equal(u.tokensIn, 12);
    assert.equal(u.tokensOut, 5);
    assert.equal(u.eventsWithUsage, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated session log is flagged, not silently under-counted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-usage-'));
  try {
    const zst = join(dir, 'broken.jsonl.zstd');
    writeFileSync(zst, Buffer.concat([zstdCompressSync(Buffer.from('{"usage":{"input":1,"output":1}}\n')), Buffer.from('garbage-tail')]));
    const r = readSessionLog(zst);
    assert.equal(r.truncated, true, 'a partial decode must be visible to the caller');
    const totals = usageFromSessionLog(zst);
    assert.equal(totals.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
