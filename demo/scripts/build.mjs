/**
 * demo/scripts/build.mjs — offline build gate for the demo fullstack app.
 *
 * Zero dependencies, zero network: syntax-checks every JS file, asserts the
 * HTML references the assets it needs, and smoke-tests the API over a real
 * ephemeral-port HTTP server (health → create → list → toggle → 404/400
 * paths). Exit 0 = the app builds; anything else fails LOUD with the step.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');

let failed = 0;
function step(name, fn) {
  try {
    const detail = fn();
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL ${name} — ${err.message}\n`);
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function checkFile(path) {
  const res = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'syntax error').trim().split('\n')[0]);
}

process.stdout.write('demo build\n');

step('syntax: all JS files parse', () => {
  const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'public')), walk(join(ROOT, 'tests')), [join(ROOT, 'scripts', 'build.mjs')]);
  const js = files.filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  if (!js.length) throw new Error('no JS files found');
  for (const f of js) checkFile(f);
  return `${js.length} files`;
});

step('frontend: index.html wires app.js + labels', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  if (!html.includes('/app.js')) throw new Error('index.html does not load /app.js');
  if (!/<label[^>]*for="title"/.test(html)) throw new Error('title input has no <label>');
  if (!html.includes('aria-live')) throw new Error('no aria-live regions');
  return 'app.js + a11y hooks present';
});

if (failed) {
  process.stdout.write(`\ndemo build: ${failed} FAILED\n`);
  process.exit(1);
}

// The live smoke test is async; run it after the sync steps passed.
const { startServer } = await import('../src/server.mjs');
const server = await startServer({ root: ROOT, port: 0 });
const port = server.address().port;
try {
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => (await fetch(`${base}${p}`)).json().then((b) => ({ status: 0, body: b })).catch((e) => { throw new Error(`GET ${p}: ${e.message}`); });
  const health = await (await fetch(`${base}/api/health`)).json();
  if (health.ok !== true) throw new Error('health did not return { ok: true }');
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'smoke task' }),
  })).json();
  if (!created.id) throw new Error('POST /api/tasks did not return an id');
  const listed = await (await fetch(`${base}/api/tasks`)).json();
  if (!Array.isArray(listed) || !listed.some((t) => t.id === created.id)) throw new Error('created task missing from GET /api/tasks');
  const toggled = await (await fetch(`${base}/api/tasks/${created.id}/done`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }),
  })).json();
  if (toggled.done !== true) throw new Error('toggle did not persist done=true');
  const bad = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '' }),
  });
  if (bad.status !== 400) throw new Error(`empty title should be 400, got ${bad.status}`);
  const missing = await fetch(`${base}/api/tasks/nope/done`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }),
  });
  if (missing.status !== 404) throw new Error(`unknown id should be 404, got ${missing.status}`);
  process.stdout.write('  ok   api: live smoke test on an ephemeral port — health/create/list/toggle/400/404\n');
} catch (err) {
  process.stdout.write(`  FAIL api: live smoke test — ${err.message}\n`);
  process.exitCode = 1;
} finally {
  server.close();
}

// Emit a dist/ stamp so operators can see WHAT was built and WHEN.
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), node: process.version }, null, 2) + '\n');
if (!process.exitCode) process.stdout.write('\ndemo build: PASS\n');
