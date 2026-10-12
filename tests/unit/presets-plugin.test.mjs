/**
 * tests/unit/presets-plugin.test.mjs — preset declaration + the shared selftest
 * boot hook (spec v3 C.3, C.9, M0-02/M0-06).
 *
 * Exercises packages/sdlc-presets/src/plugin.js (never imported before) and the
 * three intentionally DUPLICATED selftest helper copies, which must merge into
 * ONE globalThis accumulator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, tempDir, cleanup, ROOT } from '../lib/helpers.mjs';

const plugin = await load('packages/sdlc-presets/src/plugin.js');
const roles = await load('packages/sdlc-presets/src/roles.js');
const coreSelftest = await load('packages/sdlc-core/src/selftest.js');

function withSelftestPath(fn) {
  const previous = process.env.SDLC_SELFTEST;
  const dir = tempDir('sdlc-presets-selftest-');
  const path = join(dir, 'report.json');
  process.env.SDLC_SELFTEST = path;
  try {
    return fn(path);
  } finally {
    if (previous === undefined) delete process.env.SDLC_SELFTEST;
    else process.env.SDLC_SELFTEST = previous;
    cleanup(dir);
  }
}

test('declaredPresetIds returns exactly the 26 ids from cordis.patch.yml, matching roles.js', () => {
  const ids = plugin.declaredPresetIds();
  assert.equal(ids.length, 26);
  assert.equal(new Set(ids).size, 26, 'ids are unique');
  assert.ok(ids.every((id) => /^preset-sdlc-[a-z0-9-]+$/.test(id)));

  const fromRoles = roles.ROLE_IDS.map((roleId) => roles.presetIdFor(roleId));
  assert.equal(roles.ROLE_COUNT, 26);
  assert.deepEqual([...ids].sort(), [...fromRoles].sort());

  const text = readFileSync(join(ROOT, 'packages/sdlc-presets/cordis.patch.yml'), 'utf8');
  for (const id of ids) assert.match(text, new RegExp(`id:\\s*${id}\\b`), `${id} is declared in the patch`);
});

test('plugin re-exports the roster surface', () => {
  assert.equal(plugin.ROLES, roles.ROLES);
  assert.deepEqual(plugin.ROLE_IDS, roles.ROLE_IDS);
  assert.equal(plugin.ROLE_COUNT, 26);
  assert.equal(plugin.presetRows, roles.presetRows);
  assert.equal(plugin.presetIdFor, roles.presetIdFor);
});

test('apply contributes the full roster to the selftest report', () => {
  withSelftestPath((path) => {
    // apply() is the loader entry and returns nothing (its return would be
    // read as an effect); the roster comes from declaredPresetIds().
    assert.equal(plugin.apply({ provide() {} }, {}), undefined);
    const presets = plugin.declaredPresetIds();
    assert.equal(presets.length, 26);

    const report = coreSelftest.flushSelftest();
    assert.equal(report.presets.length, 26);
    assert.deepEqual([...report.presets].sort(), [...presets].sort());
    assert.equal(coreSelftest.selftestWritten(), true);

    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(onDisk.presets.length, 26);
  });
});

test('inert without SDLC_SELFTEST: apply still declares the roster but writes no report', () => {
  const previous = process.env.SDLC_SELFTEST;
  delete process.env.SDLC_SELFTEST;
  try {
    const dir = tempDir('sdlc-presets-inert-');
    try {
      plugin.apply({}, {});
      assert.equal(plugin.declaredPresetIds().length, 26);
      assert.equal(coreSelftest.flushSelftest(), null);
    } finally {
      cleanup(dir);
    }
  } finally {
    if (previous !== undefined) process.env.SDLC_SELFTEST = previous;
  }
});

test('the duplicated selftest copies are import-safe and merge into ONE accumulator', async () => {
  const toolsSelftest = await load('packages/sdlc-tools/src/selftest.js');
  const presetsSelftest = await load('packages/sdlc-presets/src/selftest.js');

  assert.notEqual(toolsSelftest, coreSelftest, 'these are separate module instances');
  for (const mod of [toolsSelftest, presetsSelftest]) {
    assert.equal(typeof mod.contributeSelftest, 'function');
    assert.equal(typeof mod.buildSelftestReport, 'function');
    assert.equal(typeof mod.flushSelftest, 'function');
  }

  withSelftestPath((path) => {
    toolsSelftest.contributeSelftest({ tools: ['copy-tools-tool'], commands: ['copy-tools-cmd'] });
    presetsSelftest.contributeSelftest({ presets: ['copy-presets-preset'], services: ['copy-presets-svc'] });

    const report = coreSelftest.flushSelftest();
    assert.ok(report.tools.includes('copy-tools-tool'), 'tools copy contribution is visible to core');
    assert.ok(report.commands.includes('copy-tools-cmd'));
    assert.ok(report.presets.includes('copy-presets-preset'), 'presets copy contribution is visible to core');
    assert.ok(report.services.includes('copy-presets-svc'));

    // Each copy sees the SAME globalThis state, whichever flushed.
    assert.deepEqual(toolsSelftest.buildSelftestReport().presets, report.presets);
    assert.deepEqual(presetsSelftest.buildSelftestReport().tools, report.tools);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).tools.includes('copy-tools-tool'), true);
  });
});
