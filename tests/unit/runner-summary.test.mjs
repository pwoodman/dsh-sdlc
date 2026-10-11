/**
 * tests/unit/runner-summary.test.mjs — parse `node --test` output in any shape.
 *
 * Regression: gate M8-05 decided pass/fail with `/ℹ fail (\d+)/`. The release
 * runner (Node 22) printed Node's plain form — `# pass 553`, `# fail 0` — so the
 * regex matched nothing, the gate read `fail=?` from a green 553-test suite and
 * blocked the release. `summaryOf()` accepts both shapes and strips colour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryOf, stripAnsi } from '../../scripts/lib/harness.mjs';

const INFO = ['ℹ tests 554', 'ℹ pass 553', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'].join('\n');
const PLAIN = ['# tests 554', '# pass 553', '# fail 0', '# cancelled 0', '# skipped 1', '# todo 0', '# duration_ms 4617.282509'].join('\n');
const COLOR = '\u001b[36mℹ pass 553\u001b[0m\n\u001b[36mℹ fail 0\u001b[0m';

test('the ℹ reporter shape parses', () => {
  const s = summaryOf(INFO);
  assert.equal(s.tests, 554);
  assert.equal(s.pass, 553);
  assert.equal(s.fail, 0);
  assert.equal(s.skipped, 1);
});

test('the plain # reporter shape parses (the release-runner failure)', () => {
  const s = summaryOf(PLAIN);
  assert.equal(s.tests, 554);
  assert.equal(s.pass, 553);
  assert.equal(s.fail, 0, 'a green suite must never read as a failure because of the reporter style');
  assert.equal(s.skipped, 1);
  assert.equal(s.durationMs, 4617.282509);
});

test('colour codes do not hide the counts', () => {
  const s = summaryOf(COLOR);
  assert.equal(s.pass, 553);
  assert.equal(s.fail, 0);
  assert.equal(stripAnsi(COLOR).includes('\u001b'), false);
});

test('a run that printed no summary returns null rather than zeros', () => {
  // null is the point: "no summary" must never be mistaken for "0 failures".
  assert.equal(summaryOf('Started...\nno summary here\n'), null);
  assert.equal(summaryOf(''), null);
});

test('a real failure count is reported, not normalised away', () => {
  assert.equal(summaryOf('# fail 3\n').fail, 3);
  assert.equal(summaryOf('ℹ fail 1\n').fail, 1);
});
