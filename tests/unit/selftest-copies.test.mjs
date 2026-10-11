/**
 * tests/unit/selftest-copies.test.mjs — the SDLC_SELFTEST helper, in all four copies.
 *
 * The helper is deliberately duplicated in `sdlc-core`, `sdlc-tools`,
 * `sdlc-presets` and `sdlc-guard` (deviation D5 / errata E6: those packages must
 * stay independently installable, so none may import another's code). That makes
 * four files with identical behaviour — so the right test is not "call each one
 * once for coverage" but a BEHAVIOURAL EQUIVALENCE check: every copy must expose
 * the same surface and produce the same merged report.
 *
 * This also covers the debounce path, the report builder and the fail-loud
 * absolute-path rule in each copy rather than only in core.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { load, tempDir, cleanup } from '../lib/helpers.mjs';

const COPIES = {
  core: 'packages/sdlc-core/src/selftest.js',
  tools: 'packages/sdlc-tools/src/selftest.js',
  presets: 'packages/sdlc-presets/src/selftest.js',
  guard: 'packages/sdlc-guard/src/selftest.js',
};
const EXPORTS = ['contributeSelftest', 'setSelftestMeta', 'flushSelftest', 'buildSelftestReport', 'selftestWritten'];

const mods = {};
for (const [name, path] of Object.entries(COPIES)) mods[name] = await load(path);

/**
 * Run `fn` with SDLC_SELFTEST set to an absolute temp path, always restoring.
 * AWAIT-AWARE: an async `fn` keeps the env var and the temp dir alive until it
 * settles, so a debounced flush cannot be raced by the cleanup.
 */
async function withSelftestPath(fn) {
  const previous = process.env.SDLC_SELFTEST;
  const dir = tempDir('sdlc-selftest-copy-');
  const path = join(dir, 'report.json');
  process.env.SDLC_SELFTEST = path;
  try {
    return await fn(path, dir);
  } finally {
    if (previous === undefined) delete process.env.SDLC_SELFTEST;
    else process.env.SDLC_SELFTEST = previous;
    cleanup(dir);
  }
}

test('all four copies expose the same surface', () => {
  for (const [name, mod] of Object.entries(mods)) {
    for (const fn of EXPORTS) {
      assert.equal(typeof mod[fn], 'function', `${name} is missing ${fn}`);
    }
  }
});

test('each copy can set the meta and build a well-formed report', () => {
  for (const [name, mod] of Object.entries(mods)) {
    mod.setSelftestMeta({ version: `1.2.3-${name}`, dsh: '0.2.0-rc.2' });
    const report = mod.buildSelftestReport();
    assert.deepEqual(Object.keys(report).sort(), ['commands', 'dsh', 'guard', 'presets', 'services', 'tools', 'version']);
    assert.equal(report.dsh, '0.2.0-rc.2', `${name} lost the dsh version`);
    assert.ok(Array.isArray(report.tools) && Array.isArray(report.commands));
    assert.ok(Array.isArray(report.guard.orchestratorPaths));
  }
});

test('contributions from every copy merge into ONE report (shared globalThis state)', async () => {
  await withSelftestPath((path) => {
    mods.core.contributeSelftest({ tools: ['core-tool'], services: ['tasks'] });
    mods.tools.contributeSelftest({ tools: ['tool-tool'], commands: ['run'] });
    mods.presets.contributeSelftest({ presets: ['preset-sdlc-lead'] });
    mods.guard.contributeSelftest({ guard: { forbiddenPatterns: ['rm -rf /'] } });
    const report = mods.tools.flushSelftest(); // flush via a NON-core copy
    assert.deepEqual(report.tools, ['core-tool', 'tool-tool'], 'tools are unioned and sorted');
    assert.deepEqual(report.commands, ['run']);
    assert.deepEqual(report.services, ['tasks']);
    assert.deepEqual(report.presets, ['preset-sdlc-lead']);
    assert.deepEqual(report.guard.forbiddenPatterns, ['rm -rf /']);
    assert.equal(existsSync(path), true, 'the report file was written');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tools, ['core-tool', 'tool-tool']);
    assert.equal(mods.guard.selftestWritten(), true, 'selftestWritten reflects the flush');
  });
});

test('an empty contribution never clobbers a populated one (the merge rule)', async () => {
  await withSelftestPath(() => {
    // The guard owns the policy; sdlc-core contributes a placeholder. The
    // placeholder must not erase what the owner reported.
    mods.guard.contributeSelftest({ guard: { forbiddenPatterns: ['git push --force*'], orchestratorPaths: ['.sdlc/**'] } });
    mods.core.contributeSelftest({ guard: { forbiddenPatterns: [], orchestratorPaths: [] } });
    mods.core.contributeSelftest({ guard: { forbiddenPatterns: undefined } });
    const report = mods.core.buildSelftestReport();
    assert.deepEqual(report.guard.forbiddenPatterns, ['git push --force*']);
    assert.deepEqual(report.guard.orchestratorPaths, ['.sdlc/**']);
    // …but a later NON-empty value still wins.
    mods.core.contributeSelftest({ guard: { forbiddenPatterns: ['rm -rf /'] } });
    assert.deepEqual(mods.core.buildSelftestReport().guard.forbiddenPatterns, ['rm -rf /']);
  });
});

test('the hook is inert without SDLC_SELFTEST in every copy', () => {
  const previous = process.env.SDLC_SELFTEST;
  delete process.env.SDLC_SELFTEST;
  try {
    for (const [name, mod] of Object.entries(mods)) {
      assert.equal(mod.contributeSelftest({ tools: [`x-${name}`] }), null, `${name} scheduled a flush without a path`);
      assert.equal(mod.flushSelftest(), null, `${name} wrote a report without a path`);
    }
  } finally {
    if (previous !== undefined) process.env.SDLC_SELFTEST = previous;
  }
});

test('a non-absolute SDLC_SELFTEST is a start-up error in every copy, never a silent pass', () => {
  const previous = process.env.SDLC_SELFTEST;
  try {
    process.env.SDLC_SELFTEST = 'relative/report.json';
    for (const [name, mod] of Object.entries(mods)) {
      assert.throws(() => mod.contributeSelftest({ tools: ['x'] }), /must be an absolute path/, `${name} accepted a relative path`);
      assert.throws(() => mod.flushSelftest(), /must be an absolute path/, `${name} flushed to a relative path`);
    }
  } finally {
    if (previous === undefined) delete process.env.SDLC_SELFTEST;
    else process.env.SDLC_SELFTEST = previous;
  }
});

test('the debounce timer writes the file without an explicit flush', async () => {
  await withSelftestPath(async (path) => {
    // contributeSelftest alone must eventually write (50 ms debounce).
    mods.presets.contributeSelftest({ presets: ['preset-sdlc-lead'] });
    assert.equal(existsSync(path), false, 'the write must be deferred, not immediate');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(path), true, 'the debounced flush never happened');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).presets, ['preset-sdlc-lead']);
  });
});

test('the four copies are byte-identical (drift guard for D5)', () => {
  const bodies = Object.entries(COPIES).map(([name, path]) => [name, readFileSync(join(process.cwd(), path), 'utf8')]);
  const [, first] = bodies[0];
  for (const [name, body] of bodies.slice(1)) {
    assert.equal(body, first, `the ${name} copy has drifted from the core copy — update every copy or none`);
  }
});
