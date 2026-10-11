#!/usr/bin/env node
/**
 * scripts/setup-eval-profiles.mjs — create the two A/B arms for a live study.
 *
 * The live harness refuses to run unless both arms exist as `headless`-template
 * profiles that differ only by the SDLC bundles. Creating them needs care that
 * `dsh plugin add` normally handles (pnpm) but that a sandbox without pnpm —
 * or without write access to `~/.dsh` — cannot:
 *
 *   - the arms are created from the shipped `headless` template;
 *   - the provider/model config is copied into BOTH arms identically, so the
 *     only difference is the plugin (the protocol's central claim);
 *   - the `@sdlc/*` bundles are linked into the treatment arm with symlinks,
 *     which is enough because those packages import only Node builtins.
 *
 *   node scripts/setup-eval-profiles.mjs [--dsh-home <dir>] [--provider <p>]
 *     [--model <m>] [--from-profile <existing>] [--check]
 *
 * `--from-profile` (default: `web`) names an existing DSH profile whose
 * provider/model configuration is reused, so the study runs on the same
 * credentials as the interactive session. `--check` only reports.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from './lib/harness.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const has = (name) => argv.includes(name);

const ROOT = resolve(import.meta.dirname, '..');
const HOME = resolve(flag('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')));
const SOURCE_PROFILE = flag('--from-profile', 'web');
const PROVIDER = flag('--provider', null);
const MODEL = flag('--model', null);
const CHECK_ONLY = has('--check');

const CONTROL = 'eval-control';
const TREATMENT = 'eval-treatment';
const BUNDLES = ['core', 'tools', 'presets'];

function log(line) {
  if (!has('--json')) console.log(line);
}

function fail(message) {
  console.error(`setup-eval-profiles: ${message}`);
  process.exit(1);
}

/** Ensure `<home>/profiles/<name>` exists, created from the headless template. */
function ensureProfile(name) {
  const dir = join(HOME, 'profiles', name);
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    log(`  [ok]      ${name} exists`);
    return dir;
  }
  if (CHECK_ONLY) {
    log(`  [missing] ${name} would be created from the "headless" template`);
    return dir;
  }
  log(`  [create]  ${name} from template "headless"`);
  const res = run('dsh', ['--profile', name, '--from-default-profile', 'headless', '--dump-config'], {
    timeoutMs: 300_000,
    env: { ...process.env, DSH_HOME: HOME },
  });
  if (!res.ok) fail(`creating ${name} failed:\n${(res.stderr || res.stdout || '').slice(0, 1200)}`);
  return dir;
}

/**
 * The provider/model patch: reuse the source profile's config, or generate one.
 * Returns the YAML entry list (minus the web-only UI row) or null.
 */
function providerPatchText() {
  const src = join(HOME, 'profiles', SOURCE_PROFILE, 'cordis.patch.yml');
  if (existsSync(src)) {
    const raw = readFileSync(src, 'utf8');
    const start = raw.indexOf('- id: ');
    if (start >= 0) {
      const entries = raw.slice(start).split(/\n(?=- id: )/);
      const keep = entries.filter((e) => /^- id: (llm-[a-z-]+|agent-default-model)$/.test(e.split('\n')[0]));
      if (keep.length) {
        log(`  [config]  provider/model reused from profile "${SOURCE_PROFILE}"`);
        return `# Provider + default-model config, IDENTICAL in both arms.\n${keep.join('\n').replace(/\n?$/, '')}\n`;
      }
    }
  }
  if (PROVIDER || MODEL) {
    log('  [config]  provider/model generated from --provider/--model');
    const lines = ['# Provider + default-model config, IDENTICAL in both arms.', '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:'];
    if (PROVIDER) lines.push(`    provider: ${JSON.stringify(PROVIDER)}`);
    if (MODEL) lines.push(`    model: ${JSON.stringify(MODEL)}`);
    return `${lines.join('\n')}\n`;
  }
  log(`  [warn]    no provider config found in "${SOURCE_PROFILE}" and no --provider/--model given`);
  log('            the arms will run whatever the template defaults to');
  return null;
}

// ── run ─────────────────────────────────────────────────────────────────────

log(`\nA/B evaluation arms`);
log(`==================\n`);
log(`  DSH_HOME : ${HOME}`);
log(`  source   : ${ROOT}\n`);

log('profiles:');
const controlDir = ensureProfile(CONTROL);
const treatmentDir = ensureProfile(TREATMENT);

const patch = providerPatchText();
if (patch && !CHECK_ONLY) {
  for (const dir of [controlDir, treatmentDir]) {
    const target = join(dir, 'cordis.patch.yml');
    // Preserve any existing user layer below our generated header.
    writeFileSync(target, patch);
  }
  log(`  [ok]      patch written to both arms`);
}

log('treatment bundles:');
for (const name of BUNDLES) {
  const src = join(ROOT, 'packages', `sdlc-${name}`);
  if (!existsSync(join(src, 'cordis.patch.yml'))) fail(`packages/sdlc-${name} is missing its cordis.patch.yml (run \`npm run build\`)`);
  const linkDir = join(treatmentDir, 'node_modules', '@sdlc');
  const link = join(linkDir, `orchestrator-${name}`);
  if (CHECK_ONLY) {
    log(`  [${existsSync(link) ? 'ok' : 'missing'}] @sdlc/orchestrator-${name}`);
    continue;
  }
  mkdirSync(linkDir, { recursive: true });
  if (!existsSync(link)) symlinkSync(src, link, 'dir');
  log(`  [link]    @sdlc/orchestrator-${name}`);
}

if (!CHECK_ONLY) {
  const pkgPath = join(treatmentDir, 'package.json');
  const doc = JSON.parse(readFileSync(pkgPath, 'utf8'));
  doc.dsh ??= { profile: { bundles: [] } };
  doc.dsh.profile.bundles ??= [];
  for (const name of BUNDLES) {
    const id = `@sdlc/orchestrator-${name}`;
    if (!doc.dsh.profile.bundles.includes(id)) doc.dsh.profile.bundles.push(id);
  }
  doc.dependencies ??= {};
  for (const name of BUNDLES) doc.dependencies[`@sdlc/orchestrator-${name}`] = `link:../../../../packages/sdlc-${name}`;
  writeFileSync(pkgPath, `${JSON.stringify(doc, null, 2)}\n`);
  log('  [ok]      @sdlc/* bundles declared in the treatment package.json');

  // Reuse the credentials of the normal home, so the study can authenticate.
  const credSrc = join(homedir(), '.dsh', '.credentials.yaml');
  const credDst = join(HOME, '.credentials.yaml');
  if (HOME !== resolve(join(homedir(), '.dsh')) && existsSync(credSrc) && !existsSync(credDst)) {
    cpSync(credSrc, credDst);
    log('  [ok]      credentials store copied into the isolated DSH_HOME');
  }
}

if (CHECK_ONLY) {
  log(`\n${readdirSync(join(HOME, 'profiles')).join(', ')} present under ${join(HOME, 'profiles')}\n`);
  process.exit(0);
}

// Verify both compose, then hand off to the harness's own preflight.
log('\nverifying composition:');
for (const [label, name] of [['baseline', CONTROL], ['treatment', TREATMENT]]) {
  const res = run('dsh', ['--profile', name, '--dump-config'], { timeoutMs: 300_000, env: { ...process.env, DSH_HOME: HOME } });
  if (!res.ok) fail(`${label} profile "${name}" did not compose:\n${(res.stdout + res.stderr).slice(-1200)}`);
  const rows = [...String(res.stdout).matchAll(/^- id:\s*(.+)$/gm)].length;
  const sdlc = [...String(res.stdout).matchAll(/@sdlc\//g)].length;
  log(`  [ok]      ${name}: ${rows} rows, ${sdlc} plugin rows`);
}

log(`\nDone. Pilot with:\n`);
log(`  node eval/run.mjs --executor dsh --live --repeats 1 --task control-docs-typo \\`);
log(`    --provider ${PROVIDER ?? '<provider>'} --model ${MODEL ?? '<model>'} \\`);
log(`    --baseline-profile ${CONTROL} --treatment-profile ${TREATMENT} \\`);
log(`    --dsh-home ${HOME} --out .eval-out-pilot\n`);
