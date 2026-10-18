import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('              observed=""');
const end = workflow.indexOf('              echo "latest:', start);
assert.ok(start >= 0 && end > start);
const block = workflow.slice(start, end);

function run(outputs) {
  const values = outputs.map((value) => `'${value}'`).join(' ');
  return spawnSync('bash', ['-c', `
    set -euo pipefail
    name=@patwoodman/dsh-sdlc-flow
    version=0.4.0-beta.23
    outputs=(${values})
    npm() {
      test "$1" = view
      test "$4" = --prefer-online
      n=$(<"$COUNTER")
      printf '%s' "$((n+1))" > "$COUNTER"
      printf '%s\\n' "\${outputs[$n]:-0.4.0-beta.22}"
    }
    sleep() { :; }
    COUNTER=$(mktemp)
    trap 'rm -f "$COUNTER"' EXIT
    printf 0 > "$COUNTER"
    ${block}
  `], { encoding: 'utf8' });
}

test('release tag verification tolerates stale metadata then confirms latest', () => {
  const result = run(['0.4.0-beta.22', '0.4.0-beta.22', '0.4.0-beta.23']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /attempt 2/);
});

test('release tag verification fails closed when latest never becomes visible', () => {
  const result = run(['0.4.0-beta.22']);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /expected 0.4.0-beta.23/);
});
