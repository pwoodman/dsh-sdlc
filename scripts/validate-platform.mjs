#!/usr/bin/env node
/**
 * scripts/validate-platform.mjs
 *
 * Deterministic validation of every DSH platform fact the orchestrator spec
 * depends on. This suite runs BEFORE any orchestrator package exists and needs
 * NO LLM, NO network, and NO provider key. It replaces the LLM-dependent checks
 * (3, 4, 5, 6) in spec v2's C.8.1 script with evidence-based probes.
 *
 * Exit 0 = every required check passed. Exit 1 = at least one failed.
 *   node scripts/validate-platform.mjs [check-id-substring...]
 *     --json <path>   write an evidence bundle
 *     --fail-fast     stop at the first failure
 *
 * Ground truth verified against @deepseek-ai/dsh 0.2.0-rc.2; see
 * SDLC_SPEC_V3_VALIDATION_REPORT.md for the claim -> check traceability.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runSuite, run, must, tempDir, withTempDir, EXIT } from './lib/harness.mjs';
import { DSH_PEER_RANGE, dshPeerSatisfied } from './lib/semver-lite.mjs';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR_FOR_SQLITE = 5; // node:sqlite is unflagged from 22.5.0

// ── helpers ────────────────────────────────────────────────────────────────

/** Resolve the directory of the running `dsh` package, wherever it is installed. */
function findDshPackageDir() {
  const which = run('sh', ['-c', 'command -v dsh']);
  if (!which.ok || !which.stdout.trim()) return null;
  let p = which.stdout.trim();
  try {
    p = execFileSync('realpath', [p], { encoding: 'utf8' }).trim();
  } catch {
    /* keep unresolved path */
  }
  let dir = dirname(p);
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === '@deepseek-ai/dsh') return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Parse `--dump-config` YAML into the row list without a YAML dependency. */
function parseDumpConfig(text) {
  const bundles = [];
  const rows = [];
  let current = null;
  let inConfig = false;
  let configIndent = -1;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const bundleHeader = line.match(/^#\s*==\s*(.+)$/);
    if (bundleHeader) {
      bundles.push(bundleHeader[1].trim());
      current = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const idMatch = line.match(/^(\s*)-\s+id:\s*(.+)$/);
    if (idMatch && indent === 0) {
      const id = idMatch[2].trim().replace(/^['"]|['"]$/g, '');
      // nested plugin rows inside a preset config are deeper-indented; only
      // top-level loader rows are collected.
      current = { id, lines: [line] };
      rows.push(current);
      inConfig = false;
      continue;
    }
    if (current) current.lines.push(line);
    if (line.match(/^(\s*)config:\s*$/)) {
      inConfig = true;
      configIndent = indent;
      continue;
    }
    if (inConfig && indent <= configIndent && !line.startsWith(' ')) inConfig = false;
  }
  return { bundles, rows };
}

function rowById(rows, id) {
  return rows.filter((r) => r.id === id);
}

function readRowConfig(rows, id) {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const out = {};
  let inConfig = false;
  let baseIndent = -1;
  for (const line of row.lines) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      baseIndent = indent;
      continue;
    }
    if (!inConfig) continue;
    if (indent <= baseIndent) break;
    const kv = line.trim().match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** Run dsh with an isolated DSH_HOME so probes never touch the user's profiles. */
function dshDumpConfig(home, profile, extraArgs = []) {
  return run('dsh', ['--profile', profile, '--dump-config', ...extraArgs], {
    env: { DSH_HOME: home },
    timeoutMs: 180_000,
  });
}

// ── checks ─────────────────────────────────────────────────────────────────

const dshDir = findDshPackageDir();
// dshDir = <...>/node_modules/@deepseek-ai/dsh ; sibling packages live beside it.
const dshInstallRoot = dshDir ? dirname(dshDir) : null;

const checks = [
  {
    id: 'PLAT-00-node',
    title: 'Node.js >= 22.5 (node:sqlite unflagged)',
    fn() {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR_FOR_SQLITE)) {
        throw new Error(`Node ${process.version} is too old; need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR_FOR_SQLITE}`);
      }
      return { detail: `Node ${process.version}` };
    },
  },
  {
    id: 'PLAT-01-sqlite',
    title: 'node:sqlite DatabaseSync usable (storage binding)',
    async fn() {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec('create table t(id integer primary key, v text)');
      db.prepare('insert into t(v) values (?)').run('x');
      const row = db.prepare('select v from t').get();
      db.close();
      if (row.v !== 'x') throw new Error('round-trip mismatch');
      return { detail: 'DatabaseSync round-trip ok' };
    },
  },
  {
    id: 'PLAT-02-git',
    title: 'git present and >= 2.30 (merge-tree/worktree)',
    fn() {
      const res = must('git', ['--version']);
      const m = res.stdout.match(/(\d+)\.(\d+)/);
      if (!m) throw new Error(`unparsable: ${res.stdout}`);
      if (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 30)) {
        throw new Error(`git ${m[1]}.${m[2]} too old; need >= 2.30`);
      }
      return { detail: res.stdout.trim() };
    },
  },
  {
    id: 'PLAT-03-worktree',
    title: 'git worktree add/remove works (B.10 lifecycle)',
    fn() {
      return withTempDir('sdlc-wt-', (dir) => {
        must('git', ['init', '-q', '-b', 'main'], { cwd: dir });
        must('git', ['config', 'user.email', 'v@test'], { cwd: dir });
        must('git', ['config', 'user.name', 'v'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), '# t\n');
        must('git', ['add', '-A'], { cwd: dir });
        must('git', ['commit', '-qm', 'init'], { cwd: dir });
        const wt = join(dir, '.sdlc', 'worktrees', 'T-1');
        mkdirSync(dirname(wt), { recursive: true });
        must('git', ['worktree', 'add', wt, '-b', 'sdlc/task-T-1', 'main'], { cwd: dir });
        if (!existsSync(join(wt, 'README.md'))) throw new Error('worktree not populated');
        must('git', ['worktree', 'remove', '--force', wt], { cwd: dir });
        return { detail: 'worktree add + remove ok' };
      });
    },
  },
  {
    id: 'PLAT-04-pnpm',
    title: 'pnpm available for `dsh plugin` (advisory)',
    fn() {
      const res = run('pnpm', ['--version']);
      if (!res.ok) {
        return { skip: 'pnpm not on PATH — `dsh plugin add` will fail; install with `npm i -g pnpm` or `corepack enable pnpm` (corepack is absent on this machine too)' };
      }
      return { detail: `pnpm ${res.stdout.trim()}` };
    },
  },
  {
    id: 'PLAT-05-dsh',
    title: `dsh CLI present and within the declared peer range ${DSH_PEER_RANGE}`,
    fn() {
      const res = run('dsh', ['--version']);
      if (!res.ok) throw new Error('dsh not on PATH');
      const actual = res.stdout.trim().replace(/^v/, '');
      if (!dshPeerSatisfied(actual)) {
        throw new Error(`dsh ${actual} is outside the peer range ${DSH_PEER_RANGE}; peerDependencies enforcement keys off the runtime version (P36, beta.2)`);
      }
      return { detail: `dsh ${actual}` };
    },
  },
  {
    id: 'PLAT-06-launcher',
    title: 'launcher exposes --patch/--dump-config/--from-default-profile',
    fn() {
      const help = must('dsh', ['--help']).stdout;
      for (const flag of ['--patch <path>', '--dump-config', '--dump-config-schema', '--from-default-profile']) {
        if (!help.includes(flag)) throw new Error(`missing launcher flag: ${flag}`);
      }
      if (/--headless\b/.test(help.split('Examples:')[0])) {
        throw new Error('launcher unexpectedly advertises --headless as a flag');
      }
      return { detail: 'flags present; --headless is NOT a launcher flag (v2 errata E1)' };
    },
  },
  {
    id: 'PLAT-07-plugin-cmd',
    title: '`dsh plugin --profile <name> <pnpm args>` surface exists',
    fn() {
      const help = must('dsh', ['--help']).stdout;
      if (!help.includes('dsh plugin --profile <name> <pnpm-args...>')) {
        throw new Error('plugin command usage not found in dsh --help');
      }
      if (!help.includes('version-exemptions') && !help.includes('add <package>')) {
        throw new Error('plugin examples missing');
      }
      return { detail: 'plugin passthrough documented' };
    },
  },
  {
    id: 'PLAT-08-shutdown-templates',
    title: 'shipped profile templates are base/web/headless/acp/sdk (not plugin-extensible)',
    fn() {
      if (!dshDir) throw new Error('cannot locate the dsh package directory');
      const boot = join(dirname(dshDir), 'dsh-app-boot', 'lib', 'index.js');
      if (!existsSync(boot)) return { skip: 'dsh-app-boot not resolvable beside dsh' };
      const src = readFileSync(boot, 'utf8');
      const m = src.match(/const PROFILE_TEMPLATES = \{([\s\S]*?)\n\};/);
      if (!m) throw new Error('PROFILE_TEMPLATES not found');
      const names = [...m[1].matchAll(/^\s*"?([a-z-]+)"?:\s*\{/gm)].map((x) => x[1]);
      for (const n of ['web', 'headless']) {
        if (!names.includes(n)) throw new Error(`shipped template "${n}" missing`);
      }
      if (names.some((n) => n.startsWith('sdlc'))) {
        throw new Error('sdlc* appears in shipped templates — profile templates are NOT plugin-extensible (v2 errata E2)');
      }
      return { detail: `shipped templates: ${names.join(', ')}` };
    },
  },
  {
    id: 'PLAT-09-autocreate',
    title: 'a custom profile auto-initializes on first --dump-config',
    fn() {
      return withTempDir('sdlc-home-', (home) => {
        const res = dshDumpConfig(home, 'web');
        if (!res.ok) throw new Error(`dump-config failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
        if (!res.stdout.includes('# == @deepseek-ai/dsh-base')) {
          throw new Error('bundle provenance headers absent from dump-config');
        }
        if (!existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml'))) {
          throw new Error('profile directory not created');
        }
        return { detail: 'auto-init + dump-config ok' };
      });
    },
  },
  {
    id: 'PLAT-10-determinism',
    title: 'dump-config is byte-identical across runs (composition determinism)',
    fn() {
      return withTempDir('sdlc-home-', (home) => {
        dshDumpConfig(home, 'web');
        const a = dshDumpConfig(home, 'web').stdout;
        const b = dshDumpConfig(home, 'web').stdout;
        if (a !== b) throw new Error('dump-config output differs between runs');
        return { detail: `${a.length} bytes stable` };
      });
    },
  },
  {
    id: 'PLAT-11-patch-overlay',
    title: '--patch id-overlay replaces a row config (P35/P1)',
    fn() {
      return withTempDir('sdlc-home-', (home) => {
        const overlay = join(home, 'tier.yml');
        writeFileSync(
          overlay,
          "- id: agent-default-model\n  config:\n    provider: __sdlc_probe__\n    model: __sdlc_probe_model__\n",
        );
        dshDumpConfig(home, 'web');
        const base = parseDumpConfig(dshDumpConfig(home, 'web').stdout);
        const patched = parseDumpConfig(dshDumpConfig(home, 'web', ['--patch', overlay]).stdout);
        const before = readRowConfig(base.rows, 'agent-default-model');
        const after = readRowConfig(patched.rows, 'agent-default-model');
        if (before.provider !== 'deepseek-official') throw new Error(`unexpected baseline provider ${before.provider}`);
        if (after.provider !== '__sdlc_probe__' || after.model !== '__sdlc_probe_model__') {
          throw new Error(`overlay did not win: ${JSON.stringify(after)}`);
        }
        return { detail: `tier overlay overrides ${before.provider} -> ${after.provider}` };
      });
    },
  },
  {
    id: 'PLAT-12-no-dup-rows',
    title: 'id-overlay does not duplicate the row (insert-form is wrong)',
    fn() {
      return withTempDir('sdlc-home-', (home) => {
        const idOverlay = join(home, 'id.yml');
        writeFileSync(idOverlay, "- id: agent-default-model\n  config:\n    provider: __p__\n    model: __m__\n");
        const insertOverlay = join(home, 'insert.yml');
        writeFileSync(
          insertOverlay,
          "- insert:\n    - id: agent-default-model\n      name: '@deepseek-ai/dsh-agent-default-model'\n      config:\n        provider: __p__\n        model: __m__\n",
        );
        dshDumpConfig(home, 'web');
        const idRows = parseDumpConfig(dshDumpConfig(home, 'web', ['--patch', idOverlay]).stdout);
        const insRows = parseDumpConfig(dshDumpConfig(home, 'web', ['--patch', insertOverlay]).stdout);
        const idCount = rowById(idRows.rows, 'agent-default-model').length;
        const insCount = rowById(insRows.rows, 'agent-default-model').length;
        if (idCount !== 1) throw new Error(`id-overlay produced ${idCount} rows (expected 1)`);
        if (insCount <= 1) {
          throw new Error('expected insert-form to duplicate; platform behaviour changed — revisit errata E4');
        }
        return { detail: `id-overlay=1 row, insert-form=${insCount} rows (v2 C.8.1 check 5 used the wrong form)` };
      });
    },
  },
  {
    id: 'PLAT-13-json-stream',
    title: 'headless bundle ships the documented --json event vocabulary',
    fn() {
      if (!dshInstallRoot) return { skip: 'dsh install root not resolvable' };
      const pkg = join(dshInstallRoot, 'dsh-headless', 'package.json');
      if (!existsSync(pkg)) return { skip: 'dsh-headless not installed beside dsh' };
      const manifest = JSON.parse(readFileSync(pkg, 'utf8'));
      const patches = Array.isArray(manifest.dsh?.bundle?.patch) ? manifest.dsh.bundle.patch : [manifest.dsh?.bundle?.patch];
      if (!patches.includes('./cordis.patch.yml')) throw new Error('headless bundle patch declaration missing');
      const startup = join(dshInstallRoot, 'dsh-headless', 'lib', 'startup.js');
      if (existsSync(startup)) {
        const src = readFileSync(startup, 'utf8');
        for (const opt of ['--json', '--session-id']) {
          if (!src.includes(opt)) throw new Error(`headless startup missing ${opt}`);
        }
      }
      return { detail: 'dsh-headless present; --json/--session-id declared' };
    },
  },
  {
    id: 'PLAT-14-bundle-patch-list',
    title: 'a bundle may declare an ordered LIST of patch files (P1 correction)',
    fn() {
      if (!dshInstallRoot) return { skip: 'dsh install root not resolvable' };
      const manifestPath = join(dshInstallRoot, 'dsh-web-app', 'package.json');
      if (!existsSync(manifestPath)) return { skip: 'dsh-web-app not installed beside dsh' };
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const patch = manifest.dsh?.bundle?.patch;
      if (!Array.isArray(patch) || patch.length < 2) {
        throw new Error('expected dsh-web-app to declare a multi-file bundle patch list');
      }
      return { detail: `dsh-web-app declares ${patch.length} ordered patch files` };
    },
  },
  {
    id: 'PLAT-15-node-test',
    title: 'node:test runner + coverage flags available (G.1)',
    fn() {
      return withTempDir('sdlc-test-', (dir) => {
        writeFileSync(join(dir, 'a.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert/strict';test('x',()=>assert.equal(1,1));\n");
        const res = run('node', ['--test', '--experimental-test-coverage', 'a.test.mjs'], { cwd: dir, timeoutMs: 60_000 });
        if (!res.ok) throw new Error(`node --test failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
        if (!/# tests 1|tests 1/.test(res.stdout)) throw new Error('runner did not report the test');
        return { detail: 'node --test + --experimental-test-coverage ok' };
      });
    },
  },
  {
    id: 'PLAT-16-subprocess-scrub',
    title: 'credential env scrub behaviour is known (worker auth must be explicit)',
    fn() {
      if (!dshInstallRoot) return { skip: 'dsh install root not resolvable' };
      const idx = join(dshInstallRoot, 'dsh-subprocess', 'lib', 'index.js');
      if (!existsSync(idx)) return { skip: 'dsh-subprocess not installed beside dsh' };
      const src = readFileSync(idx, 'utf8');
      const m = src.match(/SENSITIVE_ENV_PATTERN\s*=\s*(\/[^;]+\/[a-z]*)/);
      if (!m) throw new Error('SENSITIVE_ENV_PATTERN not found — scrub contract changed');
      const literal = m[1];
      if (!literal.includes('KEY') || !literal.includes('TOKEN') || !literal.includes('SECRET')) {
        throw new Error(`scrub pattern changed to ${literal} — re-audit worker credential policy`);
      }
      if (!src.includes('"DSH_".toUpperCase') && !src.includes("'DSH_'") && !/DSH_/.test(src)) {
        throw new Error('DSH_* passthrough rule not found');
      }
      // Both named provider keys contain KEY, so the shipped scrub strips them.
      const srcTypes = join(dshInstallRoot, 'dsh-subprocess', 'lib', 'types', 'types.d.ts');
      const hasPassthrough = existsSync(srcTypes) && readFileSync(srcTypes, 'utf8').includes('Explicit environment entries');
      return {
        detail: `scrub ${literal} strips OPENAI_API_KEY/DEEPSEEK_API_KEY/DSH_*; explicit per-spawn env passthrough ${hasPassthrough ? 'documented' : 'NOT documented'}`,
      };
    },
  },
  {
    id: 'PLAT-17-tmp-writable',
    title: 'temp workspace is writable with room for worktrees',
    fn() {
      return withTempDir('sdlc-tmp-', (dir) => {
        writeFileSync(join(dir, 'probe'), 'x'.repeat(4096));
        return { detail: `${dir} writable` };
      });
    },
  },
];

process.exit(await runSuite({ name: 'SDLC platform validation', version: '1.0.0', checks }));
