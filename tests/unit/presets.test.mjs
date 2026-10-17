/**
 * tests/unit/presets.test.mjs — the 26-role registry (spec v3 C.3, M0-06, §53 Test 4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { core, ROOT } from '../lib/helpers.mjs';

const rolesMod = await core.presets();
const { ROLES, ROLE_IDS, ROLE_COUNT, presetRows, presetIdFor, rolesForDomains } = rolesMod;

test('exactly 26 roles, unique ids, one per preset id', () => {
  assert.equal(ROLE_COUNT, 26);
  assert.equal(ROLES.length, 26);
  assert.equal(new Set(ROLE_IDS).size, 26);
  const presetIds = presetRows().filter((r) => /^preset-sdlc-/.test(r.id)).map((r) => r.id);
  assert.equal(new Set(presetIds).size, 26);
  assert.ok(presetIds.every((id) => /^preset-sdlc-/.test(id)));
});

test('the spec §53 roster is present, including the Accessibility Engineer (Test 4)', () => {
  const required = [
    'lead', 'business-analyst', 'solution-architect', 'security-engineer', 'data-engineer',
    'database-engineer', 'ux-designer', 'ui-designer', 'accessibility-engineer', 'frontend-engineer',
    'backend-engineer', 'api-engineer', 'integration-engineer', 'devops-engineer', 'qa-engineer',
    'e2e-engineer', 'visual-qa-engineer', 'technical-writer', 'release-manager', 'code-reviewer',
  ];
  for (const id of required) assert.ok(ROLE_IDS.includes(id), `missing role ${id}`);
  const a11y = ROLES.find((r) => r.id === 'accessibility-engineer');
  assert.match(a11y.owns, /WCAG/);
});

test('every role has a mission, a description, unique order and at least one domain', () => {
  const orders = ROLES.map((r) => r.order);
  assert.equal(new Set(orders).size, 26, 'preset order must be unique');
  for (const role of ROLES) {
    assert.ok(role.name && role.description && role.owns, `${role.id} is incomplete`);
    assert.ok(role.domains.length > 0, `${role.id} has no domains`);
  }
});

test('a preset is a plugin COMPOSITION, not a flat prompt/tools struct (P15)', () => {
  const row = presetRows().find((r) => /^preset-sdlc-/.test(r.id));
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.ok(Array.isArray(row.config.plugins));
  const persona = row.config.plugins.find((p) => p.id === 'persona');
  assert.equal(persona.name, '@deepseek-ai/dsh-persona');
  assert.match(persona.config.prefix, /Verification policy/);
  assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}. Model: {{model}}.');
  // Permissions and model are NOT preset fields (P15/P21).
  assert.equal('permission' in row.config, false);
  assert.equal('model' in row.config, false);
  assert.equal('permissions' in row.config, false);
});

test('worker presets carry no delegation tools; the Lead preset does', () => {
  const byId = new Map(presetRows().map((r) => [r.id, r]));
  const worker = byId.get(presetIdFor('backend-engineer'));
  const names = worker.config.plugins.map((p) => p.id);
  assert.deepEqual(names, ['persona', 'tool-bash', 'tool-fs', 'tool-todo', 'sdlc-report']);
  assert.equal(names.includes('tool-subagent'), false, 'a worker must not delegate');
  const lead = byId.get(presetIdFor('lead'));
  assert.ok(lead.config.plugins.some((p) => p.id === 'tool-subagent'));
});

test('every preset carries the tool configs DSH requires at mount (live guard)', () => {
  // Regression: DSH 0.2.0-rc.2's tool-todo and tool-subagent have NO defaults
  // for these keys. An omitted value fails the whole agent preset at session
  // start ("allowParallelInProgress missing required value" /
  // "provider missing required value"), and every later row in the preset then
  // reports "never started".
  const presets = presetRows().filter((r) => /^preset-sdlc-/.test(r.id));
  assert.equal(presets.length, 26);
  for (const preset of presets) {
    const todo = preset.config.plugins.find((p) => p.id === 'tool-todo');
    assert.ok(todo, `${preset.id}: tool-todo row missing`);
    assert.equal(todo.name, '@deepseek-ai/dsh-tool-todo');
    assert.equal(typeof todo.config?.allowParallelInProgress, 'boolean',
      `${preset.id}: tool-todo requires allowParallelInProgress`);
    const isLead = preset.id === presetIdFor('lead');
    assert.equal(todo.config.allowParallelInProgress, isLead,
      isLead ? 'the Lead fans work out and may track parallel todos' : 'a worker is single-active');
    const subagent = preset.config.plugins.find((p) => p.id === 'tool-subagent');
    if (isLead) {
      assert.ok(subagent, 'the Lead preset must carry tool-subagent');
      assert.equal(subagent.name, '@deepseek-ai/dsh-tool-subagent');
      assert.equal(subagent.config?.provider, 'spawn');
      assert.equal(subagent.config?.toolName, 'subagent');
      assert.equal(subagent.config?.backgroundMode, 'continuable');
    } else {
      assert.equal(subagent, undefined, 'a worker must not delegate');
    }
    // The package ROOT is data only (no `apply`); naming it makes the loader
    // report "never started". The preset rows must name the real tool slices.
    const report = preset.config.plugins.find((p) => p.id === 'sdlc-report');
    assert.equal(report?.name, '@patwoodman/dsh-sdlc-flow-tools/report',
      `${preset.id}: sdlc-report must use the report loader entry`);
    if (isLead) {
      assert.equal(
        preset.config.plugins.find((p) => p.id === 'sdlc-dispatch')?.name,
        '@patwoodman/dsh-sdlc-flow-tools/dispatch',
      );
      assert.equal(
        preset.config.plugins.find((p) => p.id === 'sdlc-plan')?.name,
        '@patwoodman/dsh-sdlc-flow-tools/plan',
      );
    }
  }
});

test('the generated patch carries the required tool configs, not just roles.js', () => {
  const patch = readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml'), 'utf8');
  assert.equal(
    [...patch.matchAll(/name:\s*["']?@deepseek-ai\/dsh-tool-todo["']?\s*\n\s*config:\s*\n\s*allowParallelInProgress:/g)].length,
    26,
    'each of the 26 presets must configure tool-todo inline in the patch',
  );
  assert.match(
    patch,
    /name:\s*["']?@deepseek-ai\/dsh-tool-subagent["']?\s*\n\s*config:\s*\n\s*provider:\s*spawn\b/,
    'the Lead patch row must configure tool-subagent provider',
  );
  // The root package has no `apply`; the loader rejects it with "never started".
  const countName = (name) => patch.split(name).length - 1;
  assert.equal(countName('@patwoodman/dsh-sdlc-flow-tools/report'), 26,
    'every preset must name the report tool slice');
  assert.equal(countName('@patwoodman/dsh-sdlc-flow-tools/dispatch'), 1,
    'only the Lead names the dispatch tool slice');
  assert.equal(countName('@patwoodman/dsh-sdlc-flow-tools/plan'), 1,
    'only the Lead names the plan tool slice');
});

test('presetRows leads with the agent-preset-registry row the headless template lacks', () => {
  const rows = presetRows();
  assert.equal(rows.length, 27, '26 presets + 1 registry');
  assert.equal(rows[0].id, 'agent-preset-registry');
  assert.equal(rows[0].name, '@deepseek-ai/dsh-agent-preset-registry');
  // The default must exist in profiles that ship NO presets (sdk/headless):
  // `standard` exists only on web, so the default is our own lead preset.
  assert.deepEqual(rows[0].config, { default: 'sdlc-lead' });
});

test('the checked-in cordis.patch.yml matches roles.js exactly (generated artifact)', () => {
  const patch = readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml'), 'utf8');
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(preset-sdlc-[A-Za-z0-9-]+)\s*$/gm)].map((m) => m[1]);
  assert.equal(ids.length, 26, 'the patch must declare exactly 26 preset rows');
  assert.deepEqual(ids, ROLES.map((r) => presetIdFor(r.id)));
  assert.match(patch, /id:\s*agent-preset-registry/, 'the registry row the presets wait on must be declared');
});

test('the member presets patch inserts the registry row first (headless/sdk have no shipped row)', () => {
  const patch = readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml'), 'utf8');
  // Headless/sdk templates ship no registry and the dialect has no
  // insert-if-missing, so the MEMBER patch must insert it. The lead meta-bundle
  // is different: web ships the row, so gen-bundle-patch converts this insert
  // into a top-level override — a duplicate id+name is loader-accepted but
  // blocks the plugin manager's uninstall audit.
  const insertBlock = patch.slice(patch.indexOf('- insert:'));
  const firstRow = insertBlock.match(/-\s*id:\s*(.+)/)?.[1]?.trim();
  assert.equal(firstRow, 'agent-preset-registry', 'registry must be the first inserted row');
  const count = [...patch.matchAll(/id:\s*agent-preset-registry/g)].length;
  assert.equal(count, 1, 'exactly one registry declaration in the patch file');
});

test('the patch declares no duplicate loader row ids (E4 regression guard)', () => {
  const patch = readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml'), 'utf8');
  // Loader rows live at indent 4 under `- insert:`; nested plugin rows are deeper.
  const ids = [...patch.matchAll(/^ {4}- id:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.equal(ids.length, 28, '1 registry + 26 presets + 1 self-report row inside insert:');
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  assert.deepEqual([...counts].filter(([, n]) => n > 1), []);
});

test('the patch ends with the self-report plugin row (live probe needs it)', () => {
  const patch = readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml'), 'utf8');
  const ids = [...patch.matchAll(/^ {4}- id:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.equal(ids[ids.length - 1], 'sdlc-presets', 'self-report row is last (report flushes after all bundles)');
  // Derive the package name instead of quoting it, so a publish-scope rename
  // (scripts/set-scope.mjs) cannot leave this assertion behind.
  const self = JSON.parse(readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'package.json'), 'utf8')).name;
  assert.ok(
    patch.includes(`id: sdlc-presets`) && patch.includes(`${self}/plugin`),
    `the self-report row must name ${self}/plugin`,
  );
});

test('team composition is structural: rolesForDomains never invents a role', () => {
  assert.deepEqual(rolesForDomains([]), ['backend-engineer'], 'a fallback, not a standing roster');
  const ui = rolesForDomains(['ux-ui']);
  assert.ok(ui.includes('accessibility-engineer'));
  assert.ok(ui.includes('ux-designer'));
  assert.ok(!ui.includes('database-engineer'));
});
