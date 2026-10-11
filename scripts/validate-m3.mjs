#!/usr/bin/env node
/**
 * scripts/validate-m3.mjs — M3 gate: verify (spec v3 D.0).
 *
 * Each gate type runs and produces evidence; a false DONE claim is rejected by
 * RUNTIME evidence; acceptance-criteria mapping is complete; an independent
 * review verdict is recorded; skipped gates carry `skipped:<reason>`.
 *
 *   node scripts/validate-m3.mjs [--json <path>] [--fail-fast]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSuite, EXIT } from './lib/harness.mjs';
import { importPkg, withDir, fakeRunner } from './lib/gate-helpers.mjs';

const gates = await importPkg('packages/sdlc-core/src/gates.js');
const verifier = await importPkg('packages/sdlc-core/src/verifier.js');
const workerResult = await importPkg('packages/sdlc-core/src/worker-result.js');
const risk = await importPkg('packages/sdlc-core/src/risk.js');

const FULL_GATES = { syntax: { command: ['node', '--check'] }, lint: { command: ['lint'] }, unit: { command: ['unit'] }, integration: { command: ['integration'] }, api: { command: ['api'] } };

const checks = [
  {
    id: 'M3-01-gate-types-produce-evidence',
    title: 'each gate type runs and produces a per-gate evidence log',
    fn() {
      return withDir(async (dir) => {
        const logDir = join(dir, '.sdlc', 'verification', 'T-1');
        const result = gates.runVerification({
          cwd: dir, logDir, config: { verification: { gates: FULL_GATES } },
          gates: ['syntax', 'lint', 'unit', 'integration', 'api'], runner: fakeRunner(),
        });
        if (result.overall !== 'pass') throw new Error('expected all gates to pass');
        for (const gate of ['syntax', 'lint', 'unit', 'integration', 'api']) {
          if (result.gates[gate].status !== 'pass') throw new Error(`${gate} did not pass`);
          if (!existsSync(join(logDir, `${gate}.log`))) throw new Error(`${gate} produced no log`);
          const log = readFileSync(join(logDir, `${gate}.log`), 'utf8');
          if (!log.includes('exit 0')) throw new Error(`${gate} log does not record the exit code`);
        }
        return { detail: '5 gate types executed; 5 evidence logs written' };
      }, 'sdlc-m3-gates-');
    },
  },
  {
    id: 'M3-02-false-done-claim-rejected',
    title: 'a false DONE claim is rejected by runtime evidence (spec Test 7)',
    fn() {
      const decision = verifier.decideAcceptance({
        riskClass: 'R3',
        gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' }, integration: { status: 'pass' }, visual: { status: 'fail:1' } },
        scope: { ok: true, code: 'IN_SCOPE' },
        review: { verdict: 'reject', reason: 'mobile overflow at 390x844' },
        filesChanged: ['src/ui/button.css', 'tests/ui/button.test.ts'],
        claims: { status: 'completed', summary: 'looks great' },
        runtimeStatus: 'completed',
      });
      if (decision.accept) throw new Error('a failing visual gate was accepted');
      if (decision.code !== 'GATE_FAILED') throw new Error(`expected GATE_FAILED, got ${decision.code}`);

      // The claim itself is also checked against the runtime status.
      const lying = verifier.decideAcceptance({
        riskClass: 'R2', gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' }, integration: { status: 'pass' } },
        scope: { ok: true, code: 'IN_SCOPE' }, review: { verdict: 'accept' },
        filesChanged: ['src/a.ts', 'tests/a.test.ts'], claims: { status: 'completed' }, runtimeStatus: 'failed',
      });
      if (lying.code !== 'FALSE_DONE_CLAIM') throw new Error(`expected FALSE_DONE_CLAIM, got ${lying.code}`);
      return { detail: 'gate failure and runtime-status disagreement both reject' };
    },
  },
  {
    id: 'M3-03-acceptance-criteria-mapping',
    title: 'every acceptance criterion is mapped to a check and appears in the evidence',
    fn() {
      const criteria = [
        { id: 'AC1', statement: 'valid payload accepted', check: 'integration:test_valid' },
        { id: 'AC2', statement: 'invalid payload rejected', check: 'unit:test_invalid' },
      ];
      for (const ac of criteria) {
        if (!ac.id || !ac.statement || !ac.check) throw new Error(`criterion ${ac.id} is unmapped`);
      }
      const claims = [
        { ac_id: 'AC1', claim: 'pass', artifact: 'src/api/customers.ts' },
        { ac_id: 'AC2', claim: 'pass', artifact: 'src/api/validate.ts' },
      ];
      const mapped = new Set(claims.map((c) => c.ac_id));
      const unmapped = criteria.filter((ac) => !mapped.has(ac.id));
      if (unmapped.length) throw new Error(`unmapped criteria: ${unmapped.map((a) => a.id).join(', ')}`);
      const result = workerResult.deriveWorkerResult({
        filesChanged: ['src/api/customers.ts', 'src/api/validate.ts'], contract: { allowed_paths: ['src/**'] },
        claims: { status: 'completed', evidence_claims: claims }, runtime: { exitCode: 0 },
      });
      if (result.evidence_claims.length !== 2) throw new Error('claims were dropped (regression: object claims)');
      return { detail: '2 criteria → 2 claims preserved through derivation' };
    },
  },
  {
    id: 'M3-04-independent-review-verdict',
    title: 'an independent review verdict is recorded and enforced',
    fn() {
      const parsed = verifier.parseReviewVerdict(JSON.stringify({ verdict: 'accept', reviewer: 'code-reviewer', reason: 'ok' }));
      if (!parsed.ok) throw new Error('a valid verdict was rejected');
      if (parsed.value.reviewer !== 'code-reviewer') throw new Error('reviewer not recorded');
      const missing = verifier.decideAcceptance({
        riskClass: 'R2', gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' }, integration: { status: 'pass' } },
        scope: { ok: true, code: 'IN_SCOPE' }, review: null, filesChanged: ['src/a.ts', 'tests/a.test.ts'],
        claims: { status: 'completed' }, runtimeStatus: 'completed',
      });
      if (missing.code !== 'REVIEW_REJECTED') throw new Error('a missing review was accepted');
      // R1 is the only class that does not require an independent review.
      const r1 = verifier.decideAcceptance({
        riskClass: 'R1', gateResults: { syntax: { status: 'pass' }, lint: { status: 'pass' }, unit: { status: 'pass' } },
        scope: { ok: true, code: 'IN_SCOPE' }, review: null, filesChanged: ['src/a.ts', 'tests/a.test.ts'],
        claims: { status: 'completed' }, runtimeStatus: 'completed',
      });
      if (!r1.accept) throw new Error(`R1 should not require review: ${r1.code}`);
      return { detail: 'verdict parsed, recorded, mandatory above R1' };
    },
  },
  {
    id: 'M3-05-skipped-gates-are-evidence',
    title: 'skipped gates carry skipped:<reason> and R3+ UI work BLOCKS',
    fn() {
      return withDir(async (dir) => {
        const result = gates.runVerification({
          cwd: dir, logDir: join(dir, 'v'),
          config: { verification: { gates: { syntax: { command: ['x'] }, e2e: { skip: true, reason: 'no-browser-stack' }, visual: { kind: 'playwright' } } } },
          gates: ['syntax', 'e2e', 'visual'], runner: fakeRunner(),
        });
        if (result.gates.e2e.status !== 'skipped:no-browser-stack') throw new Error(`wrong skip reason: ${result.gates.e2e.status}`);
        if (result.gates.visual.status !== 'skipped:playwright') throw new Error(`wrong visual skip: ${result.gates.visual.status}`);
        const required = risk.requiredGates('R3', { uiChange: true, hasBrowserStack: false });
        if (!risk.blockedBySkippedGate('R3', required)) throw new Error('a skipped UI gate did not block R3');
        const decision = verifier.decideAcceptance({
          riskClass: 'R3', gateResults: { syntax: { status: 'pass' } }, scope: { ok: true, code: 'IN_SCOPE' },
          review: { verdict: 'accept' }, filesChanged: ['src/ui/a.tsx', 'tests/ui/a.test.tsx'],
          claims: { status: 'completed' }, runtimeStatus: 'completed', blockedBySkippedGate: true,
        });
        if (decision.status !== 'BLOCKED') throw new Error(`expected BLOCKED, got ${decision.status}`);
        return { detail: 'skips are explicit evidence; R3+ UI blocks rather than auto-accepts' };
      }, 'sdlc-m3-skips-');
    },
  },
];

process.exit(await runSuite({ name: 'SDLC M3 verification gate', version: '1.0.0', checks }));
