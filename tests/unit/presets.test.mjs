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

test('the registry row is top-level (id-targeted), never inside insert: (M0-02 live dup)', () => {
  const patch = readFileSync(join(ROOT, 'packages', 'sdlc-presets', 'cordis.patch.yml'), 'utf8');
  // The registry row is FIRST inside insert: (headless has no shipped row to
  // replace — a bare top-level entry warns "not found" and is skipped). On
  // web the composed profile therefore holds two same-id rows at the same
  // service; the loader accepts both (verified live). What the static side
  // pins: exactly one declaration, in first position.
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
