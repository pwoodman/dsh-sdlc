/**
 * tests/fault/disk-full.test.mjs — K.5 fault matrix row: DISK_EXHAUSTED (D23).
 *
 * SKELETON (scoped, Track D): the implementation does not exist yet — there is
 * no `checkDiskSpace` export, no ENOSPC classifier, and no DISK_EXHAUSTED event.
 * These three vectors are checked in with `skip` + reason (repo precedent:
 * M6-06 asserts the compensating policy, then skips) so the suite stays green
 * while the contract is pinned. Step zero of the implementing track is to
 * remove the `skip` flags and drive them red → green.
 *
 * Spec: K.5 ("bootstrap fails with DISK_EXHAUSTED; worktree disposed; no
 * partial dispatch"), B.12 (recovery), L.5 (degraded modes).
 * Decision: docs/decisions/D23-disk-full.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, tempDir } from '../lib/helpers.mjs';

const SKIP = 'D23 unimplemented: checkDiskSpace / ENOSPC classifier not yet implemented (see docs/decisions/D23-disk-full.md)';

test('disk pre-flight refusal: no worker_runs row, no worktree residue, task stays READY', { skip: SKIP }, async (t) => {
  const { initProject } = await core.project();
  const { checkDiskSpace } = await core.project();
  assert.equal(typeof checkDiskSpace, 'function', 'checkDiskSpace is exported');
  const dir = tempDir('sdlc-disk-');
  const verdict = checkDiskSpace(dir, { minFreeBytes: 512 * 1024 * 1024, freeBytes: 10 * 1024 * 1024 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'DISK_EXHAUSTED');
  // No worker_runs row, no worktree residue, task stays READY — asserted
  // against the runtime once the launcher calls checkDiskSpace pre-insert.
});

test('mid-task ENOSPC: attempt FAILED with DISK_EXHAUSTED evidence, resume re-queues', { skip: SKIP }, async (t) => {
  const { runVerification } = await core.gates();
  const enospc = () => { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; };
  // A fake writer throwing ENOSPC must surface as FAILED + {code:'DISK_EXHAUSTED', phase, path, errno:'ENOSPC'}.
  assert.equal(typeof runVerification, 'function');
});

test('recovery idempotence: half-created worktree salvaged once, second resume is a no-op', { skip: SKIP }, async (t) => {
  const { findOrphans, salvagePlan } = await core.recovery();
  assert.equal(typeof findOrphans, 'function');
  assert.equal(typeof salvagePlan, 'function');
  // A half-created worktree (marker file, no worker_runs row) is snapshotted +
  // disposed exactly once; a second resume finds nothing to do.
});
