/**
 * tests/adversarial/diff-spoofing.test.mjs — L6 threat: a worker tries to hide
 * changes from the diff-based control (spec v3 K.7, L.4 T1/T2).
 *
 * The authoritative control is `git diff <merge-base> --name-only`. This file
 * uses REAL git and asserts which spoofing tricks that control defeats and which
 * it does not — with the enumerated-worktree backstop for the remainder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, core, makeRepo, git } from '../lib/helpers.mjs';

const { parseGitNames } = await core.workerResult();

test('a commit inside the worktree is still visible from the merge-base', () => {
  const repo = makeRepo({ 'tracked.txt': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    // The worker commits its change inside its own worktree...
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'worker commit'], repo);
    // ...then tries to hide a later working-tree edit.
    writeFileSync(join(repo, 'tracked.txt'), 'v3\n');
    git(['update-index', '--assume-unchanged', 'tracked.txt'], repo);

    const diffDerived = parseGitNames(git(['diff', '--name-only', base], repo));
    assert.deepEqual(diffDerived, ['tracked.txt'], 'the committed change cannot be hidden from the merge-base diff');
  } finally {
    cleanup(repo);
  }
});

test('git update-index flags hide working-tree-only edits; ls-files -v is the backstop', () => {
  const repo = makeRepo({ 'tracked.txt': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    git(['update-index', '--assume-unchanged', 'tracked.txt'], repo);

    // Honest limitation: with the bit set and no commit, `git diff` hides it.
    assert.equal(git(['diff', '--name-only', base], repo).trim(), '', 'assume-unchanged hides the worktree edit from git diff');

    // Backstop: the flag itself is enumerable, and clearing it restores the diff.
    const flagged = git(['ls-files', '-v'], repo).split('\n').find((l) => l.endsWith('tracked.txt'));
    assert.match(flagged, /^[a-z] /, 'lowercase status flag means assume-unchanged');

    git(['update-index', '--no-assume-unchanged', 'tracked.txt'], repo);
    assert.deepEqual(parseGitNames(git(['diff', '--name-only', base], repo)), ['tracked.txt']);

    // Same story for skip-worktree (uppercase `S`).
    git(['update-index', '--skip-worktree', 'tracked.txt'], repo);
    assert.equal(git(['diff', '--name-only', base], repo).trim(), '');
    const skipped = git(['ls-files', '-v'], repo).split('\n').find((l) => l.endsWith('tracked.txt'));
    assert.match(skipped, /^S /);
    git(['update-index', '--no-skip-worktree', 'tracked.txt'], repo);
    assert.deepEqual(parseGitNames(git(['diff', '--name-only', base], repo)), ['tracked.txt']);
  } finally {
    cleanup(repo);
  }
});

test('an ignored-but-tracked file cannot be hidden from git diff', () => {
  const repo = makeRepo({ '.gitignore': 'local.env\n' });
  try {
    // Track the file explicitly: `git add -A` would skip an ignored file.
    writeFileSync(join(repo, 'local.env'), 'a\n');
    git(['add', '-f', 'local.env'], repo);
    git(['commit', '-qm', 'track local.env despite .gitignore'], repo);
    const base = git(['rev-parse', 'HEAD'], repo);
    // `local.env` matches .gitignore but is already tracked: edits still show.
    writeFileSync(join(repo, 'local.env'), 'b\n');
    assert.deepEqual(parseGitNames(git(['diff', '--name-only', base], repo)), ['local.env']);
  } finally {
    cleanup(repo);
  }
});

test('an untracked ignored file is invisible to git diff; enumeration is the backstop', () => {
  const repo = makeRepo({ '.gitignore': 'ignored.log\n', 'src/api/app.js': 'v1\n' });
  try {
    const base = git(['rev-parse', 'HEAD'], repo);
    writeFileSync(join(repo, 'ignored.log'), 'worker payload\n');
    appendFileSync(join(repo, '.gitignore'), '# still ignored\n');

    const diffDerived = parseGitNames(git(['diff', '--name-only', base], repo));
    assert.ok(!diffDerived.includes('ignored.log'), 'a brand-new ignored file is invisible to git diff');

    // Backstop: the orchestrator must also enumerate ignored untracked files.
    const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard'], repo).split('\n');
    assert.ok(ignored.includes('ignored.log'), 'enumeration surfaces the hidden file');
  } finally {
    cleanup(repo);
  }
});
