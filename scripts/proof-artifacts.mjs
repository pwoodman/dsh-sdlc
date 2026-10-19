#!/usr/bin/env node
/**
 * scripts/proof-artifacts.mjs — prove the packed artifacts, not the source tree.
 *
 * `npm test` exercises src/. Users install `lib/` from a tarball. This script
 * packs the real packages with whichever packer is on PATH (pnpm or npm),
 * asserts the ship shape, and runs the packed CLI from a consumer fixture with
 * its declared dependencies in node_modules — no registry, no dsh, no model.
 *
 *   node scripts/proof-artifacts.mjs [--json <path>]
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const jsonFlag = argv.indexOf('--json');
const JSON_OUT = jsonFlag >= 0 ? argv[jsonFlag + 1] : null;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function probePacker(name) {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? name : null;
}

// A pnpm standalone entry (pnpm.mjs) is supported because this checkout runs
// without a global pnpm/npm on PATH.
const PNPM = process.env.PNPM_BIN
  ? { kind: 'mjs', path: process.env.PNPM_BIN }
  : (probePacker('pnpm') ? { kind: 'bin', path: 'pnpm' } : null);
const NPM = PNPM === null && probePacker('npm') ? { kind: 'bin', path: 'npm' } : null;
if (PNPM === null && NPM === null) {
  process.stderr.write('proof-artifacts: neither pnpm nor npm is on PATH (set PNPM_BIN=/path/to/pnpm.mjs)\n');
  process.exit(2);
}
const PACKER = PNPM ?? NPM;

function packerRun(args, cwd) {
  return PACKER.kind === 'mjs'
    ? spawnSync(process.execPath, [PACKER.path, ...args], { cwd, encoding: 'utf8' })
    : spawnSync(PACKER.path, args, { cwd, encoding: 'utf8' });
}

const work = mkdtempSync(join(tmpdir(), 'sdlc-artifact-proof-'));
const packs = join(work, 'packs');
mkdirSync(packs, { recursive: true });

function pack(dir) {
  const args = PNPM !== null
    ? ['--dir', join(ROOT, 'packages', dir), 'pack', '--pack-destination', packs]
    : ['pack', '--pack-destination', packs];
  const res = packerRun(args, PNPM !== null ? ROOT : join(ROOT, 'packages', dir));
  if (res.status !== 0) throw new Error(`${PACKER.path} pack ${dir}: ${res.stderr || res.stdout}`);
  const file = res.stdout.trim().split('\n').filter(Boolean).at(-1);
  return isAbsolute(file) ? file : join(packs, file);
}

function entries(tgz) {
  return execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function extract(tgz, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['xzf', tgz, '-C', dest, '--strip-components=1']);
}

try {
  process.stdout.write(`\nPacked-artifact proof — packer: ${PACKER.path}\n${'='.repeat(80)}\n`);

  const tarballs = {};
  for (const dir of ['sdlc-guard', 'sdlc-core', 'sdlc-cli', 'sdlc-client-ui', 'sdlc-orchestrator']) {
    tarballs[dir] = pack(dir);
    check(`packed ${dir}`, existsSync(tarballs[dir]), tarballs[dir].split('/').at(-1));
  }

  // No tarball may ship source, a package store or build-only junk.
  for (const [dir, tgz] of Object.entries(tarballs)) {
    const list = entries(tgz);
    const has = (needle) => list.some((entry) => entry.startsWith(needle) || entry === needle);
    check(`${dir}: no src/`, !has('package/src/'));
    check(`${dir}: no pnpm store`, !list.some((entry) => entry.includes('.pnpm-store')));
    check(`${dir}: no node_modules`, !has('package/node_modules/'));
  }

  // The meta bundle must carry the runtime entries the loader activates.
  const metaList = entries(tarballs['sdlc-orchestrator']);
  for (const rel of [
    'package/lib/index.js',
    'package/lib/install.mjs',
    'package/lib/install-lib.mjs',
    'package/lib/update.js',
    'package/lib/rows/presets/cordis.patch.yml',
    'package/lib/rows/presets/locale/en.json',
    'package/cordis.patch.yml',
  ]) {
    check(`meta ships ${rel.replace('package/', '')}`, metaList.includes(rel));
  }
  const metaPkg = JSON.parse(execFileSync('tar', ['xzOf', tarballs['sdlc-orchestrator'], 'package/package.json'], { encoding: 'utf8' }));
  check('meta has no dependencies (folded)', metaPkg.dependencies === undefined);
  check('dsh peer is optional for package managers', metaPkg.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional === true);
  check('installer bin is shipped', metaPkg.bin?.['dsh-sdlc-install'] === 'lib/install.mjs');
  check('meta exports update-backed installer', metaPkg.exports?.['./install'] === './lib/install.mjs');

  // UI exports must point at files that exist in the tarball.
  const uiList = entries(tarballs['sdlc-client-ui']);
  const uiPkg = JSON.parse(execFileSync('tar', ['xzOf', tarballs['sdlc-client-ui'], 'package/package.json'], { encoding: 'utf8' }));
  const targets = [];
  const collect = (value) => {
    if (typeof value === 'string') { if (!value.includes('*')) targets.push(value.replace(/^\.\//, '')); }
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect([uiPkg.main, uiPkg.types, uiPkg.exports]);
  check('UI has no broken "types" field', uiPkg.types === undefined);
  for (const rel of targets) {
    check(`UI target ${rel} ships`, uiList.includes(`package/${rel}`));
  }

  // The packed CLI must run with the dependencies it declares — no registry.
  const consumer = join(work, 'consumer');
  mkdirSync(join(consumer, 'node_modules', '@patwoodman'), { recursive: true });
  for (const [dir, name] of [['sdlc-guard', 'dsh-sdlc-flow-guard'], ['sdlc-core', 'dsh-sdlc-flow-core'], ['sdlc-cli', 'dsh-sdlc-flow-cli']]) {
    extract(tarballs[dir], join(consumer, 'node_modules', '@patwoodman', name));
  }
  const cliManifest = JSON.parse(readFileSync(join(consumer, 'node_modules', '@patwoodman', 'dsh-sdlc-flow-cli', 'package.json'), 'utf8'));
  check('packed CLI declares core', typeof cliManifest.dependencies?.['@patwoodman/dsh-sdlc-flow-core'] === 'string');
  const cli = spawnSync(process.execPath, [
    join(consumer, 'node_modules', '@patwoodman', 'dsh-sdlc-flow-cli', 'bin', 'sdlc.mjs'), '--help',
  ], { encoding: 'utf8', timeout: 30_000 });
  check('packed CLI runs from a consumer node_modules', cli.status === 0, (cli.stderr || cli.stdout).split('\n')[0]);
  check('packed CLI prints its banner', /deterministic control plane/.test(cli.stdout));

  writeFileSync(join(work, 'result.json'), JSON.stringify(checks, null, 2));
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`${'='.repeat(80)}\n  ${checks.length - failed.length}/${checks.length} packed-artifact checks passed\n`);
  if (JSON_OUT) {
    mkdirSync(join(ROOT, '.validation'), { recursive: true });
    writeFileSync(JSON_OUT, `${JSON.stringify({ packer: PACKER, checks, failed: failed.length }, null, 2)}\n`);
    process.stdout.write(`  report: ${JSON_OUT}\n`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
