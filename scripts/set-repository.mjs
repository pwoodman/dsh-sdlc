#!/usr/bin/env node
/**
 * scripts/set-repository.mjs — one pass that fills the npm repository metadata.
 *
 * WHY THIS EXISTS. Every shippable manifest carried `"repository": { "type":
 * "git", "directory": "packages/<x>" }` with NO `url`, which npm publishes as-is:
 * the registry page for the package then links nowhere, `npm repo <pkg>` fails,
 * and provenance/`bugs` are missing. The values are the same for every package,
 * so they are set here rather than hand-edited seven times.
 *
 *   node scripts/set-repository.mjs <git-url>          # e.g. https://github.com/you/repo.git
 *   node scripts/set-repository.mjs --check            # CI-safe drift check
 *   node scripts/set-repository.mjs --print            # show what would be written
 *
 * It rewrites ONLY `repository.url`, `repository.type`, `homepage` and `bugs`, and
 * leaves every other key — including formatting of unrelated fields — untouched
 * by re-serialising with the same 2-space JSON the manifests already use.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PRINT = argv.includes('--print');

/** Accepts `git+https://…`, `https://…`, `git@host:owner/repo.git` → `https://host/owner/repo`. */
function normalize(arg) {
  let url = String(arg).trim();
  const scp = /^(?:git\+)?git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+\/[^/]+\/[^/]+/.test(url)) {
    throw new Error(`"${arg}" is not a repository URL. Use https://github.com/<owner>/<repo>[.git]`);
  }
  return url;
}

function manifests() {
  const dir = join(ROOT, 'packages');
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name, 'package.json');
    if (existsSync(path)) out.push(path);
  }
  return out;
}

const arg = argv.find((a) => !a.startsWith('-'));
if (!arg && !CHECK && !PRINT) {
  process.stderr.write('usage: node scripts/set-repository.mjs <git-url> | --check | --print\n');
  process.exit(1);
}

// With --check/--print, take the url already recorded in a manifest as the truth.
const current = manifests()
  .map((p) => JSON.parse(readFileSync(p, 'utf8')))
  .map((m) => m.repository?.url)
  .find(Boolean);
const url = normalize(arg ?? current ?? '');
const homepage = url;
const bugs = `${url}/issues`;
const repository = { type: 'git', url: `git+${url}.git` };

const changed = [];
for (const path of manifests()) {
  const before = readFileSync(path, 'utf8');
  const pkg = JSON.parse(before);
  const nextRepo = { ...(pkg.repository ?? {}), ...repository };
  const same =
    JSON.stringify(pkg.repository) === JSON.stringify(nextRepo) &&
    pkg.homepage === homepage &&
    JSON.stringify(pkg.bugs) === JSON.stringify({ url: bugs });
  if (same) continue;
  pkg.repository = nextRepo;
  pkg.homepage = homepage;
  pkg.bugs = { url: bugs };
  const after = JSON.stringify(pkg, null, 2) + '\n';
  if (PRINT) {
    process.stdout.write(`${path}: would set repository.url=${repository.url}\n`);
    continue;
  }
  if (!CHECK) writeFileSync(path, after);
  changed.push(path.replace(`${ROOT}/`, ''));
}

if (PRINT) process.exit(0);
if (CHECK) {
  if (changed.length) {
    process.stderr.write(`set-repository: ${changed.length} manifest(s) missing the repository metadata:\n  ${changed.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`set-repository: every manifest points at ${url}\n`);
  process.exit(0);
}
process.stdout.write(
  changed.length
    ? `set-repository: ${url} written to ${changed.length} manifest(s):\n  ${changed.join('\n  ')}\n`
    : `set-repository: already set to ${url} — nothing to do\n`,
);
