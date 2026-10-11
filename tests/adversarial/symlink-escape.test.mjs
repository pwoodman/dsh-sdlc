/**
 * tests/adversarial/symlink-escape.test.mjs — L6 threat T11: symlink/TOCTOU
 * escape from the worktree (spec v3 C.7, K.7, L.4 T11).
 *
 * The guard is LEXICAL (sdlc-guard/src/glob.js normalizePath): it normalizes the
 * string, so a lexical traversal is denied, but it never calls `realpath`. A
 * symlink whose target lies outside the worktree is therefore NOT visible to
 * the guard; resolving `realpath` is the sandbox / plugin layer's job (L.3).
 * This file asserts that honest split: lexical traversal is denied, symlink
 * following is detected only by realpath.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tempDir, cleanup, core } from '../lib/helpers.mjs';

const { GuardPlugin } = await core.guard();

test('the lexical guard denies a traversal that would escape via the symlink', () => {
  const top = tempDir('sdlc-symlink-');
  try {
    const root = join(top, 'worktree');
    const outside = join(top, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
    symlinkSync(outside, join(root, 'link'), 'dir');

    const guard = new GuardPlugin({ allowed_paths: ['**'], forbidden_paths: [] });

    // A path that walks through the link and out with `..` is lexically unsafe.
    for (const p of ['link/../../outside/secret.txt', '../outside/secret.txt', 'link/..']) {
      const decision = guard.decideFsWrite(p);
      assert.equal(decision.kind, 'deny', `lexical guard must deny ${p}`);
      assert.match(decision.reason, /unsafe-path:(traversal|absolute-path)/);
    }
  } finally {
    cleanup(top);
  }
});

test('a plain symlink-following path is NOT visible to the lexical guard (documented)', () => {
  const top = tempDir('sdlc-symlink-lexical-');
  try {
    const root = join(top, 'worktree');
    const outside = join(top, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
    symlinkSync(outside, join(root, 'link'), 'dir');

    const guard = new GuardPlugin({ allowed_paths: ['**'], forbidden_paths: [] });

    // ASSERTION-COMMENT (L.3 / L.4 T11): the path string `link/secret.txt`
    // starts with `link`, which is inside `allowed_paths`, so the LEXICAL guard
    // allows it. The guard cannot see that `link` resolves outside the worktree.
    // `realpath` enforcement is the sandbox / plugin layer's boundary, NOT this
    // pure policy module — so this allow is the documented limitation, not a
    // regression.
    const decision = guard.decideFsWrite('link/secret.txt');
    assert.equal(decision.kind, 'allow');
    assert.equal(decision.reason, 'allowed-path:**');

    // The sandbox-layer backstop: resolving the real path DOES reveal the escape.
    const resolved = realpathSync(join(root, 'link/secret.txt'));
    assert.equal(resolved, join(outside, 'secret.txt'));
    const realRoot = realpathSync(root);
    const rel = relative(realRoot, resolved);
    assert.ok(rel.startsWith('..') || isAbsolute(rel), 'realpath detection shows the write escapes the worktree');

    // A sandbox implementing the T11 control rejects exactly what the lexical
    // guard could not see.
    const sandboxWouldDeny = rel.startsWith('..') || isAbsolute(rel);
    assert.equal(sandboxWouldDeny, true);
  } finally {
    cleanup(top);
  }
});
