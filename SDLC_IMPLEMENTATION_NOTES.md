# SDLC Orchestrator — implementation notes

**Subject:** `universal_sdlc_orchestrator_dsh_spec_v3.md` (2,336 lines)
**This build:** the `dsh-plugin-sdlc` monorepo — eight packages, three profile
recipes, seven test layers, eleven gates (P, M0–M8, Q).
**Platform:** Node ≥ 22.13 (verified v24.21.0), `@deepseek-ai/dsh` 0.2.0-rc.2, Linux x64.
**Status:** `gate:P` + `gate:M0` … `gate:M8` + `gate:Q` all green; 906 offline
tests and 9/10 e2e pass (the live-provider e2e is skipped by design).

Read this document together with the validation report
(`SDLC_V3_IMPLEMENTATION_VALIDATION_REPORT.md`). Where this file says
"deviation Dn", the validation report records the evidence.

---

## 1. What exists now

```
scripts/
  build.mjs                 zero-dependency src/ → lib/ artifact step        (D0)
  gen-presets.mjs           generates the 26 preset rows from roles.js
  validate-platform.mjs     gate:P — 18 deterministic platform facts
  validate-m0.mjs … m8.mjs  gate:M0 … gate:M8 (per D.0)
  validate-gates.mjs        runs P → M8, stops at the first failure
  doctor.mjs, install-local.mjs
  lib/harness.mjs           the check harness (evidence bundles)
  lib/gate-helpers.mjs      temp-repo / runtime fixtures for the gates

packages/
  sdlc-core/       host services + pure domain modules    (NEVER in a worker)
  sdlc-guard/      worker-side policy (tools/pre-execute + fs deciders)
  sdlc-tools/      propose-only model tools + the /sdlc command surface
  sdlc-presets/    26 dsh-agent-preset rows (generated, checked in)
  sdlc-cli/        the `sdlc` executable (deterministic control plane)
  sdlc-mock-llm/   deterministic ctx.llm provider (test-only, never published)

profiles/          installer recipes: sdlc-web, sdlc-worker, sdlc-probe
tests/             unit · contract · integration · fault · adversarial · e2e
.github/workflows/ci.yml
```

### Package partition (errata E6, enforced)

| Profile | Template | Bundles | Property |
|---|---|---|---|
| `sdlc-web` | `web` | core + tools + presets | interactive lead; holds the instance lock |
| `sdlc-worker` | `headless` | guard + tools | **never** core — that would start a second scheduler and a second DB writer |
| `sdlc-probe` | `sdk` | core + tools + presets | deterministic boot probe via `SDLC_SELFTEST` |

`scripts/install-local.mjs`, `scripts/doctor.mjs` and
`scripts/validate-m0.mjs` all assert this partition.

---

## 2. Deviations from the spec, with rationale

Each deviation is deliberate, is the smallest change that keeps the documented
contract observable, and is pinned by a test.

### D0 — plain ESM JavaScript instead of a TypeScript build
The spec (C.8.2) assumes a TypeScript monorepo built with `pnpm -r build`. This
environment has **no pnpm and no network**, so a TypeScript toolchain cannot be
installed. The packages are written as plain ESM JavaScript with JSDoc types,
and `scripts/build.mjs` performs the `src/ → lib/` artifact step that both the
DSH loader and the validation harnesses consume.

The observable contract is unchanged: `package.json#main` points at `lib/`,
`dsh.bundle.patch` files exist and declare valid rows, and
`scripts/validate-m0.mjs` imports exactly the paths it always did
(`packages/sdlc-guard/lib/index.js`, `packages/sdlc-core/lib/schema.js`,
`packages/sdlc-core/lib/worker-result.js`). Replacing `build.mjs` with `tsc`
is a one-file change. Exact `peerDependencies` pinning (P36) is preserved.

### D1 — complexity: the B.1 formula wins over the G.2.1 example
Part G.2.1's illustrative test asserts `normalizeFeature('files', 1) < 0.1`.
The normative formula in B.1 is `min(ln(1+F)/ln(201), 1)`, which yields
≈0.1307 for F=1. Part B is normative, Part K supersedes Part G, so the formula
is implemented **as written** and the unit test asserts the real value
(`tests/unit/complexity.test.mjs`). With `ln(201)`, F=1000 clamps at 1.0, so the
second half of the G example does hold.

### D2 — `sdlc-core` declares host rows only
C.1's inline comment shows `sdlc-core` declaring `['./cordis.patch.yml',
'./presets.patch.yml']`, while C.1's body text (and the package list) puts the
26 preset rows in `sdlc-presets`. Declaring them twice would produce duplicate
loader row ids and fail `M0-02-no-dup-ids`. Core declares host rows only;
`sdlc-presets` declares the 26 preset rows.

### D3 — weights sum to 1.0 in decimal, 0.9999999999999999 in binary floats
The nine documented weights sum to exactly 1.0 as decimals; summing their
IEEE-754 approximations yields `0.9999999999999999`. The formula is unchanged
and the score is still clamped to `[0,1]` by construction; the test asserts both
`Math.round(sum*1000) === 1000` and `|sum − 1| < 1e-12`.

### D4 — three matrix refinements required by other normative text
B.2.1's table omits three transitions that other normative sections require:

| Addition | Required by | Why the table alone is insufficient |
|---|---|---|
| `VERIFYING → BLOCKED` (actor `verifier`, guard `blockedBySkippedGate`) | L.5: "R3+ tasks touching UI are **blocked**, not auto-accepted" | Without the row the policy has no persistable state and could only be modelled as `FAILED` |
| `recovery` added to the `IN_PROGRESS → FAILED` actors | B.12 reconciliation + B.3.2 orphan salvage | A dead worker's task must be failed by reconciliation; without it the salvage returns `INVALID_TRANSITION` |
| `api` gate added to R2 when the `api` domain is present | §53 Test 2 ("New API": unit+integration+api) | B.4's R2 row lists only syntax/lint/unit/integration |

All three are additive; no documented transition was removed or weakened.

### D5 — the `SDLC_SELFTEST` helper is duplicated in three packages
The boot hook (C.9) must work in the probe profile, where `sdlc-tools` and
`sdlc-presets` are installed but must not depend on `sdlc-core` (E6 keeps the
worker profile core-free). The 20-line helper is therefore copied verbatim into
`sdlc-core`, `sdlc-tools` and `sdlc-presets`; the contributions merge through
one `globalThis` accumulator and are flushed once the composition goes quiet.
Duplication is intentional and asserted by `tests/unit/selftest.test.mjs`.

The same reasoning applies to `glob-lite.js` (core) vs `glob.js` (guard): a
cross-package equivalence property test (`tests/unit/glob-equivalence.test.mjs`)
property-tests both implementations against each other over 6,000 generated
inputs so the copies cannot drift silently.

### D6 — symlink containment is a plugin-layer concern
L.4 T11 says "guard resolves `realpath`"; the pure matcher cannot (it has no
filesystem and must stay unit-testable). `escapesRoot()` resolves the nearest
existing ancestor with `realpath` and reports escapes; the DSH plugin applies it
in `decideToolCall` whenever a worktree root is known, and fails **closed** when
a path cannot be resolved. The lexical decision (`checkFsWrite`) is unchanged.

Related, discovered while implementing: in a **linked** `git worktree`, `.git`
is a gitfile, not a directory, so E7's literal `<worktree>/.git/info/exclude`
does not exist. The exclude path must be resolved with
`git rev-parse --git-path info/exclude` (still never the repository
`.gitignore`). `scripts/validate-m2.mjs` does exactly that.

### D7 — seeded PRNG instead of `fast-check`
K.3 asks for `fast-check` as a devDependency. It cannot be installed offline, so
the property tests use the seeded `mulberry32` PRNG that `scripts/lib/harness.mjs`
already ships, satisfying the actual requirement ("a seeded PRNG so a failure is
reproducible") with **zero** external dependencies. `devDependencies` is
therefore empty.

### D8 — host-model adoption, no-init bootstrap and explicitly unknown pricing
The spec's tier examples use OpenAI/Anthropic routes, but the product runs
inside DeepSeek Harness, which already owns the signed-in provider/account
(for example `deepseek-account/deepseek-flash`). Requiring a second provider
key is a product defect, not a deployment choice. `host-model.js` discovers the
active profile's `agent-default-model`, and Settings / `sdlc config
use-host-model` rewrite all three tiers to that route. The UI host plugin reads
`agentDefaultModel` opportunistically (`ctx.get`), so older profiles still mount.

The same route is now the DEFAULT, not an opt-in: `ensureProject` (project.js)
materialises `.sdlc/` on first touch — the first panel request, `sdlc status`
and `sdlc config use-host-model` all bootstrap a fresh workspace with the
harness route in all three tiers, so neither a manual `sdlc init` nor a key is
ever required. `ensureProject` is the single authority on "complete" —
config.yml AND the DB — and every bootstrap surface calls it unconditionally
(its complete-project fast path is two `existsSync` calls); callers must never
gate it on their own existence checks, because either half can go missing on
its own (an early `sdlc tasks` opens the DB before any config exists; a
`git clean -fdx` removes the gitignored DB and keeps the config) and the next
touch must repair the missing half without touching the authored one. Five
contracts hold: bootstrap only writes a config that does not exist (an
authored config is changed only by the explicit Settings/CLI action); a config
POST and adoption require a COMPLETE project (gating on the `.sdlc` directory
would let a failed bootstrap's leftover tree be poisoned into a wedged
OpenAI-default config with no detected gates); a failed bootstrap mutates
nothing in the user's git repository — `initProject` runs stack detection
BEFORE creating the integration branch, because auto-setup runs on reads;
bootstrap errors (EACCES on an unwritable workspace included) resolve into
the guided state, never a rejected fetch; and nothing is memoised — the next
request always re-examines the real filesystem. A MARKERLESS workspace (a
plain folder, `package.json` without a lockfile — note the spec F.5 table
makes `package-lock.json`, not a bare `package.json`, the npm marker, so a
lockfile-less Node project is markerless) is NOT a dead end: auto-setup
proceeds with `verification.detection: manual` and empty gates
(`initProject`'s `undetected: 'manual'`, used only by `ensureProject`),
while explicit `sdlc init` keeps failing with the never-guess message, and
`validateConfig` warns that verification passes vacuously until gates are
authored. A set-up workspace with no project row answers flow requests
with the distinct `NO_PROJECT_ROW` code, so the panel's "create a project
with `/sdlc run`" empty state is never misreported as a setup failure.
`sdlc init`
adopts the same route by default (`--no-host-model` opts out, on `init` only —
reads never write the spec defaults; a lone `--provider` or `--model` is a
usage error, never a silent fallback; init only claims adoption when the
config step actually wrote). The
adopted tier entry carries the harness `reasoningEffort` so
`buildTierOverlay` reproduces the exact route in the worker `--patch`.

Because DSH exposes token counts but no currency metadata (P20/P28), a tier
route may carry an explicit `unknown` price entry
(`{ input: null, output: null, unknown: true }`). Validation accepts it with a
warning and cost renders as `—`; a missing price entry is still an error, so
the plugin never guesses. A fresh bootstrap names exactly one provider in
tiers AND price table (`hostModelBootstrap`); adoption into an existing
config keeps the user's own price rows without re-introducing legacy ones
(defaults fill SECTIONS, never the price table). Pinned by
`tests/unit/host-model.test.mjs`,
`tests/unit/project.test.mjs` (ensureProject, both half-state repairs, no git
mutation on failure), the CLI bootstrap tests in
`tests/unit/cli*.test.mjs` (including the DB-only half state that used to
leave OpenAI/Anthropic defaults silently in effect), and the plugin
auto-bootstrap tests in `tests/unit/ui-routes.test.mjs` (write-fence
poisoning refusal, contained errors, re-bootstrap after deletion).

---

## 3. Defects found by the test layers, and fixed

Every item below was surfaced by a test layer (not by review) and is now pinned
by a regression test.

| # | Defect | Fix |
|---|---|---|
| 1 | `deriveWorkerResult` ran `asArray()` over `evidence_claims`, silently reducing object claims `{ac_id,claim,artifact}` to `[]` | `asList()` preserves non-string entries; the claims remain hints and the git diff stays authoritative |
| 2 | `fallbackChain` returned declaration order, not score order (K.5 requires score order on provider errors) | `rankWithinTier()` extracted; the chain is routed-candidate-first then score order |
| 3 | No realpath containment anywhere in the guard (T11) | `escapesRoot()` + `decideFsWriteReal()`, applied by the plugin; fail-closed on resolution errors |
| 4 | `parseGitNames` mis-parsed space-separated `git status --porcelain` (`?? src/new.ts` → `"?? src/new.ts"`) | status prefixes, renames and `-z`/NUL output are all handled |
| 5 | `task_class` was never persisted, so router rules 6/8 could not be re-derived from state (B.8) | `tasks.task_class` column + idempotent additive migration + `addTask`/`getTask` round-trip |
| 6 | `VERIFYING → BLOCKED` was unreachable, making the L.5 skipped-gate policy unpersistable | matrix row added (D4); `skippedGateBlocks` guard |
| 7 | A colour-only diff was rejected with `NO_TEST_EVIDENCE`, contradicting §53 Test 1 | appearance-only diffs are exempt from the §24 behavioural rule (B.4 refinement) |
| 8 | R2 API tasks lacked the `api` gate, contradicting §53 Test 2 | `api` added to R2 when the `api` domain is present (D4) |
| 9 | `scheduler.planStep` granted the same `task_resources` entry to two tasks in one step | the working snapshot is mutated as locks are granted |
| 10 | `dumpYaml` wrote nested empty arrays/objects as an unindented `[]`, so the `.sdlc/config.yml` it generated failed its own parser | `key: []` / `key: {}` inline |
| 11 | `Runtime.open()` created `.sdlc/` only when the instance lock was enabled | the directory and `dirname(dbPath)` are created unconditionally |
| 12 | `router.route` did not accept the documented `route({ task })` call shape (G.2.3) | both shapes accepted |
| 13 | `findTransition` let the recovery wildcard match **terminal** states, so `DONE → ESCALATED` was "legal" | terminal states are excluded before the wildcard |
| 14 | `validateConfig` reported a not-yet-created `.sdlc/` as unwritable | the nearest existing ancestor is checked |
| 15 | `MockLlm` did not load its default scenarios unless `apply()` merged them | defaults are loaded by the constructor |
| 16 | `addTask` could not ingest the spec-shaped snake_case `budgets` block from B.3.1 (`{max_attempts:…}`) — it bound `budget.maxAttempts`, which was `undefined` | `normalizeTaskBudget()` accepts both spellings, falls back to risk defaults per key, and REJECTS unknown keys instead of dropping them |

---

## 4. How to run it

```sh
# build artifacts (zero dependencies, offline)
node scripts/build.mjs

# the deterministic gates — no model, no network
node scripts/validate-gates.mjs          # P → M8, stops at the first failure

# individual layers (globs — Node 24 rejects a bare directory positional)
node --test 'tests/unit/**/*.test.mjs'            # L2  — pure modules + property tests
node --test 'tests/contract/**/*.test.mjs'        # L3  — published JSON Schemas vs fixtures
node --test 'tests/integration/**/*.test.mjs'     # L4  — real sqlite, real git, mock LLM
node --test 'tests/fault/**/*.test.mjs'           # L5  — the 13-row fault matrix
node --test 'tests/adversarial/**/*.test.mjs'     # L6  — the 8-threat security suite
node --test 'tests/e2e/**/*.test.mjs'             # L7  — the eight §53 acceptance tests

# environment + install
node scripts/doctor.mjs
node scripts/install-local.mjs --dry-run
```

`node scripts/validate-gates.mjs --json` prints a machine-readable summary and
writes `.validation/gate-<id>.json` evidence bundles for every gate.

---

## 5. What is deliberately not implemented

| Item | Reason |
|---|---|
| Playwright-driven browser execution | the browser stack is not installed here. The viewport matrix, the rubric schema, the 2-failure escalation and the a11y floor are all implemented and tested; `M6-06` skips with a real reason **and** asserts the no-browser-stack BLOCK policy (L.5) |
| Windows support | B.10 explicitly excludes Windows through M8 (POSIX signals, `O_EXCL` semantics, worktree paths) |
| L8 live tests | manual only by design (`tests/e2e/live.test.mjs` is skipped unless explicitly selected) |

(`sdlc-client-ui` was optional in C.1 and is now IMPLEMENTED — attention-first
Flow, filterable Tasks, validated Settings editor and select-driven Review tab
on `sdlc-web` only. Launching the
DSH-hosted lead is proven live via M0's boot probe on a configured host.)

---

## 6. Known residuals (unchanged from the spec)

1. **RC churn.** `0.2.0-rc.2` is a release candidate. `validate-platform.mjs`
   pins the version; Part J.3 requires re-running `gate:P` + `gate:M0` before
   trusting a new runtime. The `platform/` isolation note in `services.js` keeps
   DSH API touchpoints in one file.
2. **Cost is always an estimate.** No currency metadata exists (P20/P28); the
   gate asserts *bookkeeping exactness* (recomputed == persisted to the cent),
   never a provider invoice (E9).
3. **The guard is not a security boundary.** Command-string matching is
   defeatable; the adversarial suite asserts the documented misses *and* the
   diff-based backstop. The sandbox root and the git diff are the real controls.
4. **Headless deployments cannot unblock themselves.** Fail-closed and
   deliberate (C.2/L.5), asserted by `M4-05`.
5. **Worktree bootstrap cost** on dependency-heavy repos is unaddressed by
   design; the warm-pool milestone stays post-M7.

---

## 7. Throughput track (TRACK B): concurrency stays at the default (B12)

The suite is CPU-bound (node:sqlite transitions, bootstrap resampling), not
I/O-bound, so `node --test` file-level concurrency is left at its default and
the speedups come from removing per-test waste instead. Measured on the
contract layer (121 tests, Node v24.21.0): default 1.36s wall,
`--test-concurrency=1` 2.31s wall (2.1x slower serial),
`--test-concurrency=8` 1.36s wall (no gain — extra workers add scheduling
overhead without unblocking anything). Concrete waste removed instead: the
exhaustive state-machine matrix reuses 12 `TaskStateService` instances (one
per `from` state, fresh task id per cell — the events table is append-only by
DB trigger so it cannot be emptied) instead of constructing 1,296 `:memory:`
DBs (5.66s → 0.65s wall); the eval-stats bootstrap test passes an explicit
`B: 200` instead of the production default `B: 10,000` in `eval/report.mjs`
(0.60s → 0.27s wall); the `test` script is one `node --test` invocation over
five globs instead of a five-process `&&` chain (one startup, one reporter);
`scripts/collect-coverage.mjs` runs the instrumented suite once and
`gate:Q`/M8 reuse `.validation/coverage.json` when fresh. The single
documented exception to "no concurrency changes" is B14: `validate-gates.mjs`
fans M1–M7 out concurrently because gates are separate OS processes with
disjoint temp dirs, not threads sharing one sqlite file.

---

## 8. Tier D scoping (Track D — decision docs only, no behavior change)

1. **D21 ctx seams** (`docs/decisions/D21-ctx-seams.md`): zero `ctx.subprocess`/`ctx.subagents` call sites; pure halves (`buildWorkerEnv`/`buildSpawnArgv` in `worker-mgr.js`) tested, launcher missing — recommend passthrough seam, first step `launchWorkerRun(ctx,…)` (M).
2. **D22 authority handlers** (`D22-command-handlers.md`): all `/sdlc` commands return `{deferred:true}` (`tools/plugin.js:78`), 4 lead tools are stubs (`tools/index.js:206–218`) — phased plan: enqueue-only proposals first (S), authority handlers + `ctx.approval` gating second (M).
3. **D22 mapping**: `approve`→planApproved transition, `reject`→FAILED+replan, `stop`→kill-switch+CANCELLED, `retry`→READY-or-ESCALATED, `elevate`→tier/corrective-plan; lead tools map to proposal kinds drained by the transition service.
4. **D23 disk-full** (`D23-disk-full.md`): K.5 `DISK_EXHAUSTED` has zero code and zero tests — pre-flight capacity check + `ENOSPC` classifier, same evidence shape, `READY` (pre-flight) vs `FAILED` (mid-task) (S).
5. **D23 skeleton**: 3 failing-first vectors in `tests/fault/disk-full.test.mjs`, checked in skipped-with-reason (repo precedent: M6-06) so all gates stay green until the implementing track flips the skips.
6. **D24 gate types** (`D24-gate-types.md`): `types/api/security/perf` are routed by `requiredGates` but never detected; Playwright is a kind-tag, not a driver — detection-table entries first (S), `runPlaywrightGate` driver second (M).
7. **D24 coordination**: new tests slot into existing layers only (`tests/unit`, `tests/contract`, `tests/e2e`); M8-05 layer list and `test:*` scripts unchanged — coverage-once holds with Track B.
8. **D25 identity resync** (`D25-identity-resync.md`): fixed 9 stale spec sites — J.1 names (6→`dsh-sdlc-flow-*`, +missing meta-bundle row), J.3 commands, F.1 table + F.2 heading, 11→13 M0 checks (4 sites), M0-06 wording, +`gate:Q` row.
9. **D25 proposals (not fixed)**: peer-range-vs-exact wording (#7, enforcement decision), version lockstep (#8), report regeneration with 906-test/82-check totals on a pnpm host (#10) — M0-01 currently fails here (profiles uninstallable without pnpm, env-caused).
10. **Rule honored**: docs + skipped skeleton + markdown identity fixes only; no gate logic, spawn paths, or production behavior changed — all `.js` diffs in the tree belong to other tracks.
