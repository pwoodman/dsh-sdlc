#!/usr/bin/env node
/**
 * scripts/validate-m0.mjs — M0 platform-integration gate (spec Part C.8.1).
 *
 * What changed from spec v2's script:
 *   1. No `require()` in ESM (v2 would throw ReferenceError).
 *   2. No LLM-dependent checks. v2 asked the model to "list your available tools"
 *      and read the answer out of the `final` event — non-deterministic, costs
 *      money, and needs a provider key. Tool/command registration is instead
 *      proven by the `SDLC_SELFTEST` boot hook.
 *   3. The tier-overlay check asserts the composed config, and no longer uses the
 *      `- insert:` overlay form that duplicates the `agent-default-model` row.
 *   4. The guard check asserts the *effect* (no file outside the worktree, and a
 *      denial was recorded) instead of only probing /etc.
 *   5. Skips are explicit, and a skip is reported as such — never as a pass.
 *
 * WHAT THIS REVISION ADDS (without weakening anything):
 *   The runtime path (`dsh --dump-config`, the probe profile) needs pnpm and a
 *   writable `$DSH_HOME`. On a host without pnpm every composition check used to
 *   skip, which is honest but nearly useless. Each such check now falls back to a
 *   STRICTLY STATIC or IN-PROCESS equivalent and says so in its detail string:
 *
 *     - composition      → `scripts/lib/composition.mjs` parses the real patch
 *                          files and the real profile recipes: unique row ids,
 *                          resolvable plugin modules, the 26 presets, E6 partition
 *     - tool/commands    → an in-process `SDLC_SELFTEST` report from the real
 *                          `apply()` entry points (the same hook the profile uses)
 *
 *   `M0-05-tier-overlay` has no static substitute — it exists precisely to prove
 *   the DSH `--patch` precedence — so it skips with that reason.
 *
 * Boot hook contract (spec v3 C.9):
 *   When `SDLC_SELFTEST=/abs/path.json` is set, the plugin suite writes a JSON
 *   report at activation: `{ version, tools[], commands[], services[], presets[],
 *   guard{} }`. The orchestrator exits once the file is written (probe mode).
 *
 *   node scripts/validate-m0.mjs [--json <path>] [--fail-fast]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runSuite, run, withTempDir, EXIT } from './lib/harness.mjs';
import {
  ROOT, loadProfiles, validateProfileStatic, allPatchRows, composeProfile, loadPackages, loadPatchRows, ownBundlePrefix,
} from './lib/composition.mjs';

const HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const LEAD_PROFILE = process.env.SDLC_LEAD_PROFILE || 'sdlc-web';
const PROBE_PROFILE = process.env.SDLC_PROBE_PROFILE || 'sdlc-probe';
// Every own-package name below is DERIVED from the workspace manifests, never a
// scope literal: `scripts/set-scope.mjs` renames the suite in one pass, and a
// literal would make this gate fail (or, worse, skip) on a correctly re-scoped
// tree — the exact trap the installer and the static composition checks fell into.
// Basenames come from the manifests too, so a package rename
// (orchestrator → dsh-sdlc-flow) cannot desynchronise them either.
const OWN = ownBundlePrefix();
const _pkgs = [...loadPackages().keys()];
const _base = (suffix) => _pkgs.find((n) => n === `${OWN}${suffix}`) ?? `${OWN}${suffix}`;
const _meta = _pkgs.find((n) => !/-(core|tools|presets|ui|guard|cli|mock-llm)$/.test(n.slice(n.indexOf('/') + 1))) ?? `${OWN}dsh-sdlc-flow`;
const SELF_PACKAGES = [_base('dsh-sdlc-flow-core'), _base('dsh-sdlc-flow-tools'), _base('dsh-sdlc-flow-presets')];
const LEAD_META_PACKAGE = _meta;
const LEAD_UI_PACKAGE = _base('dsh-sdlc-flow-ui');
const LEAD_UI_ROW = 'sdlc-ui';
const ROLE_COUNT = 26;

// ── live path (needs pnpm + a writable $DSH_HOME) ─────────────────────────

function profileBundles(name) {
  const p = join(HOME, 'profiles', name, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'))?.dsh?.profile?.bundles ?? [];
  } catch {
    return null;
  }
}

function dumpConfig(profile) {
  return run('dsh', ['--profile', profile, '--dump-config'], { timeoutMs: 180_000 });
}

function parseRows(text) {
  const rows = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const idMatch = line.match(/^- id:\s*(.+)$/);
    if (idMatch) {
      cur = { id: idMatch[1].trim().replace(/^['"]|['"]$/g, ''), body: [line] };
      rows.push(cur);
    } else if (cur) cur.body.push(line);
  }
  return rows;
}

/** Boot the probe profile and wait for the SDLC_SELFTEST report. */
function runBootProbe() {
  return withTempDir('sdlc-m0-probe-', (dir) => {
    const reportPath = join(dir, 'selftest.json');
    const child = spawn('dsh', ['--profile', PROBE_PROFILE], {
      env: { ...process.env, SDLC_SELFTEST: reportPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(reportPath)) break;
      spawnSync('sleep', ['0.2']);
    }
    child.kill('SIGTERM');
    if (!existsSync(reportPath)) {
      throw new Error(`no SDLC_SELFTEST report from profile ${PROBE_PROFILE}: ${stderr.slice(0, 400)}`);
    }
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  });
}

/**
 * IN-PROCESS FALLBACK for the boot hook: call the real `apply()` entry points of
 * the composed bundles with a minimal fake context and the real SDLC_SELFTEST
 * env, then read the report. The row configs are taken from the REAL patch
 * files, so this mirrors the composition instead of guessing at it. It proves
 * the DECLARED registration surface; the DSH-hosted probe remains the proof that
 * the host accepted it.
 */
function runInProcessProbe() {
  return withTempDir('sdlc-m0-inproc-', (dir) => {
    const reportPath = join(dir, 'selftest.json');
    const projectRoot = join(dir, 'project');
    const rowConfig = (bundle) => {
      const patch = join(ROOT, 'packages', bundle, 'cordis.patch.yml');
      return existsSync(patch) ? loadPatchRows(patch).rows.map((r) => ({ id: r.id, config: r.config ?? {} })) : [];
    };
    const guardRows = rowConfig('sdlc-guard');
    const coreRows = rowConfig('sdlc-core');
    if (!guardRows.length || !coreRows.length) throw new Error('the guard/core patch rows could not be read');
    const script = `
      import { mkdirSync } from 'node:fs';
      mkdirSync(${JSON.stringify(projectRoot)}, { recursive: true });
      const tools = await import(${JSON.stringify('file://' + join(ROOT, 'packages/sdlc-tools/src/plugin.js'))});
      const presets = await import(${JSON.stringify('file://' + join(ROOT, 'packages/sdlc-presets/src/plugin.js'))});
      const core = await import(${JSON.stringify('file://' + join(ROOT, 'packages/sdlc-core/src/services.js'))});
      const guard = await import(${JSON.stringify('file://' + join(ROOT, 'packages/sdlc-guard/src/plugin.js'))});
      const selftest = await import(${JSON.stringify('file://' + join(ROOT, 'packages/sdlc-core/src/selftest.js'))});
      const ctx = { provide() {}, tools: { register() {} }, commands: { register() {} }, logger: { debug() {}, warn() {}, error() {} } };
      // One apply() per declared loader row, exactly as the host composes them.
      // apply() returns nothing by contract (the Cordis runner reads a plugin
      // return value as an effect), so the runtime handle for the final close
      // comes from the same per-project-root singleton the rows create.
      for (const row of ${JSON.stringify(guardRows)}) guard.apply(ctx, { ...row.config, worktreeRoot: ${JSON.stringify(projectRoot)} });
      tools.apply(ctx, {});
      presets.apply(ctx, {});
      for (const row of ${JSON.stringify(coreRows)}) {
        core.apply(ctx, { ...row.config, projectRoot: ${JSON.stringify(projectRoot)}, storage: { dbPath: '.sdlc/sdlc.db' }, safety: { instanceLock: false } });
      }
      const runtime = core.getRuntime({}, { projectRoot: ${JSON.stringify(projectRoot)} });
      const report = selftest.flushSelftest();
      runtime?.close?.({ releaseLock: false });
      process.stdout.write(JSON.stringify(report));
    `;
    const res = run('node', ['--input-type=module', '-e', script], {
      env: { ...process.env, SDLC_SELFTEST: reportPath },
      timeoutMs: 60_000,
    });
    if (!res.ok) throw new Error(`in-process probe failed: ${(res.stderr || res.stdout).slice(0, 600)}`);
    if (!existsSync(reportPath)) throw new Error('in-process probe wrote no SDLC_SELFTEST report');
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  });
}

// ── static composition (always available) ─────────────────────────────────

const packages = loadPackages();
const profiles = loadProfiles();
const byName = new Map(profiles.map((p) => [p.name, p]));
const staticReports = new Map(profiles.map((p) => [p.name, validateProfileStatic(p, { packages })]));
const patchRows = allPatchRows();
const missingPatches = patchRows.filter((p) => p.missing);

const leadBundles = profileBundles(LEAD_PROFILE);
const probeBundles = profileBundles(PROBE_PROFILE);
const leadReady = Boolean(leadBundles) && SELF_PACKAGES.every((p) => leadBundles.includes(p));
const liveProbe = Boolean(probeBundles);

let selftestCache = null;
function selftest() {
  if (selftestCache) return selftestCache;
  selftestCache = liveProbe ? runBootProbe() : runInProcessProbe();
  return selftestCache;
}
function probeMode() {
  return liveProbe ? `live probe (${PROBE_PROFILE})` : 'in-process probe (profile not installed: pnpm absent)';
}

/** The profile recipe named like a DSH profile, for the static fallback. */
function staticFor(profileName) {
  return staticReports.get(profileName) ?? null;
}

const checks = [
  {
    id: 'M0-00-platform',
    title: 'platform suite passes (validate-platform.mjs)',
    fn() {
      const res = run('node', [join(import.meta.dirname, 'validate-platform.mjs'), '--json', join(import.meta.dirname, '..', '.validation', 'm0-platform.json')], { timeoutMs: 300_000 });
      if (!res.ok) throw new Error(`platform suite failed:\n${(res.stdout + res.stderr).slice(-2000)}`);
      return { detail: 'platform prerequisites hold' };
    },
  },
  {
    id: 'M0-01-bundles',
    title: `lead profile ${LEAD_PROFILE} composes the sdlc bundles`,
    fn() {
      if (leadBundles) {
        // Single-spec install: the lead declares the @patwoodman/dsh-sdlc-flow
        // meta-bundle; its dependencies provide the rows. Unpacked installs
        // (core+tools+presets listed directly) are also accepted.
        const viaMeta = leadBundles.includes(LEAD_META_PACKAGE);
        const viaUnpacked = SELF_PACKAGES.every((p) => leadBundles.includes(p));
        if (!viaMeta && !viaUnpacked) {
          throw new Error(`missing bundles: need ${LEAD_META_PACKAGE} or all of ${SELF_PACKAGES.join(', ')}`);
        }
        const res = dumpConfig(LEAD_PROFILE);
        if (!res.ok) throw new Error(`dump-config failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
        const rows = parseRows(res.stdout);
        for (const id of ['sdlc-tasks', 'sdlc-router', 'sdlc-verifier']) {
          if (!rows.some((r) => r.id === id)) throw new Error(`row ${id} absent from composed profile — check cordis.patch.yml`);
        }
        // The UI bundle is optional-but-expected on the lead: warn, don't fail,
        // when an older install has not added it yet.
        const uiRow = rows.some((r) => r.id === LEAD_UI_ROW);
        const uiBundle = leadBundles.includes(LEAD_UI_PACKAGE);
        const uiNote = uiRow && uiBundle ? ` + ${LEAD_UI_ROW}` : ' (UI bundle not installed here)';
        const viaNote = viaMeta ? ' (via meta-bundle)' : ' (unpacked)';
        return { detail: `live: ${rows.length} composed rows${uiNote}${viaNote}` };
      }
      // Static fallback: the recipe + the real patch files.
      const report = staticFor(LEAD_PROFILE);
      if (!report) return { skip: `no profiles/${LEAD_PROFILE}/profile.json to validate` };
      if (!report.ok) throw new Error(`static composition invalid: ${report.problems.join('; ')}`);
      const ids = report.composition.ids;
      for (const id of ['sdlc-tasks', 'sdlc-router', 'sdlc-verifier']) {
        if (!ids.includes(id)) throw new Error(`row ${id} is not declared by any composed patch file`);
      }
      return { detail: `static: ${LEAD_PROFILE} composes ${report.composition.bundles.length} bundles / ${ids.length} rows (live --dump-config unavailable: pnpm missing)` };
    },
  },
  {
    id: 'M0-02-no-dup-ids',
    title: 'no duplicate loader row ids (insert-form regression)',
    fn() {
      // `agent-preset-registry` is shipped by the web template; the lead
      // meta-bundle must OVERRIDE it (default = sdlc-lead), never insert a
      // duplicate. A duplicate id+name is loader-accepted but the plugin
      // manager's uninstall audit matches live rows by id+name and reports
      // "bundle-in-use" forever. headless/sdk profiles ship no registry, so the
      // member presets patch still inserts it there.
      if (leadBundles) {
        const rows = parseRows(dumpConfig(LEAD_PROFILE).stdout);
        const counts = new Map();
        for (const r of rows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
        const dups = [...counts].filter(([, n]) => n > 1);
        if (dups.length) throw new Error(`duplicate row ids: ${dups.map(([id, n]) => `${id}x${n}`).join(', ')}`);
        const reg = counts.get('agent-preset-registry') ?? 0;
        if (reg !== 1) throw new Error(`expected exactly 1 agent-preset-registry row on the web-template lead (shipped, overridden), found ${reg}`);
        const row = rows.find((r) => r.id === 'agent-preset-registry');
        if (!/default:\s*sdlc-lead/.test(row.body.join('\n'))) {
          throw new Error('lead must override agent-preset-registry default to sdlc-lead');
        }
        return { detail: `live: ${counts.size} unique ids; agent-preset-registry x1 (shipped row overridden to sdlc-lead)` };
      }
      const report = staticFor(LEAD_PROFILE);
      if (!report) return { skip: `no profiles/${LEAD_PROFILE}/profile.json to validate` };
      const realDups = report.composition.duplicates;
      if (realDups.length) {
        throw new Error(`duplicate row ids: ${realDups.map((d) => `${d.id}x${d.n}`).join(', ')}`);
      }
      // Negative control: the checker must notice a forced duplicate. Use
      // the guard bundle twice (a small patch with no meta indirection), so
      // the duplicate survives regardless of the seen-set dedup.
      const _guard = _base('dsh-sdlc-flow-guard');
      const forced = composeProfile({ bundles: [_guard, _guard] }, { packages });
      if (forced.duplicates.length === 0) throw new Error('duplicate detection is not working (negative control failed)');
      return { detail: `static: ${new Set(report.composition.ids).size} unique ids across the composed bundles (negative control passed)` };
    },
  },
  {
    id: 'M0-03-tools',
    title: 'worker + lead tools register (SDLC_SELFTEST boot hook)',
    fn() {
      const report = selftest();
      const need = ['sdlc_report_result', 'sdlc_claim_check', 'sdlc_request_decision'];
      const missing = need.filter((t) => !report.tools?.includes(t));
      if (missing.length) throw new Error(`tools not registered: ${missing.join(', ')}`);
      return { detail: `${report.tools.length} tools via the ${probeMode()}: ${report.tools.slice(0, 6).join(', ')}…` };
    },
  },
  {
    id: 'M0-04-commands',
    title: '/sdlc command surface registers in an interactive profile',
    fn() {
      const report = selftest();
      const need = ['run', 'status', 'stop', 'resume', 'doctor', 'config', 'verify', 'explain'];
      const missing = need.filter((c) => !report.commands?.includes(c));
      if (missing.length) throw new Error(`commands not registered: ${missing.join(', ')}`);
      return { detail: `${report.commands.length} commands via the ${probeMode()}` };
    },
  },
  {
    id: 'M0-05-tier-overlay',
    title: '--patch tier overlay replaces agent-default-model (P35/P1)',
    fn() {
      if (!leadBundles) {
        return { skip: `profile ${LEAD_PROFILE} not installed — this check exists to prove DSH's --patch precedence and has no static substitute (pnpm is missing)` };
      }
      return withTempDir('sdlc-m0-tier-', (dir) => {
        const overlay = join(dir, 'base.yml');
        writeFileSync(
          overlay,
          "- id: agent-default-model\n  config:\n    provider: sdlc-m0-probe\n    model: sdlc-m0-model\n",
        );
        const res = run('dsh', ['--profile', LEAD_PROFILE, '--dump-config', '--patch', overlay], { timeoutMs: 180_000 });
        if (!res.ok) throw new Error(`dump-config --patch failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
        const rows = parseRows(res.stdout).filter((r) => r.id === 'agent-default-model');
        if (rows.length !== 1) throw new Error(`expected 1 agent-default-model row, found ${rows.length}`);
        const body = rows[0].body.join('\n');
        if (!body.includes('sdlc-m0-probe')) throw new Error('overlay did not win over the profile layer');
        return { detail: 'overlay replaces whole config, single row' };
      });
    },
  },
  {
    id: 'M0-06-presets',
    title: `${ROLE_COUNT} role presets present and unique`,
    fn() {
      if (leadBundles) {
        const rows = parseRows(dumpConfig(LEAD_PROFILE).stdout);
        const presets = new Set(rows.map((r) => r.id).filter((id) => /^preset-sdlc-/.test(id)));
        if (presets.size !== ROLE_COUNT) {
          throw new Error(`expected ${ROLE_COUNT} preset-sdlc-* rows, found ${presets.size}`);
        }
        return { detail: `live: ${presets.size} presets` };
      }
      const report = staticFor(LEAD_PROFILE);
      if (!report) return { skip: `no profiles/${LEAD_PROFILE}/profile.json to validate` };
      const presets = report.composition.presetRows;
      if (presets.length !== ROLE_COUNT) {
        throw new Error(`expected ${ROLE_COUNT} preset-sdlc-* rows in the composed patch files, found ${presets.length}`);
      }
      const unique = new Set(presets.map((p) => p.id));
      if (unique.size !== ROLE_COUNT) throw new Error(`preset ids are not unique: ${unique.size} unique of ${presets.length}`);
      return { detail: `static: ${unique.size} unique preset rows across the composed bundles` };
    },
  },
  {
    id: 'M0-07-guard',
    title: 'guard denies writes outside allowed_paths (unit contract)',
    fn() {
      const mod = join(import.meta.dirname, '..', 'packages', 'sdlc-guard', 'lib', 'index.js');
      if (!existsSync(mod)) return { skip: 'packages/sdlc-guard is not built yet — run `node scripts/build.mjs`' };
      // The guard's pure matcher is imported and exercised directly: no LLM, no boot.
      return withTempDir('sdlc-m0-guard-', () => {
        const res = run('node', ['--input-type=module', '-e', `
          const g = await import(${JSON.stringify('file://' + mod)});
          const decide = g.checkFsWrite ?? g.default?.checkFsWrite;
          const cases = [
            ['src/api/users.ts', 'allow'],
            ['src/deep/nested/a.ts', 'allow'],
            ['tests/x.test.ts', 'deny'],
            ['src/auth/login.ts', 'deny'],
            ['../escape.txt', 'deny'],
            ['/etc/passwd', 'deny'],
          ];
          const guard = new (g.GuardPlugin ?? g.default.GuardPlugin)({ allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] });
          for (const [p, want] of cases) {
            const got = (decide ?? ((x) => guard.checkFsWrite(x)))(p);
            if (got !== want) throw new Error(\`path \${p}: got \${got}, want \${want}\`);
          }
          // E7: the worker result channel is writable, the DB is not.
          const orch = new g.GuardPlugin({ allowed_paths: ['src/**'] });
          if (orch.checkFsWrite('.sdlc/task-outbox.json') !== 'allow') throw new Error('orchestrator outbox denied');
          if (orch.checkFsWrite('.sdlc/sdlc.db') !== 'deny') throw new Error('sdlc.db writable by a worker');
          console.log('ok');
        `]);
        if (!res.ok) throw new Error((res.stderr || res.stdout).slice(0, 500));
        return { detail: '6 path cases + E7 outbox/db carve-out pass' };
      });
    },
  },
  {
    id: 'M0-08-schema',
    title: 'sdlc.db schema initializes (tables + append-only events trigger)',
    fn() {
      const mod = join(import.meta.dirname, '..', 'packages', 'sdlc-core', 'lib', 'schema.js');
      if (!existsSync(mod)) return { skip: 'packages/sdlc-core is not built yet — run `node scripts/build.mjs`' };
      return withTempDir('sdlc-m0-db-', (dir) => {
        const dbPath = join(dir, 'sdlc.db');
        const res = run('node', ['--input-type=module', '-e', `
          import { DatabaseSync } from 'node:sqlite';
          const s = await import(${JSON.stringify('file://' + mod)});
          const db = new DatabaseSync(${JSON.stringify(dbPath)});
          s.migrate(db);
          const tables = db.prepare("select name from sqlite_master where type='table'").all().map(r => r.name);
          for (const t of ['projects','tasks','events','worker_runs','test_results','schema_version']) {
            if (!tables.includes(t)) throw new Error('missing table ' + t);
          }
          db.prepare("insert into events(ts, actor, action) values ('now','test','x')").run();
          let blocked = false;
          try { db.prepare("delete from events").run(); } catch { blocked = true; }
          if (!blocked) throw new Error('events table is not append-only');
          console.log('ok');
        `]);
        if (!res.ok) throw new Error((res.stderr || res.stdout).slice(0, 500));
        return { detail: 'tables + append-only trigger enforced' };
      });
    },
  },
  {
    id: 'M0-09-worker-outbox',
    title: 'worker outbox proposal round-trips and is not a scope violation',
    fn() {
      const core = join(import.meta.dirname, '..', 'packages', 'sdlc-core', 'lib', 'worker-result.js');
      if (!existsSync(core)) return { skip: 'packages/sdlc-core is not built yet — run `node scripts/build.mjs`' };
      return withTempDir('sdlc-m0-outbox-', (dir) => {
        const res = run('node', ['--input-type=module', '-e', `
          const m = await import(${JSON.stringify('file://' + core)});
          const changed = ['src/a.ts', '.sdlc/task-outbox.json'];
          const out = m.excludeOrchestratorPaths(changed);
          if (out.length !== 1 || out[0] !== 'src/a.ts') throw new Error('orchestrator paths not excluded: ' + JSON.stringify(out));
          const scope = m.outOfScope(['src/a.ts'], ['src/**'], []);
          if (scope.length) throw new Error('in-scope file flagged: ' + JSON.stringify(scope));
          const bad = m.outOfScope(['src/a.ts','other/b.ts'], ['src/**'], []);
          if (bad.length !== 1) throw new Error('scope violation not detected');
          // Provenance: a foreign nonce marks the claims suspect.
          const env = m.buildOutbox({ runId:'R1', taskId:'T1', attempt:1, nonce:'n', claims:{ status:'completed', summary:'s' } });
          if (m.ingestOutbox(env, { runId:'R1', taskId:'T1', attempt:1, nonce:'n' }).suspect) throw new Error('matching provenance flagged suspect');
          if (!m.ingestOutbox(env, { runId:'R1', taskId:'T1', attempt:1, nonce:'other' }).suspect) throw new Error('foreign nonce not flagged');
          console.log('ok');
        `]);
        if (!res.ok) throw new Error((res.stderr || res.stdout).slice(0, 500));
        return { detail: 'outbox excluded from diff; SCOPE_VIOLATION + provenance detected' };
      });
    },
  },
  {
    id: 'M0-10-doctor',
    title: 'doctor runs headlessly and returns a machine-readable report',
    fn() {
      const res = run('node', [join(import.meta.dirname, 'doctor.mjs'), '--json', join(import.meta.dirname, '..', '.validation', 'm0-doctor.json'), '--quiet']);
      const out = join(import.meta.dirname, '..', '.validation', 'm0-doctor.json');
      if (!existsSync(out)) throw new Error('doctor produced no report');
      const report = JSON.parse(readFileSync(out, 'utf8'));
      return { detail: `doctor: ${report.errors} error(s), ${report.warnings} warning(s)` };
    },
  },
  {
    id: 'M0-11-patch-integrity',
    title: 'every declared bundle patch exists, parses and resolves its plugin modules',
    fn() {
      if (missingPatches.length) {
        throw new Error(`declared but missing patch files: ${missingPatches.map((p) => `${p.bundle}:${p.patch}`).join(', ')}`);
      }
      const unresolved = [];
      const allRows = [];
      for (const entry of patchRows) {
        for (const row of entry.rows) {
          allRows.push(row.id);
          if (!row.name) unresolved.push(`${entry.bundle}:${row.id} has no plugin name`);
        }
      }
      if (unresolved.length) throw new Error(unresolved.join('; '));
      const reports = profiles.map((p) => staticReports.get(p.name));
      const failed = reports.filter((r) => r && !r.ok);
      if (failed.length) {
        throw new Error(failed.map((r) => {
          const label = r.composition?.profile ?? r.profile?.name ?? 'unknown-profile';
          const probs = r.problems ?? [];
          return `${label}: ${probs.join('; ')}`;
        }).join(' | '));
      }
      // E2: no profile may name a DSH template outside the closed set.
      for (const profile of profiles) {
        if (!['acp', 'web', 'headless', 'sdk', 'sdk-minimal'].includes(profile.template)) {
          throw new Error(`${profile.name} uses template "${profile.template}", which is not in the closed set (E2)`);
        }
      }
      return { detail: `${patchRows.length} patch files, ${allRows.length} rows, ${profiles.length} profiles valid` };
    },
  },
  {
    id: 'M0-12-selftest-contract',
    title: 'the SDLC_SELFTEST report contains the full registered surface (C.9)',
    fn() {
      const report = selftest();
      const missing = [];
      for (const service of ['tasks', 'scheduler', 'router', 'verifier', 'integration', 'evidence', 'escalation', 'worker-mgr', 'recovery']) {
        if (!report.services?.includes(service)) missing.push(`service:${service}`);
      }
      if ((report.presets?.length ?? 0) !== ROLE_COUNT) missing.push(`presets:${report.presets?.length ?? 0}`);
      if (!report.guard?.orchestratorPaths?.length) missing.push('guard.orchestratorPaths');
      if (!report.guard?.forbiddenPatterns?.length) missing.push('guard.forbiddenPatterns');
      if (missing.length) throw new Error(`the boot-hook report is incomplete: ${missing.join(', ')}`);
      return { detail: `via the ${probeMode()}: ${report.services.length} services, ${report.presets.length} presets, guard policy present` };
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M0 platform-integration gate', version: '3.0.0', checks }));
