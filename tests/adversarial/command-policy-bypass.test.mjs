/**
 * tests/adversarial/command-policy-bypass.test.mjs — L6 threat: command-policy
 * bypass (spec v3 C.7, K.7, L.3).
 *
 * L.3 is unambiguous: command-string matching is BEST-EFFORT and defeatable
 * (`bash -c`, interpreters, encodings, shell expansion). This file asserts the
 * documented limitation honestly and then asserts the real control — the
 * DIFF-BASED backstop — still catches the out-of-scope write.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, core, makeRepo, git, run } from '../lib/helpers.mjs';

const { GuardPlugin } = await core.guard();
const { deriveWorkerResult, scopeVerdict, parseGitNames } = await core.workerResult();

const CONTRACT = { allowed_paths: ['src/api/**'], forbidden_paths: [] };

const guard = () => new GuardPlugin({ allowed_paths: ['src/api/**'], forbidden_paths: [] });

test('the string matcher catches literal destructive commands (documented best-effort)', () => {
  const gr = guard();
  const caught = [
    'rm -rf /',
    'git push --force origin main',
    'git push -f origin main',
    'git clean -fdx',
    'git reset --hard HEAD~1',
    // Caught only because the literal pattern appears as a substring:
    'bash -c "rm -rf /"',
    'xargs rm -rf /',
  ];
  for (const c of caught) {
    assert.equal(gr.checkCommand(c), 'deny', `expected string matcher to catch: ${c}`);
  }
});

test('the string matcher MISSES interpreter, encoding and expansion forms (documented)', () => {
  const gr = guard();
  // ASSERTION-COMMENT (L.3): these are the documented bypasses. Matching fails
  // because the destructive effect is not present as a literal substring.
  const missed = [
    ['bash -c "echo hi"', 'a shell wrapper is opaque to substring matching'],
    ['python -c "import os; os.system(\'true\')"', 'an interpreter is opaque'],
    ['git apply patch.diff', 'git apply is not on the default forbidden list'],
    ['echo cm0gLXJmIC8= | base64 -d | sh', 'the payload is encoded'],
    ['echo src | xargs touch', 'xargs hides the real verb'],
    ['rm -rf "$HOME"', 'shell expansion changes the literal'],
    ['sh -c "dd if=/dev/zero of=/dev/sda"', 'arbitrary commands are not enumerated'],
  ];
  for (const [c, why] of missed) {
    assert.equal(gr.checkCommand(c), 'allow', `${why} (expected allow for ${c})`);
  }
});

test('the diff-based backstop catches out-of-scope writes the string matcher missed', () => {
  const repo = makeRepo({ 'src/api/app.js': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    const gr = guard();
    mkdirSync(join(repo, 'src'), { recursive: true });

    // Each command is one of the bypasses above; the guard allows the command,
    // then the write happens and the git diff exposes it.
    const bypasses = [
      'bash -c "echo pwned > src/evil-bash.ts"',
      'echo cGV3bmVk > /tmp/sdlc-b64-payload.txt; cp /tmp/sdlc-b64-payload.txt src/evil-b64.ts',
      'git apply /dev/null 2>/dev/null; echo pwned > src/evil-apply.ts',
      'printf "pwned\\n" | xargs -I{} sh -c "echo {} > src/evil-xargs.ts"; :',
      'HOME=.; echo pwned > src/evil-expand.ts',
    ];

    for (const cmd of bypasses) {
      const decision = gr.decideCommand(cmd);
      assert.equal(decision.kind, 'allow', `string matcher unexpectedly caught: ${cmd}`);
      const res = run('bash', ['-c', cmd], { cwd: repo });
      assert.equal(res.status, 0, `bypass command failed: ${cmd}: ${res.stderr}`);
    }

    // The runtime never asks the worker; it stages everything and diffs vs base.
    git(['add', '-A'], repo);
    const filesChanged = parseGitNames(git(['diff', '--cached', '--name-only', base], repo));
    assert.ok(filesChanged.includes('src/evil-bash.ts'));
    assert.ok(filesChanged.includes('src/evil-expand.ts'));

    const result = deriveWorkerResult({
      filesChanged,
      contract: CONTRACT,
      claims: { status: 'completed', summary: 'all done' },
      runtime: { exitCode: 0, turnEndReason: 'completed' },
    });
    const scope = scopeVerdict(result);
    assert.equal(scope.ok, false);
    assert.equal(scope.code, 'SCOPE_VIOLATION');
    assert.ok(result.out_of_scope_files.length >= 4, 'every escaped write is out of scope');

    // Negative control: an allowed-path write in the same run is still in scope.
    writeFileSync(join(repo, 'src/api/new.ts'), 'ok\n');
    git(['add', '-A'], repo);
    const withAllowed = parseGitNames(git(['diff', '--cached', '--name-only', base], repo));
    const inScope = deriveWorkerResult({ filesChanged: ['src/api/new.ts'], contract: CONTRACT, claims: {}, runtime: { exitCode: 0 } });
    assert.deepEqual(inScope.out_of_scope_files, []);
    assert.ok(withAllowed.includes('src/api/new.ts'));
  } finally {
    cleanup(repo);
  }
});
