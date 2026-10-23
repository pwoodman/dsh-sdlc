# Test Suite Analysis — Performance, Parallelization & Code Quality

**Repo:** `dsh-sdlc-flow` (Universal SDLC Orchestrator plugin suite, spec v3)
**Scope:** TEST SUITE ONLY. No files were modified by this analysis.
**Runtime:** node v24.21.0 at `/home/patrick/.var/app/com.deepseek.harness/data/dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin`.
**Method:** each test file timed individually (`node --test <file>`), plus full-layer and merged runs; every claim below is backed by `file:line` or a measured number.

---

## 0. Executive summary

The suite is **fast per-file but pays a heavy fixed tax**: `node:test` default concurrency is *already* parallel across files, so the ~35 s unit-layer wall clock is dominated by **a handful of O(N³)/O(resample) CPU-bound tests**, not by lack of parallelism. Three findings dominate:

1. **`tests/unit/state-machine.test.mjs` alone costs ~6.7 s wall (12 s in the reporter's own clock)** because its exhaustive matrix test constructs **1,296 fresh in-memory `TaskStateService` instances** (12 states × 12 states × 9 actors), each running a **19-statement `migrate()`**. Measured: constructing 1,296 `TaskStateService(':memory:')` = **18.6 s** (`packages/sdlc-core/src/state-machine.js:164-167`, `packages/sdlc-core/src/schema.js:237-243`). This single test is ~20–35 % of the unit layer.

2. **`tests/unit/eval-report.test.mjs` (~3.8 s) and `tests/unit/eval-stats.test.mjs` (~2.7 s)** call `bootstrapCI` with the library default **`B = 10000` resamples** (`eval/lib/stats.mjs:104`, `eval/report.mjs:93,126`). Measured: 20 × `bootstrapCI` ≈ **2.4 s** (~120 ms each). `buildReport` is invoked ~13× across `eval-report.test.mjs`, each running a bootstrap per metric row.

3. **The 6 "failures" observed when node is *not* on default PATH are environment/test-harness bugs, not test bugs.** `tests/unit/cli.test.mjs:37` spawns bare `'node'` (`run('node', [CLI, …])`) and `tests/contract/gate-commands.test.mjs:278,282` spawn bare `'node'` via `defaultRunner`. The eval harness spawns bare `'node'` too (`eval/run.mjs:445`). When the node bin dir is on `PATH`, **all 906 tests pass** (verified: `pass 906 / fail 0`). This is the single most important robustness fix (see R0).

`npm run test` chains 5 layers with `&&` (sequential) — see §3 and R1 for how to merge them and the tradeoffs.

---

## 1. Top-10 slowest test files

Measured by running each file individually with the absolute node path (cold, one process per file). "Cost driver" is what the file actually does (verified by reading each file).

| # | File | Wall (ms) | Tests | Cost driver (one line) |
|---|------|-----------|-------|------------------------|
| 1 | `tests/unit/state-machine.test.mjs` | **6726** | 12 | Exhaustive 12×12×9 transition matrix test builds **1,296 fresh `TaskStateService(':memory:')`**, each running a 19-statement `migrate()` (`state-machine.test.mjs:47-58` + `:19`). ~11.2 s is that *one* test. |
| 2 | `tests/unit/eval-report.test.mjs` | **3836** | 12 | ~13 `buildReport(...)` calls, each running `bootstrapCI` at default `B=10000` per metric (`eval-report.test.mjs:50,62,73,82,114,…` → `eval/report.mjs:93,126`). |
| 3 | `tests/unit/eval-harness-hardening.test.mjs` | **3339** | 17 | Spawns real `node --test --experimental-test-coverage` subprocesses for `collectCoverage` + audit (`eval-harness-hardening.test.mjs:267-288`, `eval/run.mjs:445`); temp-dir fixtures. |
| 4 | `tests/unit/eval-stats.test.mjs` | **2698** | 10 | `bootstrapCI` at `B=2000` (and default) plus exact Wilcoxon/sign-flip resamples (`eval-stats.test.mjs:51-55`). |
| 5 | `tests/unit/install-lib-atomic.test.mjs` | **2541** | 5 | Writes a **200,000-element** JSON payload through `writeFileAtomic` (temp+fsync+rename) and exercises the pid-stamped install lock (`install-lib-atomic.test.mjs:30`, `:35-89`). |
| 6 | `tests/unit/project.test.mjs` | **2499** | 16 | ~15 tests each doing **real `git init` + commits** via `makeRepo`/`cleanup` in a fresh temp repo (`project.test.mjs:33,45,55,70,79,…`). Git spawn dominates. |
| 7 | `tests/unit/guard.test.mjs` | **2396** | 16 | Path/guard fuzz: **400 + 300 iteration** loops over generated paths plus property tests (`guard.test.mjs:115,125`). |
| 8 | `tests/integration/build-release-exclusions.test.mjs` | **2372** | 1 | Single test shells out to `scripts/build-release.mjs` and `tar tzf` — a real release build (`build-release-exclusions.test.mjs:28-39`). |
| 9 | `tests/unit/host-model.test.mjs` | **2356** | 5 | Bootstrap/adoption of host model pricing across temp project dirs (`host-model.test.mjs:23,51,82`). |
| 10 | `tests/unit/integration.test.mjs` | **2119** | 9 | Re-imports `core.integration()` and parses real `git merge-tree` output (`integration.test.mjs:9,70`). |

**Near-misses (rank 11–14):** `tests/unit/install-lib.test.mjs` (2078 ms, install-block rewriting), `tests/unit/cli.test.mjs` (2074 ms, **spawns a real child `node` per case** — 19 `spawnSync` calls), `tests/unit/glob-equivalence.test.mjs` (2073 ms, **2,000 + 4,000 iteration** glob-match property loops at `:33,46`), `tests/unit/instance-lock.test.mjs` (2003 ms, per-test temp lock dirs).

---

## 2. Concurrency & serial-async analysis

### 2.1 What node:test is already doing
- **File-level concurrency is on by default.** `node --test 'tests/unit/**/*.test.mjs'` runs test *files* concurrently (default `--test-concurrency` = number of CPUs). Verified: `--test-concurrency=1` made the unit layer **68.7 s** vs **~33 s** default (a **2.1× slowdown** when serialized). So the suite is already parallel across files; forcing higher concurrency did **not** help here (see §2.2).
- **No `describe/it` block structure and no `{ concurrency: n }` anywhere** in the suite (grep for `describe(`/`it(`/`concurrency:` → 0 hits in test files). Every test is a top-level `test(...)` from `node:test`. Top-level `test()`s in a file run **serially** by default in `node:test`; within a file there is no intra-file parallelism.
- **No subtest parallelism is exploited.** Files use `test('…', async (t) => …)` with `t.after`/`t.before` cleanup hooks only (`tests/unit/update.test.mjs:24`, `tests/integration/installer-flow.test.mjs:23`), never `t.test()` children that could be `concurrency`-tuned.

### 2.2 Why higher `--test-concurrency` did *not* help (measured)
| Run | Wall | `duration_ms` |
|-----|------|--------------|
| unit, default concurrency | 33.0 s | 32,921 |
| unit, `--test-concurrency=8` | 22.6 s | 22,367 |
| merged 5 layers, default | 47.2 s | 47,118 |
| merged 5 layers, `--test-concurrency=8` | 51.8 s | 51,655 |

`--test-concurrency=8` speeds up the **unit** layer (22.4 s vs 32.9 s) but **slows the merged run** (51.8 s vs 47.2 s) because the extra processes contend on the same CPU during the CPU-bound bootstrap/bootstrap-CI tests. The bottleneck is **per-test CPU work**, not process count — so the correct fix is to make the heavy tests cheaper (R2/R3), not to crank concurrency.

### 2.3 Unnecessary sleeps / fixed delays / serial awaits
Only **two real timers** exist in the entire suite (good), but both are removable:

| File:line | What | Verdict |
|-----------|------|---------|
| `tests/unit/selftest-copies.test.mjs:136` | `await new Promise((resolve) => setTimeout(resolve, 150))` — waits for a **50 ms debounce** to flush the selftest file. | **Tighten/replace.** Polls a real 50 ms debounce with a fixed 150 ms sleep (3× margin). Replace with a bounded poll (`while (!existsSync(path) && Date.now()-t<1000) await setTimeout(5)`) or inject the debounce clock. Fixed 150 ms is a real wall-clock cost × every run and is the only "sleep" that can flake on a slow/loaded machine. |
| `tests/unit/update-safety.test.mjs:148` | `await new Promise((resolve) => setTimeout(resolve, 25))` inside a fake `installBundle` to simulate install latency for a concurrency test. | **Acceptable** — this is a controlled fake, not a timing race (the assertion is about *dedup*, checked after `Promise.all`). Could use an injected promise gate instead of a real 25 ms delay. |

No `waitFor`/`setInterval`/polling loops against real I/O. The `for (let i…)` loops (`guard.test.mjs:115,125`, `glob-equivalence.test.mjs:33,46`, `complexity.test.mjs:24,102`) are **CPU property-test loops**, not sleeps — handled in R2/R3.

### 2.4 The O(N³) / O(resample) hot spots (the real serial cost)
- `tests/unit/state-machine.test.mjs:47-58` — the exhaustive test loops `from × to × actor` (12×12×9 = **1,296**), and **per cell** calls `fresh(from)` which does `new sm.TaskStateService(':memory:')` → `migrate(this.db)` (`state-machine.js:164-167`) executing **19 DDL statements** (`schema.js:237-243`). Measured 1,296 ctors = **18.6 s**. This is the single biggest lever.
- `eval/report.mjs:93,126` — `buildReport` defaults `bootstrapB = 10000` and runs `bootstrapCI` per metric; `eval-report.test.mjs` calls `buildReport` ~13×. `eval-stats.test.mjs:54-55` runs `bootstrapCI` at `B=2000`. Measured ~120 ms per `bootstrapCI`.

---

## 3. `npm run test` layer sequencing & merge feasibility

`package.json` `"test"` is literally:
```
npm run test:unit && npm run test:contract && npm run test:integration && npm run test:adversarial && npm run test:fault
```
Five **sequential** layer invocations (`package.json`, `"scripts"."test"`). Each `node --test 'tests/<layer>/**/*.test.mjs'` invocation restarts the module graph and re-pays import cost.

**Merge is feasible and already precedented.** `test:coverage` and `eval:test` (`package.json`) already pass multiple explicit globs/files to a single `node --test`. A merged invocation over all five layers measured **906 tests, all passing** (with node on PATH).

**Tradeoffs of a single `node --test` invocation:**

| Concern | Risk | Mitigation / evidence |
|---------|------|-----------------------|
| **Shared temp dirs** | Low — every fixture uses `mkdtempSync`/`tempDir(prefix)` with unique prefixes (`tests/lib/helpers.mjs:53`, per-file prefixes like `sdlc-cov-`, `sdlc-lock-`). No fixed paths. | Safe to merge. |
| **`.validation/` writes** | Only `tests/integration/build-release-exclusions.test.mjs:48` *reads* a `.validation/` exclusion list; nothing writes the shared `.validation/` dir. `tests/integration/tools-runtime.test.mjs:9` reads `$SDLC_VERIFY_RUNTIME` (an env path). | Safe; but see R0 for the `SDLC_VERIFY_RUNTIME`/`node`-PATH sensitivity. |
| **Port collisions** | **None** — no `listen(`/`createServer` anywhere in tests (grep → 0). | No concern. |
| **Global state** | `process.env` mutation exists but is **save/restored in `finally`** (`tests/unit/selftest.test.mjs:14-20`, `selftest-copies.test.mjs:38-46`, `presets-plugin.test.mjs:21-29`). Since merged `node --test` runs *files* in separate processes by default, env leakage between files is already isolated. | Safe at file level. (Do **not** switch to in-process `--test-force-exit`/single-process; keep file isolation.) |
| **CPU contention** | Merging + high concurrency slowed the merged run in measurement (§2.2) because the top-3 files are CPU-bound. | Merge **without** raising concurrency; fix the hot tests first (R2/R3). |
| **Fail-fast/`&&` semantics** | `&&` currently stops at the first failing *layer*; a merged run reports all layers' failures at once. | Tradeoff: you lose per-layer gate separation that spec K.2 maps layers onto (comment in `package.json`). Keep per-layer scripts for `gate:*`/CI matrices; make `test` the fast merged path. |

**Recommendation (see R1):** keep `test:unit`/`test:contract`/… as-is for spec-layer gates, but make `"test"` a single merged `node --test` over all five globs.

---

## 4. Duplicated heavy setup → hoist to `tests/lib/`

`tests/e2e/harness.mjs:33-51` is the **good model**: it loads all `core.*` modules **once** at module scope (`export const M = { config: await core.config(), … }`) and reuses them across all 8 e2e scenarios. The unit/integration layers do **not** follow this pattern:

- **`new Runtime(...)` is constructed 25 times** across `tests/integration/*.test.mjs` (e.g. `budget-breach.test.mjs:76`, `dependency-blocking.test.mjs:61`, `determinism.test.mjs:21`, `dispatch-and-complete.test.mjs:25`, `resume-after-crash.test.mjs:28,54,85`), each opening a fresh DB + project. These are already per-file, so file-level concurrency absorbs much of it, but a `tests/lib` `makeRuntime(files, cfg)` helper would remove the copy-paste and the risk of drifting setup.
- **`makeRepo`/`git init` fixtures appear 37 times** (`tests/lib/helpers.mjs:126-133`; callers in `project.test.mjs`, `cli.test.mjs`, `e2e/*`, `fault/*`, `adversarial/*`). Real `git init`+commit is a subprocess-heavy setup; a pre-baked bare-repo template cloned with `git clone --local` (or `git init` once + copy the `.git` dir) would cut spawn cost for the 15+ `project.test.mjs` tests.
- **`core.*` dynamic-import** (`tests/lib/helpers.mjs:23-51`) re-imports per call (`load()` uses `import()`), though ESM caches so this is cheap. No action needed, but the e2e "load-once" `M` object is the cleaner pattern.

**Specific hoists:** a shared `tests/lib/runtime-fixture.mjs` exporting `makeRuntime({files, config, useLock})` + `withRuntime(fn)`, and a `makeRepoCached()` that reuses a git template.

---

## 5. Code-quality / spec-conformance issues in tests

### 5.0 P0 — Environment/test-harness bug (makes 6 files fail off a fixed PATH)
- `tests/unit/cli.test.mjs:37` — `run('node', [CLI, …])` spawns **bare `'node'`**; `tests/lib/helpers.mjs:96-105` `run()` resolves `cmd` via `spawnSync(cmd,…)` against `PATH`. With node not on default `PATH`, `res.status` is `null` → **all 19 tests fail** (`cli.test.mjs:77` `assert.equal(res.status, 0)`). Fix: use `process.execPath` (as `tests/integration/installer-safety.test.mjs:77`, `installer-flow.test.mjs:46`, `build-release-exclusions.test.mjs:28` already do) or resolve node once in `tests/lib/helpers.mjs`.
- `tests/contract/gate-commands.test.mjs:278,282` — `gates.defaultRunner(['node', '-e', …])` spawns bare `'node'` (the runner itself is `spawnSync(argv[0],…)` at `packages/sdlc-core/src/gates.js:210-211`). Fails off fixed PATH.
- `eval/run.mjs:445` (invoked by `tests/unit/eval-harness-hardening.test.mjs:267-288` and `tests/integration/eval-pipeline.test.mjs`) — `spawn('node', ['--experimental-test-coverage', …])` spawns bare `'node'`. Under a nested/CI runner this is the reason `collectCoverage` reports *"the coverage reporter produced no per-file rows (0/1 test file(s) exited 0)"* (`eval-harness-hardening.test.mjs:276,356`).
- `tests/integration/tools-runtime.test.mjs:9` — reads `process.env.SDLC_VERIFY_RUNTIME ?? join(ROOT,'.validation/desktop-runtime')`; this test is **environment-dependent** (skips/passes based on an unpacked Cordis host being present). It passed only once a run left `node` on PATH; it is inherently host-state coupled.
- **Consequence:** the entire suite is green (906/906) only when the node bin dir is on `PATH`. This is the top flakiness/portability defect.

### 5.1 Assertion brittleness (exact/regex string matches on reason/log text)
**335 `assert.match(x, /…/)` calls** and **411 `assert.throws(…, /…/)`** rely on exact reason/error/markdown wording. These break on any rewording of a message even when behavior is correct. Representative hot-spots:
- `tests/unit/budget.test.mjs:29-38,49,56` — regex-matches reason text (`/max_attempts/`, `/cost/`, `/tokens/`, `/duration/`, `/project-cost/`, `/project-duration/`, `/BUDGET_EXHAUSTED/`). Prefer asserting a stable `reason` **code**/enum field rather than free text.
- `tests/unit/state-machine.test.mjs:98,139,166` — `assert.match(res.reason, /mergeSlotFree|gatesPass|actor human may not perform/)`.
- `tests/unit/scheduler.test.mjs:59` — `assert.match(res.reason, /resource package\.json locked by A/)` (coupled to a task id `A` and exact wording).
- `tests/unit/verifier.test.mjs:49` — `assert.match(decision.reasons[0], /runtime status is failed/)`.
- **Render-text snapshots:** `tests/unit/context.test.mjs:21-24,39,52-53,68,82-84,102` asserts exact markdown headings (`/## 1\. role-preamble/`, `/truncated 490 lines/`, `/ADR-1: use postgres — ops burden/`) and prompt layout. These are **output-shape snapshots** with no structural contract — highly brittle to any formatting change. Same pattern in `metrics.test.mjs`, `debug.test.mjs`, `presets-plugin.test.mjs`, `install-lib.test.mjs`, `project.test.mjs`, `cli*.test.mjs`, `budget-breach.test.mjs`, `merge-conflict-replan.test.mjs`, `prompt-injection.test.mjs` (15 files total grep-matched for render/`assert.match(text`).

### 5.2 Asserting on implementation internals rather than behavior
- **Raw SQL against the live DB** (10 sites) — `tests/unit/runtime.test.mjs:324,467,625`, `tests/e2e/53-5-stuck-worker.test.mjs:114,133`, `tests/e2e/53-8-architecture-disagreement.test.mjs:99`, `tests/e2e/53-1-tiny-ui.test.mjs:59` run `rt.db.prepare('SELECT …')` / `UPDATE tasks …`. Couples tests to table/column names; a schema migration (which `schema.js` already versions) breaks them even when behavior is unchanged.
- **Private underscore methods** — `tests/unit/state-machine.test.mjs:20,93` (`svc._setState`), `tests/unit/runtime.test.mjs:625` (`rt.state._setState`), `tests/unit/ui-flow.test.mjs:53` (`runtime.state._setState`), `tests/integration/loop-escalation.test.mjs:62-79`, `tests/integration/budget-ingest.test.mjs:30` (`rt.state._setState`). Tests reach into a private setter to force states instead of driving a legal transition.
- **Internal object shape** — `tests/unit/services.test.mjs:102` filters `Object.keys(api)`; `tests/unit/plugin-entry-contract.test.mjs:251` reads `activated._error?.message`; `tests/unit/cli-internals.test.mjs:263` iterates `Object.keys(cli.COMMANDS)`. These assert on module/API surface, not behavior.

### 5.3 Coverage-gap / TODO observations
- **Only one explicit skip** in the whole suite: `tests/unit/plugin-entry-contract.test.mjs:220` (`t.skip('@deepseek-ai/cordis is not installed … live activation gate is enforced by gate:M0 on CI')`) and `tests/unit/tools-cordis.test.mjs:16` (`{ skip: hasRuntime ? false : 'No installed Cordis runtime…' }`). These are honest host-gated skips but mean the Cordis activation path is **untested locally** whenever the host runtime is absent.
- **No `TODO`/`FIXME`/`XXX`/`HACK` markers** in any test file (grep → 0). Good hygiene.
- **Edge-case gaps noticed** (behavioral boundaries with no test found):
  - `state-machine.test.mjs` covers the transition *matrix* exhaustively but has no test for **DB-level uniqueness/ordering of `events` under concurrent writers within one service** (the `:341` `DELETE FROM events` append-only negative control is the closest).
  - `budget.test.mjs`/`budget-spend-scope.test.mjs` cover over/under-budget but not **NaN/undefined budget fields** (a missing `spentCostUsd` key vs `0`).
  - `complexity.test.mjs:36-44` is exhaustive over documented *ranges* but not **negative/huge inputs** (`files: -1`, `Number.MAX_SAFE_INTEGER`).
  - No test exercises **unicode/CRLF** path or prompt content in `context.test.mjs` (only ASCII markdown).
  - `eval-stats`/`eval-report` assert bootstrap **reproducibility** (`eval-stats.test.mjs:54-55`, `eval-report.test.mjs:158`) but not the **`B` default** (a regression that lowers `B=10000` would go unnoticed) — worth a one-line contract assertion on `bootstrapB`.

---

## 6. Flakiness risk

| Risk | Where | Severity | Notes |
|------|-------|----------|-------|
| **Node-`PATH` dependence (the big one)** | `tests/unit/cli.test.mjs:37`, `tests/contract/gate-commands.test.mjs:278,282`, `eval/run.mjs:445` | **High** | 6 files fail whenever bare `node` isn't resolvable. Environment-coupled, not deterministic across machines/CI. |
| **Real-timer debounce wait** | `tests/unit/selftest-copies.test.mjs:136` (150 ms fixed sleep for a 50 ms debounce) | **Medium** | Only true wall-clock sleep that can flake under load; the 3× margin is generous but not guaranteed on a heavily loaded runner. |
| **Host-runtime coupling** | `tests/integration/tools-runtime.test.mjs:9`, `tests/unit/tools-cordis.test.mjs:16`, `tests/unit/plugin-entry-contract.test.mjs:220` | **Medium** | Outcome depends on `$SDLC_VERIFY_RUNTIME` / an installed Cordis runtime being present; can silently skip or change behavior per host. |
| **`process.env` mutation** | `selftest.test.mjs`, `selftest-copies.test.mjs`, `presets-plugin.test.mjs`, `plugin-entry-contract.test.mjs`, `ui-routes.test.mjs` | **Low** | Save/restore in `finally` (verified). Safe because `node --test` isolates files in separate processes. **Do not** move these into a single in-process runner without env isolation. |
| **Real timers in concurrency test** | `tests/unit/update-safety.test.mjs:148` (25 ms fake install delay) | **Low** | Assertion is about dedup after `Promise.all`, not timing; low flake risk. |
| **Filesystem races** | Not found — all fixtures are `mkdtempSync`/unique-prefix temp dirs; `writeFileAtomic`/install-lock tests are explicitly about *preventing* torn writes (`install-lib-atomic.test.mjs:1-8`). | **Low** | |
| **Test-ordering dependence** | Not found — no shared mutable module state across tests; e2e `harness.mjs` loads modules once but each scenario builds a fresh repo (`harness.mjs:127`). | **Low** | |
| **CPU-contention under high `--test-concurrency`** | merged run (§2.2) | **Low–Med** | Raising concurrency can *slow* the merged suite and can cause near-timeout conditions if any test had a wall-clock budget (none do). Prefer fixing hot tests over cranking concurrency. |

---

## 7. Recommendations (ranked by impact / effort)

### R0 — Make the suite PATH-independent (impact: HIGH correctness; effort: LOW) — **do first**
- `tests/unit/cli.test.mjs:37` and `tests/lib/helpers.mjs:96` — spawn `process.execPath` (or a `NODE` constant resolved once) instead of bare `'node'`.
- `tests/contract/gate-commands.test.mjs:278,282` — use `process.execPath` in the `defaultRunner` argv (or make `defaultRunner` resolve `argv[0]==='node'` to `process.execPath`).
- `eval/run.mjs:445` — spawn `process.execPath` for the nested `node --test --experimental-test-coverage`.
- *Effect:* removes the 6 false failures and the `0/1 test file(s) exited 0` coverage false-negative; makes results deterministic across machines/CI. Verified: with node on PATH all 906 pass.

### R1 — Merge `npm run test` into one `node --test` (impact: MED–HIGH wall-clock; effort: LOW)
- Change `package.json` `"test"` to a single invocation: `node --test 'tests/unit/**/*.test.mjs' 'tests/contract/**/*.test.mjs' 'tests/integration/**/*.test.mjs' 'tests/adversarial/**/*.test.mjs' 'tests/fault/**/*.test.mjs'` (precedent: `test:coverage`/`eval:test` already do this).
- **Do not** raise `--test-concurrency` above default (measured: it *slowed* the merged run, §2.2). Keep `test:unit`/… as the spec-layer gate scripts.
- *Effect:* eliminates 5 process/module-graph restarts and the `&&` serialization; measured merged default run = **47 s / 906 pass** vs the sum of 5 sequential layers (each re-importing). Gains are modest until R2/R3 land, but it removes the sequencing tax and simplifies the command.

### R2 — Decouple the O(N³) `state-machine` matrix test from per-cell DB construction (impact: HIGHEST single-file; effort: MED) — **biggest lever**
- `tests/unit/state-machine.test.mjs:47-58` + `:19` — instead of `fresh(from)` → `new TaskStateService(':memory:')` (full 19-statement `migrate`) **per cell**, use **one** in-memory service and reset state per cell (or a single migrated `DatabaseSync` passed to all `TaskStateService(db, …)` instances — `state-machine.js:164-167` supports a shared `DatabaseSync`), or split the exhaustive check into 9 actor-scoped batches with one DB each.
- *Effect:* cuts the ~11.2 s hot test (and ~6.7 s file) toward sub-second. This alone is ~20–35 % of the unit layer.

### R3 — Lower `bootstrapCI` resample count in tests (impact: HIGH; effort: LOW)
- `tests/unit/eval-report.test.mjs` — pass `buildReport({ …, bootstrapB: 500 })` (or `1000`) explicitly instead of the `B=10000` default (`eval/report.mjs:93`). The tests assert *reproducibility* and *significance direction*, not CI precision — a few hundred resamples is plenty for a deterministic seeded bootstrap (`eval-report.test.mjs:158` already pins `bootstrapSeed`).
- `tests/unit/eval-stats.test.mjs:51-55` — already uses `B:2000` for the paired cases but the `bootstrapCI([5,5,5,5],{seed:7})` default call at `:51` still uses `B=10000`; pass a small `B`.
- *Effect:* measured ~120 ms → ~6 ms per call; cuts `eval-report` (~3.8 s) and `eval-stats` (~2.7 s) substantially. Consider asserting the `bootstrapB` default once as a contract test so the prod default can't silently regress.

### R4 — Hoist duplicated runtime/repo setup into `tests/lib/` (impact: MED; effort: MED)
- Add `tests/lib/runtime-fixture.mjs`: `makeRuntime({files, config, useLock})` + `withRuntime(fn)` to replace the **25** inline `new Runtime({…})` blocks in `tests/integration/*.test.mjs`.
- Add a **cached git template** to `makeRepo` (`tests/lib/helpers.mjs:124-133`) so the 37 `git init`+commit fixtures clone a pre-baked repo instead of spawning `git init`/`config`/`add`/`commit` every time — biggest win for `project.test.mjs` (15 tests, 2.5 s) and `cli.test.mjs` (19 child-process spawns).
- *Effect:* less copy-paste drift + fewer subprocess spawns.

### R5 — Reduce property-test loop counts where equivalence is already proven (impact: LOW–MED; effort: LOW)
- `tests/unit/glob-equivalence.test.mjs:33,46` (2,000 + 4,000 iterations), `tests/unit/complexity.test.mjs:24,102` (100 + 500), `tests/unit/guard.test.mjs:115,125` (400 + 300). These are seeded (`mulberry32`) so they're deterministic; trim iteration counts (e.g. 2,000→500) or gate the high counts behind `process.env.CI_FULL` while keeping a smaller always-on sample.

### R6 — Replace regex-on-reason assertions with stable codes (impact: MED maintainability; effort: MED)
- `tests/unit/budget.test.mjs`, `state-machine.test.mjs`, `scheduler.test.mjs`, `verifier.test.mjs`, and the render-snapshot tests in `context.test.mjs`/`metrics.test.mjs`/`debug.test.mjs` — assert on a structured `reason`/`code` field (or a stable enum) rather than regex-matching human-readable text. Add a `normalize-events`-style sanitizer if the reason strings must stay human-readable.

### R7 — Replace raw-SQL / `_setState` internal access with behavioral drivers (impact: MED maintainability; effort: MED–HIGH)
- `runtime.test.mjs:324,467,625`, `e2e/53-*` (`h.runtime.db.prepare(...)`), and all `._setState` call sites (§5.2) — drive states through legal transitions or expose a supported test seam instead of SQL/private setters. This decouples tests from the versioned schema (`schema.js:237-301`) and private API.

### R8 — Tighten the debounce sleep (impact: LOW; effort: LOW)
- `tests/unit/selftest-copies.test.mjs:136` — replace the fixed 150 ms sleep with a bounded poll or injected clock (see §2.3). Removes the only flake-prable wall-clock wait.

---

## 8. Evidence appendix (key measurements)

- **Unit layer:** 665 tests, 644 pass / 21 fail (all 21 from `cli.test.mjs` (19) + `eval-harness-hardening.test.mjs` (2)) **only when node is off PATH**; with node on PATH → 665/665 pass.
- **Full 5-layer merged:** 906 tests, **906 pass / 0 fail** with node on PATH (default concurrency, 47.2 s; `--test-concurrency=8`, 51.8 s).
- **`--test-concurrency=1` on unit:** 68.7 s vs 33.0 s default → file-level parallelism is already ~2× effective; don't serialize.
- **state-machine DB ctor cost:** 1,296 × `new TaskStateService(':memory:')` = **18.6 s** (`state-machine.js:164-167`, `schema.js:237-243`, 19 DDL stmts).
- **bootstrapCI cost:** 20 × `bootstrapCI` ≈ **2.4 s** (~120 ms each at `B=10000`, `stats.mjs:104`).
- **Timers in suite:** exactly 2 real `setTimeout` waits (`selftest-copies.test.mjs:136` 150 ms; `update-safety.test.mjs:148` 25 ms); no `waitFor`/`setInterval`/port/listen anywhere.
