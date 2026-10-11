/**
 * tests/contract/schemas.test.mjs — L3: every versioned schema document validates
 * its valid fixture and rejects its invalid fixture.
 *
 * This file also carries the negative controls for the validator itself: a
 * validator that accepts everything would make every other contract test
 * meaningless, so the harmful cases are asserted explicitly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  schemas,
  fixtureFiles,
  validate,
  formatErrors,
  taskContractSchema,
  workerResultSchema,
  outboxSchema,
  evidenceBundleSchema,
} from './schemas.mjs';
import { loadFixture } from './fixture-util.mjs';

for (const [name, paths] of Object.entries(fixtureFiles)) {
  const schema = schemas[name];

  test(`schema:${name} accepts its valid fixture`, () => {
    const result = validate(schema, loadFixture(paths.valid));
    assert.ok(result.ok, formatErrors(result, `${name} valid fixture`));
  });

  test(`schema:${name} rejects its invalid fixture`, () => {
    const result = validate(schema, loadFixture(paths.invalid));
    assert.equal(result.ok, false, `${name} invalid fixture must be rejected`);
    assert.ok(result.errors.length > 0, 'a rejection must carry at least one error');
  });
}

test('schema set: the seven seam documents are published and versioned', () => {
  assert.deepEqual(
    Object.keys(schemas).sort(),
    ['elevationResponse', 'evidenceBundle', 'gateResultSet', 'outbox', 'reviewVerdict', 'taskContract', 'workerResult'],
  );
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${name} draft`);
    assert.match(String(schema.$id), /^https:\/\/sdlc\.dev\/schemas\//, `${name} $id`);
    assert.equal(typeof schema['x-contract-version'], 'string', `${name} carries a version`);
  }
});

// ── negative controls: the validator must be able to fail ──────────────────

test('negative control: empty document fails every required-field schema', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const result = validate(schema, {});
    assert.equal(result.ok, false, `${name} must reject {}`);
  }
});

test('negative control: additionalProperties:false is enforced on the outbox', () => {
  const forged = { ...loadFixture('outbox.valid.json'), forgedBy: 'worker' };
  const result = validate(outboxSchema, forged);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('additional property')), formatErrors(result));
});

test('negative control: oneOf requires exactly one matching branch', () => {
  const ambiguous = { any: true };
  const schema = {
    oneOf: [
      { type: 'object', required: [] },
      { type: 'object', required: [] },
    ],
  };
  assert.equal(validate(schema, ambiguous).ok, false, 'two matching branches is not oneOf');

  const none = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.equal(validate(none, true).ok, false);
  assert.equal(validate(none, 'ok').ok, true);
  assert.equal(validate(none, 3).ok, true);
});

test('negative control: enum, const, pattern and bounds are enforced', () => {
  assert.equal(validate({ enum: ['a', 'b'] }, 'c').ok, false);
  assert.equal(validate({ const: 1 }, 2).ok, false);
  assert.equal(validate({ type: 'string', pattern: '^[A-Z]+$' }, 'abc').ok, false);
  assert.equal(validate({ type: 'integer', minimum: 1 }, 0).ok, false);
  assert.equal(validate({ type: 'number', maximum: 5 }, 6).ok, false);
  assert.equal(validate({ type: 'string', minLength: 1 }, '').ok, false);
  assert.equal(validate({ type: ['string', 'null'] }, null).ok, true);
});

test('negative control: a malformed task contract (bad id, missing role) is rejected', () => {
  const contract = loadFixture('task-contract.valid.json');
  assert.equal(validate(taskContractSchema, contract).ok, true);

  const broken = { ...contract, id: 'api-042' };
  const result = validate(taskContractSchema, broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.endsWith('.id')), formatErrors(result));

  const missingRole = { ...contract };
  delete missingRole.role;
  assert.equal(validate(taskContractSchema, missingRole).ok, false);
});

test('negative control: worker result without runtime-derived files_changed is rejected', () => {
  const result = loadFixture('worker-result.valid.json');
  assert.equal(validate(workerResultSchema, result).ok, true);

  const missing = { ...result };
  delete missing.files_changed;
  const invalid = validate(workerResultSchema, missing);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((e) => e.path.endsWith('.files_changed')));
});

test('K.10: evidence bundle shape validates and a bad counter is rejected', () => {
  const valid = loadFixture('evidence-bundle.valid.json');
  assert.equal(validate(evidenceBundleSchema, valid).ok, true);
  assert.equal(valid.failed, 0);
  assert.ok(valid.results.some((r) => r.status === 'skip' && r.detail), 'a skip carries its reason');

  const bad = loadFixture('evidence-bundle.invalid.json');
  assert.equal(validate(evidenceBundleSchema, bad).ok, false);
});
