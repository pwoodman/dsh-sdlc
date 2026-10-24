/**
 * packages/sdlc-core/src/project.js — project setup (spec v3 F.4, F.5, F.6).
 *
 * `sdlc init` inside a git repository. Every step is idempotent; the installer
 * is safe to re-run. `detection: auto` writes CONCRETE runnable gate commands
 * (F.5) and FAILS rather than guessing when the stack is unrecognised.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openDatabase } from './schema.js';
import { detectStack, detectGateCommands, detectPlaywright } from './gates.js';
import { DEFAULT_CONFIG, dumpConfigYaml } from './config.js';
import { hostModelBootstrap } from './host-model.js';

export const SDLC_TREE = [
  '.sdlc',
  '.sdlc/backup',
  '.sdlc/config',
  '.sdlc/tiers',
  '.sdlc/worktrees',
  '.sdlc/recovery',
  '.sdlc/verification',
];

export const GITIGNORE_ENTRIES = [
  '.sdlc/worktrees/',
  '.sdlc/recovery/',
  '.sdlc/verification/',
  '.sdlc/sdlc.db',
  '.sdlc/sdlc.db-*',
  '.sdlc/sdlc.lock',
  '.sdlc/backup/',
  '.validation/',
];

export const INTEGRATION_BRANCH = 'sdlc/integration';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function defaultGitRunner(argv, { cwd } = {}) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    // Production twin of the tests/lib/helpers.mjs widening (Oct 2026):
    // `sdlc init` shells out to `git`, and headless/worker environments
    // (Node 22 multi-file test workers, minimal containers) may not carry
    // the binary's directory on PATH. Widen once here so init never becomes
    // ENOENT flakiness. Injected runners (tests) bypass this entirely.
    env: widenedEnv(),
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Search path for shell-outs (`git` today): binary dir + inherited + standard. */
export function widenedEnv(extra = {}) {
  if (extra.PATH !== undefined) return { ...process.env, ...extra };
  const execDir = typeof process.execPath === 'string' && process.execPath.includes('/')
    ? process.execPath.slice(0, process.execPath.lastIndexOf('/'))
    : null;
  const parts = [
    execDir,
    process.env.PATH,
    '/usr/bin',
    '/bin',
    '/usr/local/bin',
    '/app/bin',
  ].filter(Boolean);
  return { ...process.env, ...extra, PATH: [...new Set(parts)].join(':') };
}

/**
 * @param {object} input
 * @param {string} input.projectRoot
 * @param {(argv:string[],opts:object)=>object} [input.git]  injected git runner
 * @param {boolean} [input.force]
 * @param {boolean} [input.reconfigure]
 * @param {object} [input.config]
 * @param {'fail'|'manual'} [input.undetected] - what to do when no stack marker
 *   is recognised. `'fail'` (the default, and always the explicit
 *   `sdlc init`) refuses to guess gate commands. `'manual'` is the auto-setup
 *   mode: the project is created anyway with `verification.detection: manual`
 *   and EMPTY gates — the panel works, the config itself says verification is
 *   the user's to author, and validation warns until gates are written.
 *   Nothing is guessed in either mode.
 */
export function initProject({
  projectRoot = process.cwd(),
  git = defaultGitRunner,
  force = false,
  reconfigure = false,
  config = DEFAULT_CONFIG,
  now = () => new Date().toISOString(),
  createBranch = true,
  undetected = 'fail',
} = {}) {
  const steps = [];
  const sdlcDir = join(projectRoot, '.sdlc');

  // 1. tree
  for (const dir of SDLC_TREE) mkdirSync(join(projectRoot, dir), { recursive: true });
  steps.push({ step: 'tree', status: 'ok' });

  // 2. gate command detection — before the branch so an explicit `sdlc init`
  // that cannot describe the workspace leaves the user's git repo untouched.
  const rootFiles = (() => { try { return readdirSync(projectRoot); } catch { return []; } })();
  const stack = detectStack(rootFiles);
  const packageJson = readJson(join(projectRoot, 'package.json'));
  const playwright = detectPlaywright(packageJson);
  const detected = detectGateCommands({ stack, packageJson, playwright });
  const manual = !detected && undetected === 'manual';
  if (!detected && !manual) {
    return {
      ok: false,
      error: 'UNRECOGNISED_STACK',
      message: 'no recognised stack marker (pnpm-lock.yaml, package-lock.json, pyproject.toml/setup.py/requirements.txt, go.mod, Cargo.toml); '
        + 'set verification.detection: manual and author verification.gates explicitly — init never guesses '
        + '(auto-setup via the panel or `sdlc status` does this for you)',
      steps,
    };
  }
  steps.push(manual
    ? { step: 'gate-detection', stack: null, manual: true }
    : { step: 'gate-detection', stack, bootstrap: detected.bootstrap });

  // 3. integration branch from HEAD
  const insideRepo = existsSync(join(projectRoot, '.git'));
  let integration = { created: false, reason: null };
  const headExists = insideRepo
    ? git(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: projectRoot }).status === 0
    : false;
  if (insideRepo && createBranch && !headExists) {
    // A repository with no commits has no HEAD to branch from. Not an error:
    // `sdlc init` still prepares .sdlc/, and the branch is created on the next
    // run after the first commit.
    integration = { created: false, reason: 'empty-repository' };
  } else if (insideRepo && createBranch) {
    const exists = git(['git', 'rev-parse', '--verify', '--quiet', INTEGRATION_BRANCH], { cwd: projectRoot });
    if (exists.status === 0) {
      integration = { created: false, reason: 'exists' };
    } else {
      const res = git(['git', 'branch', INTEGRATION_BRANCH, 'HEAD'], { cwd: projectRoot });
      integration = res.status === 0
        ? { created: true }
        : { created: false, reason: res.stderr.trim() || 'git branch failed' };
    }
  } else {
    integration = { created: false, reason: insideRepo ? 'disabled' : 'not-a-git-repo' };
  }
  steps.push({ step: 'integration-branch', ...integration });

  // 4. database + schema
  const dbPath = join(projectRoot, config.storage?.dbPath ?? '.sdlc/sdlc.db');
  const db = openDatabase(dbPath, { requireQuickCheck: false });
  db.close();
  steps.push({ step: 'database', path: dbPath });

  // 5. .gitignore — only inside a git repository: auto-setup must not drop a
  // .gitignore into a plain folder the user merely opened a session in.
  const gitignorePath = join(projectRoot, '.gitignore');
  if (insideRepo) {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const present = new Set(existing.split('\n').map((l) => l.trim()));
    const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
    if (missing.length) {
      const block = `${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n# SDLC orchestrator\n${missing.join('\n')}\n`;
      writeFileSync(gitignorePath, existing + block);
    }
    steps.push({ step: 'gitignore', added: missing.length });
  } else {
    steps.push({ step: 'gitignore', added: 0, skipped: 'not-a-git-repo' });
  }

  // 6. config.yml
  const configPath = join(sdlcDir, 'config.yml');
  const configExisted = existsSync(configPath);
  if (!configExisted || force || reconfigure) {
    const merged = {
      ...config,
      verification: {
        ...config.verification,
        detection: detected ? 'auto' : 'manual',
        gates: detected ? detected.gates : {},
        skipWhen: detected ? detected.skipWhen : (config.verification?.skipWhen ?? {}),
      },
      ...(detected
        ? { execution: { ...config.execution, bootstrapCommands: detected.bootstrap } }
        : { execution: { ...config.execution } }),
    };
    writeFileSync(configPath, dumpConfigYaml(merged));
    steps.push({ step: 'config', status: configExisted ? 'rewritten' : 'written' });
  } else {
    steps.push({ step: 'config', status: 'exists' });
  }

  return {
    ok: true,
    projectRoot,
    stack,
    manual: Boolean(manual),
    playwright,
    integration,
    gateCommands: detected ? detected.gates : {},
    bootstrap: detected ? detected.bootstrap : [],
    configPath,
    dbPath,
    steps,
    next: 'sdlc config validate && dsh --profile sdlc-web',
  };
}

/**
 * Auto-bootstrap: materialise `.sdlc/` on first touch (spec v3 F.4).
 *
 * `sdlc init` is a convenience, not a ritual. The panel, `sdlc status` and
 * `sdlc config use-host-model` all call this first, so a user never meets a
 * "run `sdlc init`" wall — on ANY workspace, not only one with a recognised
 * stack marker: when detection finds nothing, the project is still created
 * with `verification.detection: manual` and empty gates. The honest
 * alternative — a plain folder, a Node project with no lockfile, a
 * requirements.txt Python project — must not be locked out of the product.
 *
 * A FRESH bootstrap adopts the Harness's own provider/model (`hostModel`),
 * so the tiers never name a second account or imply an API key. An EXISTING
 * config is preserved untouched: adopting the host route into a config the
 * user already authored is an explicit action (Settings card / CLI), never a
 * side effect of opening a panel. There is deliberately no force/reconfigure
 * here — rewriting an authored config is `initProject`'s explicit job.
 *
 * The "already complete" marker is config.yml AND the DB — the two halves a
 * project needs. Either half can go missing on its own: a bare `node:sqlite`
 * open (an early `sdlc tasks`) creates a DB-only half-project, and a
 * `git clean -fdx` removes the gitignored DB while keeping config.yml. The
 * next touch must COMPLETE the missing half — initProject is idempotent and
 * preserves an existing config — never treat a half state as done.
 *
 * Idempotent: when a complete project exists this is a no-op (two
 * existsSync calls). When bootstrap fails, `initProject`'s fail-closed
 * contract holds — the tree may be prepared, but no config and no DB are
 * guessed.
 *
 * @param {object} input - as `initProject`, plus:
 * @param {{provider:string,model:string,reasoningEffort?:string|null}} [input.hostModel]
 */
export function ensureProject({
  projectRoot = process.cwd(),
  git = defaultGitRunner,
  hostModel = null,
  now = () => new Date().toISOString(),
} = {}) {
  const sdlcDir = join(projectRoot, '.sdlc');
  const configPath = join(sdlcDir, 'config.yml');
  const dbPath = join(sdlcDir, 'sdlc.db');
  if (existsSync(configPath) && existsSync(dbPath)) {
    return { ok: true, existed: true, projectRoot, configPath, dbPath };
  }
  // A fresh bootstrap names exactly one provider (tiers AND price table); an
  // authored config is never rewritten here.
  const config = hostModel ? hostModelBootstrap(hostModel) : DEFAULT_CONFIG;
  const result = initProject({ projectRoot, git, config, now, undetected: 'manual' });
  return { ...result, existed: false };
}

export function ensureDefaultProject(target, {
  id = 'default',
  name = 'default',
  state = 'DISCOVERY',
  projectRoot = null,
  now = () => new Date().toISOString(),
} = {}) {
  // TRACK 0 — AUTO-ON: the Lead IS the product entry point, so the first
  // Lead touch on an empty workspace materialises one default project row.
  // Idempotent: exactly one row is ever created (fixed id, INSERT OR IGNORE),
  // and a DB that already holds ANY project row — user, foreign/stale,
  // demo seed — is returned untouched. Fail-closed by contract: read-only
  // callers (status, panel snapshot) must never throw, so every failure mode
  // resolves into a report object.
  try {
    const db = target?.db?.prepare ? target.db
      : (typeof target?.prepare === 'function' ? target : null);
    if (!db) return { ok: false, created: false, reason: 'no-db' };
    let count = null;
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
      count = Number(row?.n ?? row?.['COUNT(*)'] ?? NaN);
    } catch (err) {
      return { ok: false, created: false, reason: err?.message ?? 'count-failed' };
    }
    if (Number.isFinite(count) && count > 0) {
      return { ok: true, created: false, count };
    }
    const root = projectRoot ?? target?.projectRoot ?? null;
    const ts = now();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO projects(id, name, repo_path, state, complexity_json, budget_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name ?? id, root, state, null, null, ts, ts);
    } catch (err) {
      return { ok: false, created: false, reason: err?.message ?? 'insert-failed' };
    }
    let project = null;
    try {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) ?? null;
    } catch { project = null; }
    // Best-effort provenance event when a live runtime (with its state
    // service) is the caller. A bare DB handle has no recorder — the row
    // itself is the contract, the event is a nicety. Never throws.
    try {
      const record = target?.state?.record;
      if (typeof record === 'function') {
        record.call(target.state, {
          projectId: id, actor: 'lead', action: 'project-created',
          payload: { name: name ?? id, default: true },
        });
      }
    } catch { /* provenance is best-effort */ }
    return { ok: true, created: true, project: project ?? { id, name: name ?? id } };
  } catch (err) {
    return { ok: false, created: false, reason: err?.message ?? 'unexpected' };
  }
}

/** Print-friendly summary used by the CLI and the installer. */
export function describeProject(result) {
  if (!result.ok) return `init failed: ${result.message}`;
  const lines = [
    `stack        : ${result.stack ?? 'none recognised — verification.detection: manual; author verification.gates'}${result.playwright ? ' (+playwright)' : ''}`,
    `integration  : ${result.integration.created ? 'created' : result.integration.reason}`,
    `bootstrap    : ${result.bootstrap.join(' ') || '(none — no stack detected)'}`,
    'gates        :',
  ];
  if (!Object.keys(result.gateCommands ?? {}).length) {
    lines.push('  (none — author verification.gates to get task verification)');
  }
  for (const [gate, spec] of Object.entries(result.gateCommands)) {
    lines.push(`  ${gate.padEnd(12)} ${spec.command ? spec.command.join(' ') : spec.kind}`);
  }
  lines.push(`config       : ${result.configPath}`);
  lines.push(`next         : ${result.next}`);
  return lines.join('\n');
}

export default { initProject, ensureProject, ensureDefaultProject, describeProject, defaultGitRunner, GITIGNORE_ENTRIES, SDLC_TREE };
