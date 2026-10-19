/**
 * tests/unit/release-excludes.test.mjs — the beta artifact must not carry local
 * state, package stores or evaluation output.
 *
 * Regression: `git status --porcelain --ignored=matching -z` emits `!! path`,
 * but the original parser required `! path`, so it matched nothing and the
 * fallback list missed `.pnpm-store`. A 10.6 MiB tarball containing a pnpm
 * distribution reached every tester.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIgnoredPaths,
  makeReleaseExcluder,
  isScratchPath,
} from '../../scripts/lib/release-excludes.mjs';

test('parses git ignored entries (`!! path`) and ignores other porcelain states', () => {
  const stdout = [
    ' M CHANGELOG.md',
    '?? tests/new.test.mjs',
    '!! .pnpm-store/',
    '!! node_modules/',
    '!! packages/sdlc-core/lib/',
    '',
  ].join('\0');
  const ignored = parseIgnoredPaths(stdout);
  assert.equal(ignored.has('.pnpm-store'), true);
  assert.equal(ignored.has('node_modules'), true);
  assert.equal(ignored.has('packages/sdlc-core/lib'), true);
  assert.equal(ignored.has('M CHANGELOG.md'), false);
  assert.equal(ignored.has('tests/new.test.mjs'), false);
});

test('the excluder drops package stores and scratch homes but keeps built lib/', () => {
  const excluded = makeReleaseExcluder({
    ignored: parseIgnoredPaths('!! .pnpm-store/\0!! .eval-out/\0!! packages/sdlc-core/lib/\0'),
  });
  for (const rel of ['.pnpm-store', '.pnpm-store/v11/index.db', '.eval-out/records.jsonl', '.git/config', 'node_modules/x']) {
    assert.equal(excluded(rel), true, `${rel} must be excluded`);
  }
  assert.equal(excluded('packages/sdlc-core/lib/index.js'), false, 'prebuilt lib/ must ship');
  assert.equal(excluded('lib/index.js'), false, 'root lib/ must ship');
  assert.equal(excluded('packages/sdlc-core/src/index.js'), false, 'source ships in the beta tarball');
});

test('a new ignored directory is excluded even when it is not in the fallback list', () => {
  const excluded = makeReleaseExcluder({ ignored: parseIgnoredPaths('!! .prompt-cache/\0') });
  assert.equal(excluded('.prompt-cache'), true);
  assert.equal(excluded('.prompt-cache/blob'), true);
});

test('.eval-* scratch homes are excluded by name without a git checkout', () => {
  assert.equal(isScratchPath('.eval-out-live/records.jsonl'), true);
  assert.equal(isScratchPath('.evaluation/notes'), false);
  const excluded = makeReleaseExcluder({ ignored: null });
  assert.equal(excluded('.eval-out-live/records.jsonl'), true);
  assert.equal(excluded('.validation/gate-P.json'), true);
  assert.equal(excluded('packages/sdlc-core/lib/index.js'), false);
});
