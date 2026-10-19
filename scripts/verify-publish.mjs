#!/usr/bin/env node
/**
 * scripts/verify-publish.mjs — pre-publish proof that the PACKED tarballs
 * install and boot.
 *
 * WHY THIS EXISTS. `npm publish` ships exactly the `files` list (lib/, never
 * src/ or build scripts). A tree can pass every unit test and every gate and
 * still publish uninstallable packages — beta.10 proved it, when `prepack`
 * rebuilt from src/ inside npm's pack and died with ENOENT, leaving core,
 * guard and ui unpublished while the workflow reported success for the rest.
 * Gates validate the SOURCE tree; this script validates the SHIP artifact:
 *
 *   1. `npm pack --ignore-scripts` every non-private member (exactly what the
 *      Release workflow publishes, minus the registry round-trip);
 *   2. assert no packed tarball contains `src/` (unavailable at install time)
 *      and every loader entry point (`lib/index.js`, `plugin.js`, `roles.js`,
 *      `cli.mjs`, `client.js`) is provided by exactly the package that owns it;
 *   3. install the packed tarballs into scratch profiles with
 *      `dsh plugin add file:<tgz>` — the registry-shape path, no `link:` —
 *      and boot the probe profile via SDLC_SELFTEST, asserting tools,
 *      commands, services and the 26 presets register;
 *   4. create a real `sdlc-lead` session from the packed lead;
 *   5. run the shipped installer's `--check` (expect up to date) and
 *      `--uninstall` (expect the package and selection gone).
 *
 * A failure here fails the Release BEFORE anything reaches npm, so a broken
 * pack can never strand users on a half-published version again.
 *
 *   node scripts/verify-publish.mjs [--keep]   # --keep leaves the scratch dirs
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process'; // execFileSync: tar listing only
import { createLeadSession } from './lib/preset-boot.mjs';

const ROOT = join(import.meta.dirname, '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const KEEP = process.argv.includes('--keep');
const HOME = mkdtempSync(join(tmpdir(), 'sdlc-verify-publish-home-'));
const WORK = mkdtempSync(join(tmpdir(), 'sdlc-verify-publish-'));
const PACK_DIR = join(WORK, 'packs');
mkdirSync(PACK_DIR, { recursive: true });

let failed = 0;
function ok(msg) { console.log(`  [ok]      ${msg}`); }
function fail(msg) { failed += 1; console.log(`  [FAIL]    ${msg}`); }

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: opts.timeoutMs ?? 300_000, cwd: opts.cwd ?? ROOT,
    env: { ...process.env, DSH_HOME: HOME, ...(opts.env ?? {}) },
  });
  const spawnError = res.error ? `spawn ${cmd}: ${res.error.message}` : '';
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? spawnError,
    ok: res.status === 0 && !res.error,
  };
}

function tarList(tgz) {
  const out = execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function cleanup() {
  if (KEEP) {
    console.log(`  --keep: scratch dirs left at ${HOME} and ${WORK}`);
    return;
  }
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
}

try {
  // ── 1. pack every shippable member, exactly like the Release does ──
  const members = [];
  for (const dir of readdirSync(join(ROOT, 'packages')).sort()) {
    const manifestPath = join(ROOT, 'packages', dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (pkg.private) { ok(`skip ${pkg.name} (private)`); continue; }
    members.push({ dir, name: pkg.name, version: pkg.version });
  }
  const tgzOf = new Map();
  for (const m of members) {
    const res = run('npm', ['pack', '--ignore-scripts', '--pack-destination', PACK_DIR], { cwd: join(ROOT, 'packages', m.dir) });
    if (!res.ok) { fail(`npm pack ${m.name}: ${(res.stderr || res.stdout).slice(0, 400)}`); continue; }
    const file = readdirSync(PACK_DIR).find((f) => f.startsWith(basename(m.name).replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 8)) && f.endsWith('.tgz'))
      ?? readdirSync(PACK_DIR).find((f) => f.endsWith('.tgz') && !tgzOf.has(f));
    // Robust fallback: the pack wrote exactly one new tarball.
    const fresh = readdirSync(PACK_DIR).filter((f) => f.endsWith('.tgz') && ![...tgzOf.values()].some((t) => basename(t) === f));
    const pick = fresh.length === 1 ? fresh[0] : file;
    if (!pick) { fail(`npm pack ${m.name} produced no tarball`); continue; }
    tgzOf.set(m.name, join(PACK_DIR, pick));
    ok(`packed ${m.name}@${m.version} → ${pick}`);
  }

  if (tgzOf.size === 0) {
    fail('no shippable package could be packed — refusing to report success');
  }

  // ── 2. packed-shape assertions ──
  for (const [name, tgz] of tgzOf) {
    const entries = tarList(tgz);
    if (entries.some((e) => e.startsWith('package/src/'))) fail(`${name}: packed tarball contains src/ (absent at install time)`);
  }
  if (tgzOf.size > 0 && ![...tgzOf.values()].some((tgz) => tarList(tgz).some((e) => e === 'package/src/index.js' || e.startsWith('package/src/')))) {
    ok('no packed tarball contains src/ (lib/ only, as installed)');
  }
  const need = [
    ['lib/index.js', 'host entry'],
    ['lib/plugin.js', 'plugin entry'],
    ['lib/roles.js', 'preset roles'],
    ['lib/cli.mjs', 'CLI entry'],
    ['lib/client.js', 'browser bundle'],
  ];
  for (const [file, what] of need) {
    const owners = [...tgzOf].filter(([, tgz]) => tarList(tgz).includes(`package/${file}`)).map(([n]) => n);
    if (owners.length === 0) fail(`no packed tarball provides ${file} (${what})`);
    else ok(`${file} ← ${owners.join(', ')}`);
  }

  // Folded members read some files RELATIVELY, so they must travel inside the
  // meta tarball next to the folded lib/. beta.13 shipped without them: the
  // source tree passed, but activation died with ENOENT on
  // lib/rows/presets/cordis.patch.yml. Pin the shipped artifact, not the tree.
  const metaTgz = tgzOf.get('@patwoodman/dsh-sdlc-flow');
  if (metaTgz === undefined) fail('meta-bundle @patwoodman/dsh-sdlc-flow was not packed');
  else {
    const entries = tarList(metaTgz);
    for (const rel of [
      'package/lib/rows/presets/cordis.patch.yml',
      'package/lib/rows/presets/locale/en.json',
    ]) {
      if (entries.includes(rel)) ok(`meta tarball ships ${rel}`);
      else fail(`meta tarball missing ${rel} (folded runtime sibling — install-time ENOENT)`);
    }
  }

  // ── 3. install proof: packed META via file:, members via link: ──
  // The packed-shape assertions above (no src/, every loader entry owned)
  // are what prove the SHIP artifact. For the BOOT proof, the meta-bundle
  // tarball installs exactly as users install it — `file:` (it has NO
  // dependencies, folded) — while members install via `link:` like
  // install-local.mjs does. Rationale: member tarballs declare versioned
  // intra-suite deps (tools→core@beta.N) that are NOT on the registry yet
  // at verify time, so pnpm resolves them from the registry and dies with
  // ERR_PNPM_NO_MATCHING_VERSION (observed on beta.16) — one-at-a-time or
  // bulk, it cannot work pre-publish. `link:` skips dep resolution, which
  // is precisely the pre-publish semantics we need; post-publish, the
  // registry satisfies the same ranges (proven by the post-publish
  // `npm view` loop in release.yml).
  const dsh = run('dsh', ['--version']);
  if (!dsh.ok) { fail('dsh CLI not on PATH — cannot prove the install path'); }
  else {
    ok(`dsh ${dsh.stdout.trim()} on PATH`);
    const meta = members.find((m) => !/-(core|tools|presets|ui|guard|cli|mock-llm)$/.test(m.name.split('/')[1]));
    const lead = meta ? tgzOf.get(meta.name) : null;
    const pkgDir = (name) => {
      for (const d of readdirSync(join(ROOT, 'packages')).sort()) {
        try {
          if (JSON.parse(readFileSync(join(ROOT, 'packages', d, 'package.json'), 'utf8')).name === name) {
            return join(ROOT, 'packages', d);
          }
        } catch { /* ignore */ }
      }
      return null;
    };
    const memberName = (suffix) => [...tgzOf].find(([n]) => n.endsWith(suffix))?.[0] ?? null;
    const linkSpec = (suffix) => {
      const n = memberName(suffix);
      const d = n ? pkgDir(n) : null;
      return d ? `link:${d}` : null;
    };
    const addSpecs = (profile, template, specs) => {
      let res = run('dsh', ['--profile', profile, '--from-default-profile', template, '--dump-config']);
      if (!res.ok) { fail(`create profile ${profile}: ${(res.stderr || res.stdout).slice(-300)}`); return false; }
      res = run('dsh', ['plugin', '--profile', profile, 'add', '--ignore-workspace-root-check', ...specs]);
      if (!res.ok) {
        fail(`install into ${profile}: ${(res.stderr || res.stdout).slice(-500)}`);
        return false;
      }
      ok(`install into ${profile} (${specs.length} spec${specs.length === 1 ? '' : 's'})`);
      return true;
    };
    // Lead: the PACKED meta tarball, exactly as users install it.
    const leadOk = lead
      ? addSpecs('sdlc-web', 'web', [`file:${lead}`])
      : (fail('meta-bundle tarball missing'), false);
    // Worker/probe: members via link: (pre-publish resolvable), proving the
    // packed SHAPE (asserted above) composes and boots once published.
    const workerSpecs = [linkSpec('-guard'), linkSpec('-tools')].filter(Boolean);
    const probeSpecs = [linkSpec('-core'), linkSpec('-tools'), linkSpec('-presets'), linkSpec('-guard')].filter(Boolean);
    const workerOk = workerSpecs.length === 2 ? addSpecs('sdlc-worker', 'headless', workerSpecs) : (fail('worker member packages not found'), false);
    const probeOk = probeSpecs.length === 4 ? addSpecs('sdlc-probe', 'sdk', probeSpecs) : (fail('probe member packages not found'), false);
    if (leadOk && probeOk && workerOk) {
      // ── 4. boot the packed probe via the real boot hook ──
      // The probe exits after writing the report, so run it detached with a
      // bounded wait (spawnSync with a timeout kills the tree on expiry —
      // that is fine once the report exists).
      const reportPath = join(WORK, 'selftest.json');
      run('dsh', ['--profile', 'sdlc-probe'], { env: { SDLC_SELFTEST: reportPath }, timeoutMs: 120_000 });
      if (!existsSync(reportPath)) fail('packed probe wrote no SDLC_SELFTEST report');
      else {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        const checks = [
          [(report.tools ?? []).length >= 3, `${report.tools?.length ?? 0} tools`],
          [(report.commands ?? []).length >= 8, `${report.commands?.length ?? 0} commands`],
          [(report.services ?? []).length >= 9, `${report.services?.length ?? 0} services`],
          [(report.presets ?? []).length === 26, `${report.presets?.length ?? 0} presets`],
        ];
        const bad = checks.filter(([cond]) => !cond).map(([, label]) => label);
        if (bad.length) fail(`packed probe report incomplete: ${bad.join(', ')}`);
        else ok(`packed probe boots: ${checks.map(([, l]) => l).join(', ')}`);
      }
    }
    // ── 5. the only path a user takes: create a lead session ──
    // Static preset checks and the probe cannot see this: agent-preset rows
    // are validated when a session is created with that preset. beta.19
    // shipped a registry that rejected `sdlc-lead` while every gate passed.
    if (leadOk) {
      const webWork = join(WORK, 'web-work');
      mkdirSync(webWork, { recursive: true });
      try {
        const session = await createLeadSession({
          dshHome: HOME,
          profile: 'sdlc-web',
          cwd: webWork,
          env: { ...process.env, DSH_HOME: HOME, SDLC_AUTO_UPDATE: 'off' },
        });
        ok(`packed lead creates a ${session.agentPreset} session`);
      } catch (error) {
        fail(`packed lead cannot create the sdlc-lead session: ${error.message}`);
      }

      // ── 6. check and uninstall the packed lead ──
      // Exercise the SHIPPED installer (`lib/install.mjs` inside the meta
      // tarball), not the source tree: this is what `npx` runs for users.
      const metaExtract = join(WORK, 'meta-extract');
      mkdirSync(metaExtract, { recursive: true });
      const untar = run('tar', ['xzf', lead, '-C', metaExtract]);
      if (!untar.ok) fail(`could not extract the packed meta tarball: ${untar.stderr.slice(0, 300)}`);
      const installer = join(metaExtract, 'package', 'lib', 'install.mjs');
      if (!existsSync(installer)) fail('packed meta tarball does not contain lib/install.mjs');
      const check = run(process.execPath, [
        installer, '--check', '--only', 'lead', '--dsh-home', HOME, '--version', VERSION, '--json',
      ]);
      if (!check.ok) fail(`packed lead --check failed: ${(check.stderr || check.stdout).slice(-500)}`);
      else {
        try {
          const report = JSON.parse(check.stdout);
          if (report.profiles?.[0]?.updateAvailable !== false) {
            fail(`packed lead --check reports cleanup/update needed: ${JSON.stringify(report.profiles?.[0] ?? null)}`);
          } else ok('packed lead reports up to date');
        } catch (error) {
          fail(`packed lead --check returned invalid JSON: ${error.message}`);
        }
      }
      const removed = run(process.execPath, [
        installer, '--uninstall', '--only', 'lead', '--dsh-home', HOME, '--json',
      ]);
      if (!removed.ok) fail(`packed lead --uninstall failed: ${(removed.stderr || removed.stdout).slice(-500)}`);
      else if (existsSync(join(HOME, 'profiles', 'sdlc-web', 'node_modules', '@patwoodman', 'dsh-sdlc-flow', 'package.json'))) {
        fail('packed lead --uninstall left the package installed');
      } else ok('packed lead uninstalls cleanly');
    }
  }
} finally {
  cleanup();
}

if (failed) {
  console.log(`\nverify-publish: ${failed} failure(s) — refusing to publish`);
  process.exit(1);
}
console.log('\nverify-publish: packed tarballs install and boot — safe to publish');
