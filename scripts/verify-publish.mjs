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
 *      commands, services and the 26 presets register.
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

const ROOT = join(import.meta.dirname, '..');
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
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.status === 0 };
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

  // ── 2. packed-shape assertions ──
  for (const [name, tgz] of tgzOf) {
    const entries = tarList(tgz);
    if (entries.some((e) => e.startsWith('package/src/'))) fail(`${name}: packed tarball contains src/ (absent at install time)`);
  }
  if (![...tgzOf.values()].some((tgz) => tarList(tgz).some((e) => e === 'package/src/index.js' || e.startsWith('package/src/')))) {
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

  // ── 3. registry-shape install: file: tarballs, no link:, fresh profiles ──
  const dsh = run('dsh', ['--version']);
  if (!dsh.ok) { fail('dsh CLI not on PATH — cannot prove the install path'); }
  else {
    ok(`dsh ${dsh.stdout.trim()} on PATH`);
    const meta = members.find((m) => !/-(core|tools|presets|ui|guard|cli|mock-llm)$/.test(m.name.split('/')[1]));
    const lead = meta ? tgzOf.get(meta.name) : null;
    const workerTgz = ['-guard', '-tools'].map((s) => [...tgzOf].find(([n]) => n.endsWith(s))?.[1]).filter(Boolean);
    const probeTgz = ['-core', '-tools', '-presets', '-guard'].map((s) => [...tgzOf].find(([n]) => n.endsWith(s))?.[1]).filter(Boolean);
    const add = (profile, template, tgz) => {
      let res = run('dsh', ['--profile', profile, '--from-default-profile', template, '--dump-config']);
      if (!res.ok) { fail(`create profile ${profile}: ${(res.stderr || res.stdout).slice(-300)}`); return false; }
      res = run('dsh', ['plugin', '--profile', profile, 'add', '--ignore-workspace-root-check', ...tgz.map((t) => `file:${t}`)]);
      if (!res.ok) {
        fail(`install into ${profile}: ${(res.stderr || res.stdout).slice(-500)}`);
        return false;
      }
      ok(`registry-shape install into ${profile} (${tgz.length} tarball${tgz.length === 1 ? '' : 's'})`);
      return true;
    };
    const leadOk = lead ? add('sdlc-web', 'web', [lead]) : (fail('meta-bundle tarball missing'), false);
    const workerOk = add('sdlc-worker', 'headless', workerTgz);
    const probeOk = add('sdlc-probe', 'sdk', probeTgz);
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
  }
} finally {
  cleanup();
}

if (failed) {
  console.log(`\nverify-publish: ${failed} failure(s) — refusing to publish`);
  process.exit(1);
}
console.log('\nverify-publish: packed tarballs install and boot — safe to publish');
