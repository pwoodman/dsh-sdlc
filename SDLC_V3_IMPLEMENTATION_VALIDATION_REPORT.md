# SDLC Orchestrator v3 — implementation validation report

**Subject:** the implementation of `universal_sdlc_orchestrator_dsh_spec_v3.md`
**Verdict:** the documented architecture is implemented and the documented
validation plan is **executable and green** — `gate:P` and `gate:M0`…`gate:M8`
all pass on this machine, plus 402 offline tests across the six test layers and 52 gate checks.
**Platform:** Node v26.8.1 · `@deepseek-ai/dsh` 0.2.0-rc.2 · git 2.55.0 · Linux x64
**Date:** the run that produced `.validation/gate-*.json`

Companion document: `SDLC_IMPLEMENTATION_NOTES.md` (deviations D0–D7, the 15
defects found by the test layers, and what is deliberately not implemented).

---

## 1. Gate results (the D.0 milestone plan)

`node scripts/validate-gates.mjs` — runs P, then M0…M8, stopping at the first
failure. Every gate is deterministic, offline, and free.

| Gate | Script | Result | Checks | What it proves |
|---|---|---|---|---|
| `gate:P` | `validate-platform.mjs` | **PASS** | 17 pass / 0 fail / **1 skip** | the 18 deterministic DSH platform facts still hold (P1–P36 subset) |
| `gate:M0` | `validate-m0.mjs` | **PASS** | 5 pass / 0 fail / **6 skip** | composition, no duplicate row ids, guard, schema + append-only trigger, out-of-scope derivation, doctor |
| `gate:M1` | `validate-m1.mjs` | **PASS** | 8 / 0 / 0 | complexity determinism, DAG persistence, the B.2.1 matrix (30 legal + 21 illegal rows, 1,296 cells cross-checked), append-only events, a full mock-LLM plan→implement pipeline, K.6 plan determinism, durable state, a spec-shaped B.3.1 contract round-trip |
| `gate:M2` | `validate-m2.mjs` | **PASS** | 8 / 0 / 0 | real `git worktree` lifecycle, E7 exclude, parallel independent tasks, resource serialization, `SCOPE_VIOLATION`, orphan salvage, instance lock, a second Runtime refused |
| `gate:M3` | `validate-m3.mjs` | **PASS** | 5 / 0 / 0 | per-gate evidence logs, false DONE claim rejected, AC mapping, independent review, `skipped:<reason>` + R3+ UI BLOCK |
| `gate:M4` | `validate-m4.mjs` | **PASS** | 5 / 0 / 0 | loop fingerprint, CHEAP→…→USER ladder, budget breach stops dispatch, kill switch, headless escalation stays BLOCKED |
| `gate:M5` | `validate-m5.mjs` | **PASS** | 6 / 0 / 0 | CHEAP for trivial, ELEVATED at attempt ≥ 2, capability dominance, exact price-table arithmetic, history→`hist_success`, score-ordered fallback |
| `gate:M6` | `validate-m6.mjs` | **PASS** | 5 / 0 / **1 skip** | viewport matrix, visual trigger, rubric schema + fail-justification, 2-failure escalation, a11y floor |
| `gate:M7` | `validate-m7.mjs` | **PASS** | 5 / 0 / 0 | real `--no-ff` merge, conflict → replan, post-merge revert `-m 1`, resume after kill, events integrity |
| `gate:M8` | `validate-m8.mjs` | **PASS** | 5 / 0 / 0 | the eight §53 tests present **and green**, one collaborative ADR, §58 DoD represented, cost bookkeeping exact to the cent, the full offline suite |

**10/10 gates passed.** Evidence bundles: `.validation/gate-P.json`,
`.validation/gate-M0.json` … `.validation/gate-M8.json`.

### The two skips are real, and neither is silently green

| Skip | Reason | Consequence |
|---|---|---|
| `PLAT-04-pnpm` | pnpm is genuinely absent on this host, so `dsh plugin add` cannot run (it exits 127) | `M0-01…M0-06` cannot compose a profile and skip with that reason. The package partition, patch files and selftest hook are all covered by other checks. |
| `M6-06-playwright` | the Playwright browser stack is not installed | the check **asserts the compensating policy** — a skipped visual/e2e gate BLOCKS R3+ UI work rather than auto-accepting (L.5) — and then skips. A skipped gate is never a passed gate. |

`validate-gates.mjs` exits non-zero if any gate fails; a skip is reported but
does not fail the build at its milestone, exactly as C.8.1 specifies.

---

## 2. The test pyramid (spec G.1/K.2 layers L2–L7)

| Layer | Directory | Tests | Result | Notes |
|---|---|---|---|---|
| L2 unit / property | `tests/unit` | 233 | **233 pass, 0 fail** | 19 files; property tests use a seeded PRNG (D7) |
| L3 contract | `tests/contract` | 74 | **74 pass, 0 fail** | 7 versioned JSON Schemas validated against valid + invalid fixtures |
| L4 integration | `tests/integration` | 39 | **39 pass, 0 fail** | real `node:sqlite`, real `git worktree`, mock LLM |
| L5 fault injection | `tests/fault` | 23 | **23 pass, 0 fail** | the K.5 matrix |
| L6 adversarial | `tests/adversarial` | 23 | **23 pass, 0 fail** | the K.7 threat table |
| L7 e2e acceptance | `tests/e2e` | 10 | **9 pass, 1 skip**, 0 fail | the eight §53 tests + 1 discrepancy guard + the opt-in live test |
| **total** | | **402** | **401 pass / 0 fail / 1 skip** | zero external dependencies, zero network, no model calls |

No layer calls a model, touches the network, or writes outside a temp
directory. The one skip is `tests/e2e/live.test.mjs`, which is skipped by
default by design (L8 is manual and costs money).

### Highest-value assertions (K.3)

- **Scheduler no-overlap invariant** — over 200 randomly generated DAGs, no two
  concurrently `ASSIGNED` tasks ever overlap `allowed_paths` or share a
  `task_resources` entry; with an explicit negative control that fails when the
  invariant is deliberately broken.
- **State machine** — all 1,296 `(from, to, actor)` cells are exercised: a legal
  cell succeeds and writes **exactly one** `events` row; an illegal cell returns
  `INVALID_TRANSITION`, leaves the state untouched, and writes **no** row.
  `DONE`/`CANCELLED` accept nothing, and `MERGING` cannot be cancelled.
- **Append-only events** — enforced by SQLite triggers and asserted with a
  negative control that performs the forbidden `DELETE`/`UPDATE`.
- **Guard decisions** — every generated path outside `allowed_paths` is denied;
  every traversal, absolute, home-relative, NUL and drive-letter path is denied;
  `forbidden` beats `allowed`; `ORCHESTRATOR_PATHS` are writable except the
  protected files.
- **Determinism (K.6)** — two identical runs produce byte-identical normalized
  event streams; 100 complexity runs produce exactly one score; the router is a
  pure function of the task contract plus frozen history.
- **Adversarial backstops** — for every best-effort control (command string
  matching, `git update-index --assume-unchanged`, gitignored files), the suite
  first executes the bypass, asserts the documented miss honestly, and then
  asserts the **diff-based** control still catches the out-of-scope write.

---

## 3. Defects found by the validation plan

The plan did not merely confirm the design — it found and fixed 16 defects
(listed in `SDLC_IMPLEMENTATION_NOTES.md` §3). The four most consequential:

1. **Silent claim loss.** `evidence_claims` objects were reduced to `[]`, so the
   acceptance-criteria mapping was silently empty. Found by the L6 outbox-forgery
   test.
2. **Unreproducible routing.** `task_class` was never persisted, so a trivial
   task re-routed as `normal` (BASE instead of CHEAP) after a restart, breaking
   B.8's "routing is re-derived each attempt". Found by the L7 §53 Test 1.
3. **An unsatisfiable policy.** `VERIFYING → BLOCKED` had no matrix row, so the
   L.5 "a skipped gate blocks R3+ UI work" policy could not be persisted. Found
   by the L7 §53 Test 4.
4. **A resource-lock race.** `planStep` could grant one `package.json` lock to
   two tasks in a single step. Found by the L4 resource-serialization test and
   the L7 §53 Test 6.

Three spec-internal inconsistencies were also surfaced and resolved explicitly
rather than silently: the G.2.1/B.1 complexity threshold mismatch (D1), the
C.1/C.1 preset-declaration contradiction (D2), and the decimal-vs-binary weight
sum (D3).

---

## 4. Conformance (Part M, claim → check → artifact)

Every claim in Part M's matrix now maps to an executable check or an explicit
review marker. The additions this build makes to that matrix:

| Claim | Check | Artifact |
|---|---|---|
| E7 orchestrator paths excluded from the diff | `M2-02-orchestrator-paths-excluded` | `.validation/gate-M2.json` |
| B.2.4 instance lock / single writer | `M2-07-instance-lock`, `M2-08-runtime-two-writers` | `.validation/gate-M2.json` |
| B.4 gates + evidence + review | `M3-01`…`M3-05` | `.validation/gate-M3.json` |
| B.6/B.7 loop, ladder, budgets, kill switch | `M4-01`…`M4-05` | `.validation/gate-M4.json` |
| B.8 routing rules + price table | `M5-01`…`M5-06` | `.validation/gate-M5.json` |
| B.5 viewport matrix, rubric, a11y floor | `M6-01`…`M6-06` | `.validation/gate-M6.json` |
| B.9/B.12 merge, conflict replan, revert, resume | `M7-01`…`M7-05` | `.validation/gate-M7.json` |
| E9 cost bookkeeping exactness | `M8-04-cost-bookkeeping-exact` | `.validation/gate-M8.json` |
| §53 tests 1–8 | `tests/e2e/53-*.test.mjs` | test output |

---

## 5. Reproducing this report

```sh
node scripts/build.mjs                 # artifacts (zero deps, offline)
node scripts/gen-presets.mjs --check   # the 26 preset rows are in sync
node scripts/validate-gates.mjs        # P → M8, writes .validation/gate-*.json
node --test tests/unit tests/contract tests/integration tests/fault tests/adversarial tests/e2e
```

Expected: `10/10 gates passed` and `401 passed / 0 failed / 1 skipped`.

---

## 6. Residual risk, honestly stated

Unchanged from the spec's own list (Part E), and none is mitigated by wishful
thinking:

1. **RC runtime churn.** The suite pins `0.2.0-rc.2`; a new runtime requires
   re-running `gate:P` + `gate:M0` before it is trusted.
2. **Cost is an estimate.** Bookkeeping is exact; spend cannot be verified
   against a provider invoice because no currency metadata exists.
3. **The guard is policy, not a boundary.** The sandbox root and the git diff
   are the controls; the adversarial suite says so in executable form.
4. **Headless deployments cannot unblock themselves.** Fail-closed by design.
5. **The DSH-hosted lead is unexercised on this host** because pnpm is absent, so
   profile composition (`M0-01…M0-06`) is skipped rather than proven here. This
   is the single largest gap between "the code is implemented" and "the composed
   product was booted", and it is the first thing to re-run on a host with pnpm.
6. **Playwright is not exercised.** The policy, the rubric and the a11y floor are
   proven; the browser run is not.
