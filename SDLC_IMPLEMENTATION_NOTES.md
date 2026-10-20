# SDLC Orchestrator — implementation notes

**Subject:** `universal_sdlc_orchestrator_dsh_spec_v3.md` (2,336 lines)
**This build:** the `dsh-plugin-sdlc` monorepo — eight packages, three profile
recipes, seven test layers, eleven gates (P, M0–M8, Q).
**Platform:** Node ≥ 22.13 (verified v24.21.0), `@deepseek-ai/dsh` 0.2.0-rc.2, Linux x64.
**Status:** `gate:P` + `gate:M0` … `gate:M8` + `gate:Q` all green; 875 offline
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
