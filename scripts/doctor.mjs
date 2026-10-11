#!/usr/bin/env node
/**
 * scripts/doctor.mjs — the `sdlc doctor` environment diagnostic.
 *
 * This is the single source of truth behind both:
 *   - `sdlc doctor` / `/sdlc doctor`   (in-session convenience wrapper)
 *   - `npx @patwoodman/orchestrator doctor`  (standalone, no DSH boot required)
 *
 * It runs WITHOUT booting DSH and WITHOUT any LLM call, so it is safe in CI
 * pre-flight. Unlike spec v2's F.2, it does not invent a `/sdlc` slash command
 * in headless mode: slash commands require an interactive command adapter
 * (dsh-commands README) and do not exist in one-shot runs.
 *
 *   node scripts/doctor.mjs [--json <path>] [--fix] [--profile <name>] [--quiet]
 *
 * Exit 0 = no errors (warnings allowed). Exit 1 = at least one error.
 * `--fix` performs only idempotent, non-destructive repairs and re-runs.
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { run } from './lib/harness.mjs';
import { dshPeerSatisfied } from './lib/semver-lite.mjs';
import { ownBundlePrefix, isOwnBundleName } from './lib/composition.mjs';

// ESM has no bare `require`; the v2 C.8.1 script's `require(...)` calls would
// have thrown ReferenceError. This is the corrected form.
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const FIX = argv.includes('--fix');
const QUIET = argv.includes('--quiet');
// P36 (beta.2): the peer range the packages declare; the runtime version is
// checked against it instead of against one pinned version string.
const DSH_PEER_RANGE = JSON.parse(
  readFileSync(new URL('../packages/sdlc-core/package.json', import.meta.url), 'utf8'),
).peerDependencies['@deepseek-ai/dsh'];
const PROVIDER_KEY_HINTS = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const PROJECT = process.cwd();
const SDLC_DIR = join(PROJECT, '.sdlc');

const sections = new Map();
let errors = 0;
let warnings = 0;

function section(name) {
  if (!sections.has(name)) sections.set(name, []);
  return sections.get(name);
}
/** level: 'ok' | 'warn' | 'error' | 'skip' */
function record(sec, level, label, detail = '', fixHint = null) {
  if (level === 'error') errors += 1;
  if (level === 'warn') warnings += 1;
  section(sec).push({ level, label, detail, fixHint });
}

// ── Platform ───────────────────────────────────────────────────────────────

function checkPlatform() {
  const sec = 'Platform';
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) {
    record(sec, 'ok', `Node.js ${process.version}`, '>= 22.5 required for node:sqlite');
  } else {
    record(sec, 'error', `Node.js ${process.version}`, 'node:sqlite requires Node >= 22.5', 'Install Node 22.5+ (nvm/volta)');
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table t(x)');
    db.close();
    record(sec, 'ok', 'node:sqlite (DatabaseSync)', 'storage binding available');
  } catch (e) {
    record(sec, 'error', 'node:sqlite', e.message, 'Upgrade Node, or set storage.fallback: better-sqlite3');
  }

  const git = run('git', ['--version']);
  if (git.ok) record(sec, 'ok', git.stdout.trim());
  else record(sec, 'error', 'git', 'not found on PATH', 'Install git >= 2.30');

  const pnpm = run('pnpm', ['--version']);
  if (pnpm.ok) {
    record(sec, 'ok', `pnpm ${pnpm.stdout.trim()}`);
  } else {
    record(
      sec,
      'error',
      'pnpm',
      'not on PATH — `dsh plugin add` fails with exit 127',
      'npm install -g pnpm   (or `corepack enable pnpm`; corepack is NOT bundled in Node 25+)',
    );
  }

  const dsh = run('dsh', ['--version']);
  if (!dsh.ok) {
    record(sec, 'error', 'dsh CLI', 'not on PATH', 'npm install -g @deepseek-ai/dsh (any 0.2.x)');
  } else {
    const actual = dsh.stdout.trim().replace(/^v/, '');
    // Range check (P36, beta.2): full semver precedence via the shared helper.
    if (dshPeerSatisfied(actual)) record(sec, 'ok', `dsh ${actual} (within peer range ${DSH_PEER_RANGE})`);
    else
      record(
        sec,
        'error',
        `dsh ${actual} is outside the peer range ${DSH_PEER_RANGE}`,
        'peerDependencies enforcement keys off the runtime version',
        `Install a 0.2.x runtime, or grant an exemption: dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version ${actual} --accept-risk`,
      );
  }
}

// ── Harness home & credentials ─────────────────────────────────────────────

function checkHome() {
  const sec = 'Harness home';
  if (!existsSync(DSH_HOME)) {
    record(sec, 'warn', `${DSH_HOME} does not exist`, 'created on first dsh boot');
    if (FIX) {
      try {
        mkdirSync(DSH_HOME, { recursive: true });
        record(sec, 'ok', 'created DSH_HOME');
      } catch (e) {
        record(sec, 'error', 'could not create DSH_HOME', e.message);
      }
    }
    return;
  }
  try {
    const probe = join(DSH_HOME, '.sdlc-doctor-probe');
    mkdirSync(probe, { recursive: true });
    record(sec, 'ok', `${DSH_HOME} writable`);
  } catch (e) {
    record(sec, 'error', `${DSH_HOME} not writable`, e.message, 'Fix permissions; --dump-config writes cordis.yml into the profile');
  }

  const creds = join(DSH_HOME, '.credentials.yaml');
  const envKeys = PROVIDER_KEY_HINTS.filter((k) => process.env[k]);
  if (existsSync(creds)) {
    record(sec, 'ok', 'credential store present', creds);
  } else if (envKeys.length) {
    record(sec, 'warn', 'no credential store', `relying on env: ${envKeys.join(', ')}`);
  } else {
    record(sec, 'error', 'no provider credentials', 'neither .credentials.yaml nor a *_API_KEY env var', 'Set an API key, or run the Models settings page');
  }
  if (envKeys.length) record(sec, 'ok', `env keys: ${envKeys.join(', ')}`);
}

// ── Profiles & bundles ─────────────────────────────────────────────────────

function profileDir(name) {
  return join(DSH_HOME, 'profiles', name);
}

function readProfileBundles(name) {
  const p = join(profileDir(name), 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'))?.dsh?.profile?.bundles ?? [];
  } catch {
    return null;
  }
}

function checkProfiles() {
  const sec = 'Profiles';
  // Derived from the manifests, not a literal: a scope rename (set-scope.mjs)
  // must not stop doctor recognising that a profile still selects an old-scope
  // copy of the suite, which is exactly the state that composes every row twice.
  const own = ownBundlePrefix();
  for (const [name, required] of [
    ['sdlc-web', [`${own}orchestrator`]],
    ['sdlc-worker', [`${own}orchestrator-guard`, `${own}orchestrator-tools`]],
  ]) {
    const dir = profileDir(name);
    if (!existsSync(dir)) {
      record(sec, 'warn', `profile ${name} missing`, 'not initialized', `dsh ${name} --from-default-profile ${name === 'sdlc-worker' ? 'headless' : 'web'}`);
      continue;
    }
    const bundles = readProfileBundles(name);
    if (!bundles) {
      record(sec, 'error', `profile ${name} package.json unreadable`);
      continue;
    }
    const headless = name === 'sdlc-worker';
    const wants = [...(headless ? ['@deepseek-ai/dsh-headless'] : []), ...required];
    const missing = wants.filter((b) => !bundles.includes(b));
    if (missing.length === 0) {
      record(sec, 'ok', `profile ${name}`, `${bundles.length} bundles`);
    } else {
      record(
        sec,
        'error',
        `profile ${name} missing bundles`,
        missing.join(', '),
        `dsh plugin --profile ${name} add <package dirs>`,
      );
    }
    // The lead must select exactly ONE sdlc bundle. A beta.1 profile selected
    // the meta-bundle AND its four members: harmless while the meta-bundle's
    // patch held a single row, but since that patch became the union of its
    // members' rows it composes every row twice.
    const extra = bundles.filter((b) => isOwnBundleName(b) && !required.includes(b));
    if (extra.length) {
      record(
        sec,
        'error',
        `profile ${name} selects extra sdlc bundles`,
        extra.join(', '),
        `node scripts/install-local.mjs  # re-selects only the recipe's bundles (or remove them with: dsh plugin --profile ${name} remove <pkg>)`,
      );
    }
    const compat = join(dir, 'compatibility.json');
    if (existsSync(compat)) record(sec, 'warn', `${name} has version exemptions`, readFileSync(compat, 'utf8').slice(0, 200));
  }
}

// ── Project ────────────────────────────────────────────────────────────────

function checkProject() {
  const sec = 'Project';
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: PROJECT });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    record(sec, 'error', 'not a git repository', PROJECT, 'Run inside a git repo; worktrees and the integration branch require it');
    return;
  }
  record(sec, 'ok', 'git repository');
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT });
  if (sha.ok) record(sec, 'ok', `HEAD ${sha.stdout.trim()}`);

  if (!existsSync(SDLC_DIR)) {
    record(sec, 'warn', '.sdlc/ not initialized', '', 'sdlc init   (or /sdlc init in an interactive session)');
    if (FIX) {
      try {
        for (const d of ['worktrees', 'recovery', 'verification', 'config', 'tiers']) {
          mkdirSync(join(SDLC_DIR, d), { recursive: true });
        }
        record(sec, 'ok', 'created .sdlc/ tree', 'run `sdlc init` to add config, gates and the integration branch');
      } catch (e) {
        record(sec, 'error', 'could not create .sdlc/', e.message);
      }
    }
    return;
  }
  record(sec, 'ok', '.sdlc/ present');

  const branch = run('git', ['rev-parse', '--verify', '--quiet', 'sdlc/integration'], { cwd: PROJECT });
  if (branch.ok) record(sec, 'ok', 'integration branch sdlc/integration');
  else record(sec, 'warn', 'no sdlc/integration branch', '', 'sdlc init');

  const ignore = join(PROJECT, '.gitignore');
  const needed = ['.sdlc/worktrees/', '.sdlc/recovery/', '.sdlc/verification/', '.sdlc/sdlc.db'];
  const text = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const missing = needed.filter((n) => !text.includes(n));
  if (missing.length === 0) {
    record(sec, 'ok', '.gitignore covers .sdlc runtime paths');
  } else {
    record(sec, 'warn', '.gitignore missing entries', missing.join(' '), 'sdlc init --fix');
    if (FIX) {
      appendFileSync(ignore, `\n# SDLC orchestrator runtime\n${missing.join('\n')}\n`);
      record(sec, 'ok', 'appended .gitignore entries');
    }
  }

  const cfg = join(SDLC_DIR, 'config.yml');
  if (existsSync(cfg)) record(sec, 'ok', '.sdlc/config.yml');
  else record(sec, 'warn', 'no .sdlc/config.yml', 'plugin defaults apply', 'sdlc config init');
}

// ── Config: tiers + price table ────────────────────────────────────────────

function checkModels() {
  const sec = 'Models';
  const cfg = join(SDLC_DIR, 'config.yml');
  if (!existsSync(cfg)) {
    record(sec, 'skip', 'no project config', 'tier configuration not validated');
    return;
  }
  const text = readFileSync(cfg, 'utf8');
  for (const tier of ['cheap', 'base', 'elevated']) {
    const re = new RegExp(`^\\s*${tier}\\s*:`, 'm');
    if (re.test(text)) record(sec, 'ok', `${tier} tier configured`);
    else
      record(
        sec,
        tier === 'elevated' ? 'warn' : 'error',
        `${tier} tier missing`,
        tier === 'elevated' ? 'escalations will fail' : 'required for routing',
        `sdlc config set tiers.${tier}[0].model <provider>/<model>`,
      );
  }
  const models = [...text.matchAll(/^\s*-?\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/gm)].map((m) => `${m[1]}/${m[2]}`);
  const priced = [...text.matchAll(/^\s{2}([a-z0-9-]+\/[A-Za-z0-9._-]+):\s*\{/gm)].map((m) => m[1]);
  const unpriced = models.filter((m) => priced.length && !priced.includes(m));
  if (models.length && unpriced.length) {
    record(sec, 'error', 'price table incomplete', unpriced.join(', '), 'Cost routing needs estimated_cost per 1M tokens for every routed model');
  } else if (models.length) {
    record(sec, 'ok', `price table covers ${models.length} routed models`);
  }
}

// ── report ─────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString();
checkPlatform();
checkHome();
checkProfiles();
checkProject();
checkModels();

if (!QUIET) {
  console.log('\nSDLC Orchestrator — environment doctor');
  console.log('=====================================\n');
  console.log(`  DSH_HOME : ${DSH_HOME}`);
  console.log(`  PROJECT  : ${PROJECT}\n`);
}
const marks = { ok: 'OK   ', warn: 'WARN ', error: 'ERROR', skip: 'SKIP ' };
for (const [name, rows] of sections) {
  if (!QUIET) console.log(`${name}`);
  for (const r of rows) {
    if (!QUIET) console.log(`  ${marks[r.level]} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
    if (r.fixHint && r.level !== 'ok' && !QUIET) console.log(`        fix: ${r.fixHint}`);
  }
  if (!QUIET) console.log('');
}

const report = { tool: 'sdlc-doctor', version: '1.0.0', startedAt, dshHome: DSH_HOME, project: PROJECT, errors, warnings, sections: Object.fromEntries(sections) };
if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n');
}

if (!QUIET) {
  console.log(`  ${errors} error(s), ${warnings} warning(s).`);
  console.log(errors === 0 ? '  Doctor: PASS\n' : '  Doctor: FAIL — fix the errors above and re-run.\n');
}

process.exit(errors === 0 ? 0 : 1);
