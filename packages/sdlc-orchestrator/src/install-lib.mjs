/**
 * packages/sdlc-orchestrator/src/install-lib.mjs — pure text helpers for the
 * registry installer. Kept separate from `install.mjs` so tests can import it
 * without running the CLI.
 */

/**
 * Normalize `minimumReleaseAgeExclude` in a pnpm-workspace.yaml body and add
 * exact-version entries for the suite.
 *
 * pnpm accepts ONE `name@version` pattern per list item. A value such as
 * `@patwoodman/dsh-sdlc-flow@0.4.0-beta.19 || 0.4.0-beta.20` (written by an
 * earlier install path) is not a valid pattern, so pnpm ignores the exemption
 * and a fresh beta silently resolves to the previous one. This splits such
 * entries into valid items, carries the package name onto a bare version, adds
 * the requested specs, deduplicates, sorts, and leaves every other setting in
 * the file untouched.
 *
 * @param {string} text - existing pnpm-workspace.yaml (may be empty).
 * @param {string[]} specs - exact `name@version` patterns to add.
 * @returns {string} the rewritten YAML body with a trailing newline.
 */
export function normalizeReleaseAgeExcludes(text, specs) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*$/.test(line));
  const wanted = [];
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && (/^\s*-\s+/.test(lines[end]) || lines[end].trim() === '')) end += 1;
    for (const line of lines.slice(start + 1, end)) {
      const raw = line.replace(/^\s*-\s+/, '').trim();
      if (!raw) continue;
      const value = raw.replace(/^['"]|['"]$/g, '');
      let packageName = null;
      for (const part of value.split(/\s*\|\|\s*/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const named = /^((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(trimmed);
        if (named) {
          packageName = named[1];
          wanted.push(trimmed);
        } else if (packageName && /^[0-9]/.test(trimmed)) {
          wanted.push(`${packageName}@${trimmed}`);
        } else {
          wanted.push(trimmed);
        }
      }
    }
    lines.splice(start, end - start);
  }
  wanted.push(...specs);
  const unique = [...new Set(wanted.filter(Boolean))].sort();
  lines.push('minimumReleaseAgeExclude:');
  for (const spec of unique) lines.push(`  - '${spec}'`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
