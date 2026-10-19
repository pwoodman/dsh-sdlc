/**
 * scripts/lib/release-guard.mjs — pure release-readiness rules.
 *
 * The publish loop skips versions that already exist and then reports success,
 * so a release cut from an already-published version silently ships nothing.
 * These rules are pure so the guard itself can be tested without a registry.
 */

import { compare } from './semver-lite.mjs';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The CHANGELOG section for `version`, or null. */
export function changelogSection(changelog, version) {
  const lines = String(changelog ?? '').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^## \\[${escapeRegExp(version)}\\]`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^## \[/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Evaluate release readiness.
 *
 * @param {object} input
 * @param {string} input.version
 * @param {string[]} [input.tags] existing `v*` tags (with or without the `v`)
 * @param {string[]} [input.manifests] versions from every package manifest
 * @param {boolean|string[]} [input.published] true, or the registry's version list
 * @param {string} [input.changelog]
 * @param {string} [input.readme]
 * @param {boolean} [input.dirty]
 * @param {boolean} [input.allowPublished]
 * @returns {{ok:boolean, problems:string[], warnings:string[]}}
 */
export function evaluateRelease({
  version,
  tags = [],
  manifests = [],
  published = false,
  changelog = '',
  readme = '',
  dirty = false,
  allowPublished = false,
  allowCurrentTag = false,
} = {}) {
  const problems = [];
  const warnings = [];

  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push(`package.json version is not an exact semver: ${version ?? '(missing)'}`);
    return { ok: false, problems, warnings };
  }

  const normalizedTags = tags.map((tag) => String(tag).replace(/^v/, '')).filter(Boolean);
  // A local pre-tag run must refuse an existing tag. The Release workflow runs
  // ON the tag, so it passes --allow-current-tag to permit exactly that one.
  const consideredTags = allowCurrentTag
    ? normalizedTags.filter((tag) => compare(version, tag) !== 0)
    : normalizedTags;
  const equalTag = normalizedTags.find((tag) => compare(version, tag) === 0);
  if (equalTag && !allowCurrentTag) problems.push(`git tag v${equalTag} already exists; bump the version before releasing`);

  const ahead = consideredTags.filter((tag) => compare(version, tag) > 0);
  if (consideredTags.length > 0 && ahead.length !== consideredTags.length) {
    const newer = consideredTags.filter((tag) => compare(version, tag) <= 0);
    problems.push(`version ${version} is not ahead of every tag (newer or equal: ${newer.map((t) => `v${t}`).join(', ')})`);
  }

  for (const manifestVersion of manifests) {
    if (manifestVersion !== version) problems.push(`a package manifest is at ${manifestVersion}, expected ${version}`);
  }

  const alreadyPublished = published === true
    || (Array.isArray(published) && published.includes(version));
  if (alreadyPublished) {
    const message = `${version} is already published to npm; the publish loop would skip every package and report success`;
    if (allowPublished) warnings.push(`${message} (allowed by --allow-published)`);
    else problems.push(message);
  }

  const section = changelogSection(changelog, version);
  if (section === null) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section`);
  } else if (/not yet published|candidate, not yet published/i.test(section)) {
    problems.push(`CHANGELOG.md's ${version} section still says it is not published`);
  }

  if (/not yet published/i.test(String(readme ?? ''))) {
    problems.push('README.md still says the release is "not yet published"');
  }

  if (dirty) problems.push('the working tree is dirty; release from a committed tree');

  return { ok: problems.length === 0, problems, warnings };
}

export default { evaluateRelease, changelogSection };
