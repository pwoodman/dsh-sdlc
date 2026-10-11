/**
 * tests/unit/eval-zstd-frames.test.mjs — concatenated-frame splitting.
 *
 * DSH appends one zstd frame per session event. A decoder that reads only the
 * first frame silently under-counts tokens, so the split is pinned here: frame
 * boundaries must be exact, and an unparseable tail must be REPORTED rather than
 * swallowed. The harness promises never to produce a metric it cannot defend; a
 * silent truncation would be exactly that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { isZstdFrame, frameLength, splitZstdFrames } from '../../eval/lib/zstd-frames.mjs';

const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'));

test('frameLength finds the exact end of a frame', () => {
  const f = frame('{"a":1}\n');
  assert.equal(isZstdFrame(f, 0), true);
  assert.equal(frameLength(f, 0), f.length);
  const big = frame('x'.repeat(5000));
  assert.equal(frameLength(big, 0), big.length);
});

test('splitZstdFrames splits a concatenated append log', () => {
  const parts = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'];
  const frames = parts.map(frame);
  const buf = Buffer.concat(frames);
  const r = splitZstdFrames(buf);
  assert.equal(r.frames.length, 3);
  assert.equal(r.errors, 0);
  assert.equal(r.trailing, 0);
  assert.equal(r.complete, true);
  // Each split frame decodes to exactly its original text.
  const text = r.frames.map((f) => zstdDecompressSync(f).toString('utf8')).join('');
  assert.equal(text, parts.join(''));
});

test('a whole-buffer zstdDecompressSync is not a concatenation-safe reader', () => {
  // The bug this guards: DSH appends ONE zstd frame per session event, and a
  // reader that decompresses the whole buffer only sees part of the log. WHICH
  // part depends on the engine — Node 22/24 stop after the first frame
  // (`{"a":1}\n`), Node 26 keeps decoding and returns both (`{"a":1}\n{"b":2}\n`).
  // Asserting one of those made this test fail on the other runtime, so pin what
  // is actually guaranteed: the whole-buffer call never reconstructs the log
  // from an arbitrary offset, while splitZstdFrames does.
  const buf = Buffer.concat([frame('{"a":1}\n'), frame('{"b":2}\n')]);
  const whole = zstdDecompressSync(buf).toString('utf8');
  assert.ok(
    whole === '{"a":1}\n' || whole === '{"a":1}\n{"b":2}\n',
    `whole-buffer decode returned ${JSON.stringify(whole)} — neither the first frame nor the concatenation`,
  );
  const split = splitZstdFrames(buf);
  assert.equal(split.frames.length, 2);
  assert.equal(split.frames.map((f) => zstdDecompressSync(f).toString('utf8')).join(''), '{"a":1}\n{"b":2}\n');
});

test('an unparseable tail is reported, never silently dropped', () => {
  const buf = Buffer.concat([frame('{"a":1}\n'), Buffer.from('not-a-frame')]);
  const r = splitZstdFrames(buf);
  assert.equal(r.frames.length, 1);
  assert.equal(r.complete, false);
  assert.equal(r.trailing, 'not-a-frame'.length);
  assert.equal(r.errors, 1);
});
