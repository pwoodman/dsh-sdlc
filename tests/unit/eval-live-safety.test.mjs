/**
 * tests/unit/eval-live-safety.test.mjs — the live arm's guard rails.
 *
 * Every test here exists because a live study could otherwise spend money and
 * produce a confident-looking report from runs that never happened:
 *   - the arm profiles must be real, headless, and differ only by the plugin;
 *   - `dsh` must be invoked the way the real CLI is invoked (no `--model`);
 *   - a failed run must be marked invalid, and the study must stop.
 * A fake `spawn` stands in for `dsh`, so none of this contacts a model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preflightProfiles, armOrder, runDsh, runEvaluation } from '../../eval/run.mjs';
import { ARMS } from '../../eval/lib/records.mjs';

const TASKS_DIR = join(dirname(import.meta.dirname), '..', 'eval', 'tasks');
const HEADLESS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'];
const WITH_PLUGIN = [...HEADLESS, '@sdlc/orchestrator-core', '@sdlc/orchestrator-tools'];

function makeProfile(home, name, bundles) {
  const dir = join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles } } }, null, 2));
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'eval-live-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('preflight accepts a headless control and a headless treatment that differs by the plugin', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', HEADLESS);
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    assert.deepEqual(preflightProfiles({ baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home }), []);
  });
});

test('preflight refuses a missing profile', () => {
  withHome((home) => {
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    const problems = preflightProfiles({ baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /does not exist/);
  });
});

test('preflight refuses a non-headless profile', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    assert.match(preflightProfiles({ baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home })[0], /not headless-template/);
  });
});

test('preflight refuses a treatment that is not actually treated', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', HEADLESS);
    makeProfile(home, 'eval-treatment', HEADLESS);
    assert.match(preflightProfiles({ baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home })[0], /composes no @sdlc/);
  });
});

test('preflight refuses a control that already contains the plugin', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', WITH_PLUGIN);
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    assert.match(preflightProfiles({ baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home })[0], /would not be a control/);
  });
});

test('arm order is seeded, deterministic, and not fixed', () => {
  assert.deepEqual(armOrder('t1', 0, 'seed'), armOrder('t1', 0, 'seed'));
  assert.deepEqual([...armOrder('t1', 0, 'seed')].sort(), [...ARMS].sort());
  const orders = new Set();
  for (let r = 0; r < 40; r += 1) orders.add(armOrder('t1', r, 'seed').join(','));
  assert.equal(orders.size, 2, 'both orders must occur across repeats, or the order is fixed');
});

test('runDsh passes the patch overlay and never --model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-argv-'));
  try {
    let captured = null;
    const spawn = (cmd, args, opts) => {
      captured = { cmd, args, opts };
      return { status: 0, stdout: '{"type":"final","text":"ok"}\n', stderr: '' };
    };
    const task = { id: 't', requirement: 'do the thing', budget: { maxWallClockMs: 1000 } };
    const r = runDsh({ task, arm: 'control', profile: 'eval-control', workspace: dir, patchPath: '/tmp/patch.yml', dshHome: dir, model: 'm', provider: 'p', spawn, now: () => 0 });
    assert.deepEqual(r.argv, ['dsh', '--profile', 'eval-control', '--patch', '/tmp/patch.yml', '--json', 'do the thing']);
    assert.equal(r.argv.includes('--model'), false, 'the real dsh has no --model flag');
    assert.equal(captured.opts.cwd, dir);
    assert.equal(r.status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live run receives a MATERIALISED fixture (regression: the pilot ran on an empty dir)', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', HEADLESS);
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    const seen = [];
    // A spawn that records what the agent would actually have seen on disk.
    const spawn = (cmd, args, opts) => {
      seen.push({ arm: opts.env.SDLC_EVAL_ARM, readme: existsSync(join(opts.cwd, 'README.md')), files: readdirSync(opts.cwd) });
      return { status: 0, stdout: '{"type":"final","text":"done"}\n', stderr: '' };
    };
    const out = runEvaluation({
      tasksDir: TASKS_DIR, outDir: join(home, 'out'), executor: 'dsh', repeats: 1, taskFilter: 'control-docs-typo',
      baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home,
      spawn, environment: {}, log: () => {},
    });
    assert.equal(seen.length, 2, 'both arms ran');
    assert.ok(seen.every((s) => s.readme), 'the fixture must exist before the agent starts, in every arm');
    assert.ok(seen.every((s) => s.files.includes('package.json')));
    for (const rec of out.records) assert.equal(rec.artifacts.fixtureMethod, 'greenfield-seed-files');
    // The metrics are collected over a real repository, not an empty directory.
    assert.ok(out.records.every((r) => r.metrics.loc.available), 'loc must be measurable over the seeded fixture');
  });
});

test('a failed fixture materialisation invalidates the run instead of running the agent on nothing', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', HEADLESS);
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    const outDir = join(home, 'out');
    let spawned = 0;
    const spawn = () => { spawned += 1; return { status: 0, stdout: '{}\n', stderr: '' }; };
    // A repo fixture with no URL cannot be materialised.
    const tasksDir = join(home, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    // A repo fixture whose clone genuinely fails: the agent must never start.
    writeFileSync(join(tasksDir, 'broken.json'), JSON.stringify({
      id: 'broken', title: 'broken', dimension: ['code-quality'],
      requirement: 'Fix the misspelled word in the README file.',
      fixture: { kind: 'repo', repoUrl: join(home, 'no-such-repo'), commit: 'deadbeef' },
      acceptance: { checks: [{ id: 'c', kind: 'file-exists', path: 'README.md' }] },
      metrics: ['loc'], budget: { maxWallClockMs: 1000 }, strata: { risk: 'R1', size: 'S' },
    }));
    assert.throws(
      () => runEvaluation({
        tasksDir, outDir, executor: 'dsh', repeats: 1,
        baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home,
        spawn, environment: {}, log: () => {},
      }),
      /ABORTED/,
    );
    assert.equal(spawned, 0, 'no model may be invoked when the fixture could not be built');
    const rec = JSON.parse(readFileSync(join(outDir, 'records.jsonl'), 'utf8').trim());
    assert.equal(rec.status, 'invalid');
    assert.match(rec.executorError, /fixture could not be materialised/);
  });
});

test('runDsh marks a non-zero exit invalid and keeps stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-invalid-'));
  try {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'error: unknown option\n' });
    const r = runDsh({ task: { id: 't', requirement: 'x' }, arm: 'control', profile: 'p', workspace: dir, dshHome: dir, spawn, now: () => 0 });
    assert.equal(r.status, 'invalid');
    assert.equal(r.executorError, 'dsh exited 1');
    assert.match(r.stderr, /unknown option/);
    assert.equal(r.tokensIn, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDsh marks a clean exit with no stream invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-nostream-'));
  try {
    const spawn = () => ({ status: 0, stdout: '', stderr: '' });
    const r = runDsh({ task: { id: 't', requirement: 'x' }, arm: 'control', profile: 'p', workspace: dir, dshHome: dir, spawn, now: () => 0 });
    assert.equal(r.status, 'invalid');
    assert.match(r.executorError, /emitted no NDJSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live study aborts on the first invalid run and keeps that evidence', () => {
  withHome((home) => {
    makeProfile(home, 'eval-control', HEADLESS);
    makeProfile(home, 'eval-treatment', WITH_PLUGIN);
    const outDir = join(home, 'out');
    const spawn = () => ({ status: 1, stdout: '', stderr: 'profile exploded\n' });
    assert.throws(
      () => runEvaluation({
        tasksDir: TASKS_DIR, outDir, executor: 'dsh', repeats: 1, taskFilter: 'control-docs-typo',
        baselineProfile: 'eval-control', treatmentProfile: 'eval-treatment', dshHome: home,
        spawn, environment: {}, log: () => {},
      }),
      /ABORTED/,
    );
    const lines = readFileSync(join(outDir, 'records.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'only the failing run is recorded, then the study stops');
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.status, 'invalid');
    assert.equal(rec.executorError, 'dsh exited 1');
    assert.deepEqual(rec.metrics, {}, 'a run that never happened contributes no metrics');
    assert.equal(rec.acceptance.total, 0);
    assert.equal(existsSync(join(outDir, 'model-patch.yml')), false, 'no model pin was requested');
  });
});
