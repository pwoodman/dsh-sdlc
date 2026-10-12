/**
 * tests/unit/selftest.test.mjs — the deterministic boot hook (spec v3 C.9, M0-03/04).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { core, tempDir, cleanup } from '../lib/helpers.mjs';

const selftest = await core.selftest();

test('the hook is inert unless SDLC_SELFTEST is set', () => {
  const previous = process.env.SDLC_SELFTEST;
  delete process.env.SDLC_SELFTEST;
  try {
    assert.equal(selftest.contributeSelftest({ tools: ['a'] }), null);
    assert.equal(selftest.flushSelftest(), null);
  } finally {
    if (previous !== undefined) process.env.SDLC_SELFTEST = previous;
  }
});

test('contributions from multiple packages merge into one sorted report', () => {
  const dir = tempDir('sdlc-selftest-');
  const previous = process.env.SDLC_SELFTEST;
  try {
    const path = join(dir, 'report.json');
    process.env.SDLC_SELFTEST = path;
    selftest.contributeSelftest({ tools: ['b', 'a'], services: ['tasks'], guard: { forbiddenPatterns: ['rm -rf /'] } });
    selftest.contributeSelftest({ tools: ['c'], presets: ['preset-sdlc-lead'], commands: ['run'] });
    const report = selftest.flushSelftest();
    assert.deepEqual(report.tools, ['a', 'b', 'c'], 'tools are sorted and deduped');
    assert.deepEqual(report.commands, ['run']);
    assert.deepEqual(report.services, ['tasks']);
    assert.deepEqual(report.presets, ['preset-sdlc-lead']);
    assert.equal(report.guard.orchestratorPaths[0], '.sdlc/**');
    assert.deepEqual(report.guard.patterns, ['rm -rf /']);
    assert.equal(existsSync(path), true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).tools.length, 3);
  } finally {
    if (previous === undefined) delete process.env.SDLC_SELFTEST;
    else process.env.SDLC_SELFTEST = previous;
    cleanup(dir);
  }
});

test('a non-absolute SDLC_SELFTEST is a start-up error, never a silent pass', () => {
  const previous = process.env.SDLC_SELFTEST;
  try {
    process.env.SDLC_SELFTEST = 'relative/report.json';
    assert.throws(() => selftest.contributeSelftest({ tools: ['x'] }), /must be an absolute path/);
    assert.throws(() => selftest.flushSelftest(), /must be an absolute path/);
  } finally {
    if (previous === undefined) delete process.env.SDLC_SELFTEST;
    else process.env.SDLC_SELFTEST = previous;
  }
});

test('report shape has exactly the documented keys (C.9)', () => {
  const report = selftest.buildSelftestReport();
  assert.deepEqual(Object.keys(report).sort(), ['commands', 'dsh', 'guard', 'presets', 'services', 'tools', 'version']);
});

test('a profile apply() contributes the expected registration surface', async () => {
  const services = await import('../../packages/sdlc-core/src/services.js');
  const dir = tempDir('sdlc-selftest-apply-');
  const previous = process.env.SDLC_SELFTEST;
  try {
    process.env.SDLC_SELFTEST = join(dir, 'report.json');
    const provided = [];
    const ctx = { provide: (name, value) => provided.push(name), logger: { debug() {}, warn() {}, error() {} } };
    const config = { projectRoot: dir, storage: { dbPath: '.sdlc/sdlc.db' }, safety: { instanceLock: false } };
    // apply() is the loader entry and returns nothing (its return would be
    // read as an effect); the runtime handle comes from the same
    // per-project-root singleton apply creates.
    services.apply(ctx, { ...config, service: 'tasks' });
    const runtime = services.getRuntime(config, { projectRoot: dir });
    assert.ok(runtime.db, 'the runtime opened a database');
    assert.ok(provided.includes('sdlc.tasks'));
    const report = selftest.flushSelftest();
    assert.ok(report.services.includes('tasks'));
    runtime.close({ releaseLock: false });
  } finally {
    if (previous === undefined) delete process.env.SDLC_SELFTEST;
    else process.env.SDLC_SELFTEST = previous;
    cleanup(dir);
  }
});
