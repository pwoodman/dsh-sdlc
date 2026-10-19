/**
 * tests/contract/release-guard.test.mjs — pure rules behind scripts/verify-release.mjs.
 *
 * The current tree is expected to fail the real guard (beta.23 is published and
 * still tagged); these tests pin the decision table so the failure is
 * actionable, not incidental.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRelease, changelogSection } from '../../scripts/lib/release-guard.mjs';

const GOOD = {
  version: '0.4.0-beta.24',
  tags: ['v0.4.0-beta.22', 'v0.4.0-beta.23'],
  manifests: ['0.4.0-beta.24', '0.4.0-beta.24'],
  published: ['0.4.0-beta.22', '0.4.0-beta.23'],
  changelog: '## [0.4.0-beta.24] — new\n\n- fixed\n\n## [0.4.0-beta.23] — old\n',
  readme: 'Release candidate: 0.4.0-beta.24.',
  dirty: false,
};

test('a new, documented, unpublished version passes', () => {
  const result = evaluateRelease(GOOD);
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.deepEqual(result.problems, []);
});

test('an already-published version fails (the publish loop would silently skip it)', () => {
  const result = evaluateRelease({ ...GOOD, published: [...GOOD.published, GOOD.version] });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /already published/);
});

test('a version equal to an existing tag fails locally, but the release-tag run may allow it', () => {
  const tags = [...GOOD.tags, `v${GOOD.version}`];
  const local = evaluateRelease({ ...GOOD, tags });
  assert.equal(local.ok, false);
  assert.match(local.problems.join('\n'), /already exists/);
  const release = evaluateRelease({ ...GOOD, tags, allowCurrentTag: true });
  assert.equal(release.ok, true, release.problems.join('\n'));
  // A newer tag still fails even with --allow-current-tag.
  const newer = evaluateRelease({ ...GOOD, tags: [...tags, 'v0.4.0-beta.25'], allowCurrentTag: true });
  assert.equal(newer.ok, false);
  assert.match(newer.problems.join('\n'), /not ahead of every tag/);
});

test('a version older than a tag fails', () => {
  const result = evaluateRelease({ ...GOOD, version: '0.4.0-beta.22', tags: ['v0.4.0-beta.23'], changelog: '## [0.4.0-beta.22]\n' });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /not ahead of every tag/);
});

test('a missing or stale CHANGELOG section fails', () => {
  const missing = evaluateRelease({ ...GOOD, changelog: '## [0.4.0-beta.23]\n' });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join('\n'), /no "## \[0\.4\.0-beta\.24\]" section/);

  const stale = evaluateRelease({
    ...GOOD,
    changelog: '## [0.4.0-beta.24] — candidate, not yet published\n\n- fixed\n',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.problems.join('\n'), /still says it is not published/);
});

test('a README that says "not yet published" fails', () => {
  const result = evaluateRelease({ ...GOOD, readme: 'Release candidate (not yet published).' });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /README/);
});

test('a dirty tree fails unless explicitly allowed', () => {
  assert.equal(evaluateRelease({ ...GOOD, dirty: true }).ok, false);
  assert.equal(evaluateRelease({ ...GOOD, dirty: false }).ok, true);
});

test('--allow-published downgrades the published error to a warning (resume)', () => {
  const result = evaluateRelease({ ...GOOD, published: [GOOD.version], allowPublished: true });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /already published/);
});

test('changelogSection stops at the next version heading', () => {
  const section = changelogSection(GOOD.changelog, '0.4.0-beta.24');
  assert.match(section, /fixed/);
  assert.doesNotMatch(section, /old/);
});
