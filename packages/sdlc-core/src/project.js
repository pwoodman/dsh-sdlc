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
  const res = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * @param {object} input
 * @param {string} input.projectRoot
 * @param {(argv:string[],opts:object)=>object} [input.git]  injected git runner
 * @param {boolean} [input.force]
 * @param {boolean} [input.reconfigure]
 * @param {object} [input.config]
 */
export function initProject({
  projectRoot = process.cwd(),
  git = defaultGitRunner,
  force = false,
  reconfigure = false,
  config = DEFAULT_CONFIG,
  now = () => new Date().toISOString(),
  createBranch = true,
} = {}) {
  const steps = [];
  const sdlcDir = join(projectRoot, '.sdlc');

  // 1. tree
  for (const dir of SDLC_TREE) mkdirSync(join(projectRoot, dir), { recursive: true });
  steps.push({ step: 'tree', status: 'ok' });

  // 2. gate command detection — BEFORE any repository mutation. A bootstrap
  // that cannot describe the workspace must leave the user's git repo
  // untouched (auto-setup runs on reads: the panel's first GET, `sdlc
  // status`), so no integration branch is created on the failure path.
  const rootFiles = (() => { try { return readdirSync(projectRoot); } catch { return []; } })();
  const stack = detectStack(rootFiles);
  const packageJson = readJson(join(projectRoot, 'package.json'));
  const playwright = detectPlaywright(packageJson);
  const detected = detectGateCommands({ stack, packageJson, playwright });
  if (!detected) {
    return {
      ok: false,
      error: 'UNRECOGNISED_STACK',
      message: 'no recognised stack marker (pnpm-lock.yaml, package-lock.json, pyproject.toml, go.mod, Cargo.toml); '
        + 'set verification.detection: manual and author verification.gates explicitly — init never guesses',
      steps,
    };
  }
  steps.push({ step: 'gate-detection', stack, bootstrap: detected.bootstrap });

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

  // 5. .gitignore
  const gitignorePath = join(projectRoot, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length) {
    const block = `${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n# SDLC orchestrator\n${missing.join('\n')}\n`;
    writeFileSync(gitignorePath, existing + block);
  }
  steps.push({ step: 'gitignore', added: missing.length });

  // 6. config.yml
  const configPath = join(sdlcDir, 'config.yml');
  const configExisted = existsSync(configPath);
  if (!configExisted || force || reconfigure) {
    const merged = {
      ...config,
      verification: {
        ...config.verification,
        detection: 'auto',
        gates: detected.gates,
        skipWhen: detected.skipWhen,
      },
      execution: { ...config.execution, bootstrapCommands: detected.bootstrap },
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
    playwright,
    integration,
    gateCommands: detected.gates,
    bootstrap: detected.bootstrap,
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
 * "run `sdlc init`" wall on a workspace the Harness can already describe.
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
  const result = initProject({ projectRoot, git, config, now });
  return { ...result, existed: false };
}

/** Print-friendly summary used by the CLI and the installer. */
export function describeProject(result) {
  if (!result.ok) return `init failed: ${result.message}`;
  const lines = [
    `stack        : ${result.stack}${result.playwright ? ' (+playwright)' : ''}`,
    `integration  : ${result.integration.created ? 'created' : result.integration.reason}`,
    `bootstrap    : ${result.bootstrap.join(' ')}`,
    'gates        :',
  ];
  for (const [gate, spec] of Object.entries(result.gateCommands)) {
    lines.push(`  ${gate.padEnd(12)} ${spec.command ? spec.command.join(' ') : spec.kind}`);
  }
  lines.push(`config       : ${result.configPath}`);
  lines.push(`next         : ${result.next}`);
  return lines.join('\n');
}

export default { initProject, ensureProject, describeProject, defaultGitRunner, GITIGNORE_ENTRIES, SDLC_TREE };
