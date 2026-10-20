/**
 * tests/unit/ui-locales.test.mjs — dictionary parity and key coverage.
 *
 * The panel renders entirely through the `sdlc` locale namespace. A key added
 * to one dictionary but not the other (or referenced from JSX but absent from
 * both) would render a raw key in the sidebar, so it fails here instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NS, en, zh } from '../../packages/sdlc-client-ui/src/client/locales.js';
import { CONFIG_FIELDS } from '../../packages/sdlc-client-ui/src/client/config-fields.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PANELS = readFileSync(join(ROOT, 'packages/sdlc-client-ui/src/client/panels.jsx'), 'utf8');
const TAB = readFileSync(join(ROOT, 'packages/sdlc-client-ui/src/client/SdlcTab.jsx'), 'utf8');
const DEFINITION = readFileSync(join(ROOT, 'packages/sdlc-client-ui/src/client/definition.js'), 'utf8');

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test('the namespace is stable and both dictionaries have identical key sets', () => {
  assert.equal(NS, 'sdlc');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('every dictionary value is non-empty and placeholders match across languages', () => {
  for (const key of Object.keys(en)) {
    assert.equal(typeof en[key], 'string', `${key} is a string`);
    assert.ok(en[key].trim().length > 0, `${key} has English text`);
    assert.ok(zh[key].trim().length > 0, `${key} has Chinese text`);
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} placeholders match`);
  }
});

test('every static t() key used by the shell and panels exists in both dictionaries', () => {
  const sources = [PANELS, TAB, DEFINITION];
  const used = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1]);
  }
  // Dynamic key families.
  for (const panel of ['flow', 'tasks', 'review', 'settings']) used.add(`panel.${panel}`);
  for (const state of ['BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING', 'ACCEPTED', 'MERGING', 'DONE', 'FAILED', 'ESCALATED', 'BLOCKED', 'CANCELLED', 'UNKNOWN']) {
    used.add(`state.${state}`);
  }
  for (const group of ['execution', 'budgets', 'verification', 'escalation', 'observability']) used.add(`config.group.${group}`);
  for (const project of ['DISCOVERY', 'PLANNING', 'IMPLEMENTATION', 'REVIEW', 'DONE', 'BLOCKED', 'PAUSED', 'FAILED']) used.add(`project.${project}`);
  for (const field of CONFIG_FIELDS) {
    used.add(field.labelKey);
    if (field.hintKey) used.add(field.hintKey);
  }
  const missingEn = [...used].filter((key) => !(key in en)).sort();
  const missingZh = [...used].filter((key) => !(key in zh)).sort();
  assert.deepEqual(missingEn, [], `missing English keys: ${missingEn.join(', ')}`);
  assert.deepEqual(missingZh, [], `missing Chinese keys: ${missingZh.join(', ')}`);
});

test('the removed duplicate panels no longer ship locale surface', () => {
  assert.ok(!('panel.status' in en), 'no Status tab copy');
  assert.ok(!('panel.board' in en), 'no Board tab copy');
  assert.ok('flow.attentionTitle' in en);
  assert.ok('tasks.search' in en);
  assert.ok('review.pickRunA' in en);
  assert.ok('config.group.execution' in en);
});
