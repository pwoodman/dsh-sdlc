# D21 — Execution seams: implement `ctx.subprocess` / `ctx.subagents`

**Status:** scoped, no decision yet · **Spec:** C.2 (runtime topology) · **Track:** D (Tier D, large spec gap)

## Context

Spec C.2 names two execution seams. The **primary** seam (parallel, code-changing
work) is `ctx.subprocess.spawn({argv: ['dsh', '--profile', 'sdlc-worker', …]})`
with an explicit scrubbed env; the **secondary** seam (cheap same-tree work:
docs, tests, small edits) is `ctx.subagents.start()` one-shot children whose
results arrive via `SubagentResult.output`/`structured` (P9/P32).

Today **zero call sites** exist. `packages/sdlc-core/src/worker-mgr.js` models
*both* halves of the primary seam in pure functions (`buildWorkerEnv` at :33,
`buildSpawnArgv` at :67, `scrubEnv` at :18 — all pinned by
`tests/unit/worker-mgr.test.mjs`) but nothing ever calls `ctx.subprocess.spawn`.
The only `spawnSync` users are the *gate runner* (`gates.js:211`) and the
*installer* (`project.js:45`) — argv-shaped, blocking, local-tool invocations,
not worker dispatch. No file references `ctx.subagents` at all. Meanwhile
`createHandlers` (`packages/sdlc-tools/src/index.js:179`) already writes
worktree outbox proposals, so the *result-ingest* side is ready; only the
*launch* side is missing.

## Options

**(a) `ctx.subprocess.spawn` passthrough with scrubbed env (recommended).**
Wire a `launchWorker({task, worktree, tierOverlay})` into the runtime that calls
`ctx.subprocess.spawn(buildSpawnArgv({…}), {cwd: worktree,
env: buildWorkerEnv({…}).env})`, stores the pid/session in `worker_runs`, and
streams NDJSON through the existing `parseNdjson`/`classifyExit` helpers. The
pure half already exists and is tested; this option adds only the thin
`ctx`-bound call plus `worker_runs` bookkeeping. Matches the spec's primary
seam exactly (E5/P25 scrub, E8 `--session-id` retry, P32 uncapped `final`).
Needs a DSH integration test (mock `ctx`), so attempt count is 2–3.

**(b) Out-of-process `dsh --profile sdlc-worker` argv via `node:child_process`.**
Reuse `buildSpawnArgv` with `spawn`/`execFile` from the orchestrator process
instead of `ctx.subprocess`. Works without a live DSH host (good for headless
CI), but bypasses the platform scrub/audit contract, duplicates stdio/session
handling the host already provides, and contradicts the C.2 decision that
"`ctx.subprocess.spawn`" is the seam (the argv is the *payload*, not the
*mechanism*). Keep as a fallback if `ctx.subprocess` proves unavailable on a
target runtime.

**(c) Keep in-process + document as deviation.** Implement the scheduler's
`ASSIGNED→IN_PROGRESS` transition by invoking handlers in-process and declare
C.2's process seam a deviation. Cheapest (1 attempt) but surrenders crash
containment, per-process cwd sandboxing (P6/P31), and `--session-id` resume —
the three properties that motivated the headless design — and leaves the
`execution.workerMode` config (`process | in-process`) with only one working
value. Not recommended except as an interim milestone slice.

## Recommendation

Option (a). It is the only option that closes the gap rather than redefining
it, and ~70% of the logic (env scrub, argv, NDJSON parse, exit classification)
is already written and unit-tested — the missing piece is the 50-line
`ctx`-bound launcher plus the `worker_runs` row lifecycle.

## First concrete step

Add `launchWorkerRun(ctx, {taskId, attempt, worktree, tierOverlay, prompt})` to
`packages/sdlc-core/src/worker-mgr.js` (next to `buildSpawnArgv`), taking `ctx`
as an explicit parameter so unit tests can inject a fake `{subprocess: {spawn}}`
without a DSH boot; assert it passes exactly `buildWorkerEnv(…).env` and records
`{pid, sessionId, nonce}` via `runtime.startWorkerRun` (`runtime.js:217`).

## Cost / attempt estimate

**M** (medium): 1 new module function + 1 failing-first test file
(`tests/integration/worker-launch.test.mjs` with a fake `ctx`), 2–3 attempts;
no schema change (uses existing `worker_runs` columns).

## Acceptance

- [ ] A failing-first test injects a fake `ctx.subprocess.spawn`, calls the new
      launcher, and asserts the argv equals `buildSpawnArgv(…)` and the env
      equals `buildWorkerEnv(…).env` (no `*_API_KEY`, `DSH_HOME` present).
- [ ] `ASSIGNED→IN_PROGRESS` writes a `worker_runs` row with pid + nonce.
- [ ] `execution.workerMode: in-process` still routes through the same
      `WorkerResult`/outbox channel (seam interface unchanged, per C.2).
