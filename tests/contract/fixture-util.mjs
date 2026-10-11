/**
 * tests/contract/fixture-util.mjs — dependency-free fixture loading for L3.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

export function fixturePath(name) {
  return join(FIXTURE_DIR, name);
}

export function loadFixture(name) {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8'));
}

export function loadText(name) {
  return readFileSync(fixturePath(name), 'utf8');
}

export default { FIXTURE_DIR, fixturePath, loadFixture, loadText };
