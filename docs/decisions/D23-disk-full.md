# D23 — K.5 `DISK_EXHAUSTED` row: detection, evidence, transition, recovery

**Status:** scoped, no decision yet · **Spec:** K.5 fault matrix
(`DISK_EXHAUSTED`), B.12 (recovery), L.5 (degraded modes) · **Track:** D

## Context

The K.5 matrix requires: *"Disk full → write to a size-capped tmpfs worktree;
bootstrap fails with `DISK_EXHAUSTED`; worktree disposed; no partial
dispatch."* Today there is **zero code and zero tests**: no file matches
`DISK_EXHAUSTED|ENOSPC|statvfs|no space` outside unrelated prose, the fault
suite (`tests/fault/`, 8 files) covers kill/corrupt/stale-lock/clock but not
disk, and no transition in `state-machine.js` names disk pressure. A full disk
currently surfaces as an arbitrary bootstrap exception — unclassified, possibly
half-dispatched, with no recovery contract.

## Options

**(a) Pre-flight capacity check + classified failure (recommended).** Before
worktree creation, check available space (via `statvfs`-equivalent: `df` parse
or a probe write) against a configured floor (`execution.minFreeBytes`,
default e.g. 512 MiB); on shortfall, fail the dispatch *before* the
`worker_runs` insert with `{code: 'DISK_EXHAUSTED', available, required}` as
evidence, dispose any partial worktree, and leave the task in `READY` (retryable
when space is freed) — not `ESCALATED`, because no human judgement is needed.
A mid-task `ENOSPC` (caught from a failed write) maps to `FAILED` with the
failing path + `errno` as evidence, eligible for retry after `sdlc resume`.

**(b) Reactive-only: classify `ENOSPC` wherever it surfaces.** No pre-flight;
wrap bootstrap + gate + merge writes so any `ENOSPC`/`EDQUOT` error becomes a
`DISK_EXHAUSTED` event with the same evidence shape. Cheaper (no threshold to
tune, no `df` parsing) but allows partial worktrees and partial dispatches —
exactly what the K.5 row forbids — and recovery must then salvage rather than
merely dispose.

**(c) Delegate to the OS (document as best-effort).** Let the write fail, record
the raw error, rely on `sdlc resume` orphan salvage. Zero new code, but the K.5
row stays red and "no partial dispatch" is unprovable. Not recommended; salvage
is the backstop, not the contract.

## Recommendation

Option (a), with (b)'s `ENOSPC` classification as the mandatory companion: the
pre-flight enforces "no partial dispatch"; the reactive classifier covers the
race (disk fills *during* the task) and reuses the same evidence shape and the
same `FAILED→READY` recovery. Both funnel into the existing orphan-salvage path
(`recovery.js: `findOrphans`/`salvagePlan`) so no new recovery machinery is needed.

## First concrete step

Add `checkDiskSpace(worktreeParent, {minFreeBytes})` to
`packages/sdlc-core/src/project.js` (next to `initProject`), called at the top
of worktree creation; on shortfall return
`{ok:false, code:'DISK_EXHAUSTED', available, required}` and dispose the partial
tree. Failing-first skeleton (cheap, no tmpfs needed — inject the stat):
`tests/fault/disk-full.test.mjs` with the three vectors below.

## Test vectors (failing-first, all offline)

1. **Pre-flight refusal:** `checkDiskSpace` stubbed to report 10 MiB free with a
   512 MiB floor → `initProject`-via-dispatch returns `DISK_EXHAUSTED`, no
   `worker_runs` row is inserted, no worktree directory remains, task stays
   `READY`.
2. **Mid-task ENOSPC:** a fake gate runner throws `{code:'ENOSPC'}` on write →
   attempt is `FAILED` with evidence `{code:'DISK_EXHAUSTED', phase:'gates',
   path, errno:'ENOSPC'}`; `sdlc resume` re-queues the task (`FAILED→READY`
   under retry budget).
3. **Recovery idempotence:** a half-created worktree (marker file, no
   `worker_runs` row) is found by `findOrphans`, snapshotted, disposed, and a
   second `resume` finds nothing to do (no double-dispose, no phantom row).

## Cost / attempt estimate

**S** (small): one check function + one error-code classifier + 3 offline tests;
no schema change (evidence rides the existing `events` payload). 1–2 attempts.

## Acceptance

- [ ] `tests/fault/disk-full.test.mjs` implements the three vectors above and
      fails before the fix, passes after (K.5 row green).
- [ ] `DISK_EXHAUSTED` appears in `events` with `{available, required, phase}`
      and never auto-accepts a task; `READY` (pre-flight) vs `FAILED` (mid-task)
      distinction holds.
- [ ] No partial dispatch is provable: the failing test asserts zero
      `worker_runs` rows and zero worktree residue on pre-flight refusal.
