# IMPROVEMENT_AUDIT.md — what is worth changing, and what is not

An honest pass over the plugin for speed, token use, architecture, extensibility,
UI/UX and security. Each item names its evidence, the impact, the effort, the
risk, and whether it was **fixed** this session, is **mitigated**, or is a
**recommendation** that was deliberately not implemented (with the reason).

The rule applied throughout: a change is only worth making if it removes a real
defect or a plausible future defect. Churn for its own sake is not an improvement.

## Fixed this session

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | **Per-task budgets were enforced against project-wide spend.** `Runtime.canDispatch` compared `spentTotals()` (all tasks) with one task's cumulative ceiling, and passed `0` for cost and duration, disabling those two ceilings. | `packages/sdlc-core/src/runtime.js` `canDispatch` | `spentForTask(taskId)` + all four limits enforced. Regression test `tests/unit/budget-isolation.test.mjs`. |
| 2 | **`evaluateRun` conflated project spend with task-cumulative cost**, so a busy sibling task could escalate an untouched one. | `packages/sdlc-core/src/budget.js` | explicit `taskSpend`; `projectSpend` now only feeds the project ceiling. Regression test `tests/unit/budget-spend-scope.test.mjs`. |
| 3 | **`checkNoOverlap` ignored its resource cap above 1**, so a 3-holder overrun against a cap of 2 was invisible. | `packages/sdlc-core/src/scheduler.js` | counts holders per resource; documented shape preserved. Regression test `tests/unit/scheduler-cap.test.mjs`. |
| 4 | **`recovery.reconcile` could emit two contradictory transitions** for one task (dead worker + missing worktree), plus a stale "KNOWN INCONSISTENCY" note that was no longer true. | `packages/sdlc-core/src/recovery.js`; `tests/integration/orphan-salvage.test.mjs` | exactly one transition per task; ambiguity escalates over salvage; the note now pins deviation D4. Regression test `tests/unit/recovery-reconcile.test.mjs`. |

## Measured, and judged not worth changing

| Finding | Evidence | Verdict |
|---|---|---|
| **Tool-schema token cost is small.** The seven model tools serialise to ~4.6 KB (~1.2 k tokens) — the prompt packer's own budget is 24 k tokens. | `packages/sdlc-tools/src/index.js` | No action. There is no token waste to remove here; trimming descriptions would cost clarity for a rounding error. |
| **Gates are not a speed bottleneck.** The full offline suite is ~14 s and the 11-gate chain ~35 s, dominated by M8 re-running the suite and gate:Q measuring coverage. | `node scripts/validate-gates.mjs` timing | No action. The cost is deliberate end-to-end evidence, not accidental slowness. |
| **`sdlc-core` ↔ `sdlc-guard` duplication** (`glob-lite.js` vs `glob.js`, four `selftest.js` copies) is intentional for package independence (deviation D5) and is pinned by equivalence/copy tests. | `tests/unit/glob-equivalence.test.mjs`, `tests/unit/selftest-copies.test.mjs` | Mitigated. Extracting a shared package would re-introduce the dependency E6 exists to prevent. |

## Recommendations (not implemented — with reasons)

| # | Recommendation | Why it matters | Why it was not done here |
|---|---|---|---|
| 5 | **`observability.metricsExport` is a dead knob.** It is declared in the default config and read nowhere, so setting it silently does nothing. | A config key that lies is worse than no key. | **FIXED (go-live):** `packages/sdlc-core/src/metrics.js` renders the spend + task-state snapshot to `.sdlc/metrics.prom` in Prometheus exposition format when enabled (`sdlc status --metrics`, `Runtime.exportMetrics()`); disabled (default) is an explicit no-op. Pinned by `tests/unit/metrics.test.mjs`. |
| 6 | **The service surface is declared three times**: `SERVICE_NAMES`, the `makeService` facade lists, and `profiles/sdlc-probe/profile.json`'s `selftest.requires.services`. | Drift would silently weaken the boot-hook check that proves the composed product registers the right services. | **FIXED (go-live):** the facade table is now the single source (`SERVICE_METHODS` in `services.js`, consumed by `makeService`); `tests/unit/services.test.mjs` asserts the table equals the documented surface. The probe-profile service LIST remains the third declaration (it must — it is the composed-product assertion), now with `debug` registered. |
| 7 | **No client UI.** `sdlc-client-ui` is marked optional in the spec (C.1) and was not required by any gate. | If the plugin is meant to be operated by a human, the absence of any UI is the largest UX gap. | **PARTIALLY CLOSED (go-live):** no dashboard, but the review surface now exists as text: `sdlc debug compare` / `sdlc debug trace` (side-by-side time/tokens/tracepaths + `SIDEBYSIDE.md`), and `demo/` proves the loop on a real fullstack app. Full client UI remains a product decision. |
| 8 | **The guard is policy, not a boundary** (documented, and asserted honestly by the adversarial suite). | Readers may over-trust command-pattern matching. | Already stated plainly in the notes; the sandbox root and the git diff remain the real controls. |

## The evaluation framework (new)

The largest genuine gap was not in the code at all: there was **no way to show
the plugin is better than plain DSH with the same model**. Part K of the spec
validates the orchestrator against its own specification; nothing validated it
against a control.

Added this session:

- [`EVAL_PROTOCOL.md`](EVAL_PROTOCOL.md) — a pre-registered, controlled A/B design:
  four arms (baseline, plugin, placebo-plugin, docs-only), held-out acceptance
  checks, pinned model/toolchain, blinded jury for UI, paired statistics with
  multiplicity control, explicit falsifiers, and a decision rule.
- [`eval/`](eval/README.md) — the executable half: task manifests, objective
  metric collectors that never fabricate an unmeasurable number, exact/approximate
  Wilcoxon, seeded bootstrap CIs, effect sizes, power, Holm correction, run
  records, and a report that refuses to present a placebo as evidence.
- 61 offline tests pinning the harness (`npm run eval:test`).

The one thing it deliberately will **not** do is claim a result from a simulated
run: the `simulate` executor is a placebo, records say so in-band, and
`eval/report.mjs` refuses them unless `--allow-simulate` is passed. Running the
real experiment needs live model spend, which is opt-in (`--live`) and reviewed
before it starts.

## Follow-up hardening (70-run live study observations)The confirmatory attempt aborted at run 2/70 on a transient `PI_AI_ERROR`
(`reasoning_content` in thinking mode) — a provider blip, not an agent failure —
and the abort path worked as designed. The study also exposed a second class of
waste: every treatment run warned `26 entries did not activate … waiting for
service: agentPresets`. Fixed:

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 7 | **Re-running into an occupied `--out` silently doubled the placebo n** (42 → 84 duplicate `runId`s) while `study.json` described only the second half. | `.eval-out/records.jsonl` duplicate-runId count | output is fresh-by-default (`--append` / `--resume` required); every record carries `studySeed`; the report refuses mixed-seed or duplicate-runId files unless `--allow-mixed-seeds` / `--allow-duplicates`. |
| 8 | **A transient provider failure aborted the whole study** at run 2/70. | `.eval-out-live` abort on `PI_AI_ERROR` | `isTransientFailure()` + `--max-retries 2` with exponential `--retry-base-ms` backoff; retries disclosed in `notes`/`attempts`; `--resume` re-runs only non-`ok` runIds under the original seed. |
| 9 | **All 26 presets silently never mounted.** The `headless` template (the only one that can serve `--json`) ships no `agent-preset-registry` row, which `@deepseek-ai/dsh-agent-preset` injects. The `web` template has it; headless never did. | treatment stderr on every live run; `PROFILE_TEMPLATES` in `dsh-app-boot` | `sdlc-presets` now declares the `agent-preset-registry` row first (`presetRegistryRow()`, same config as `dsh-web-app`), generated by `gen-presets.mjs` and pinned by unit + contract tests. |
| 10 | **A 70-run study is ~2–3h sequential.** Workspaces are already isolated per (task, arm, repeat) but `run.mjs` is single-process. | 60–155 s/run observed | `--shard-index/--shard-count` (same `--seed` on every shard keeps arm order identical) + `eval/merge.mjs` (refuses mixed seeds / duplicate runIds). The `--jobs N` flag prints the exact shard commands. |
| 11 | **`coverage` / `dependency-audit` had no producer.** The collectors accepted artifacts but nothing wrote them, so 3+ endpoints stayed `NO DATA`. | report endpoint-coverage table | `eval/collect-artifacts.mjs` (`--coverage` via node test-coverage, `--audit` via `npm audit --json`, `--load` via k6 → autocannon → node:http smoke); collectors now parse real summary shapes instead of only `{value}`. |

## Live-executor hardening (earlier this session)

The offline harness was sound; the `dsh` executor was not. Running the
pre-registered live command produced records that looked like legitimate arm runs
while every underlying process had exited 1. Fixed, with evidence:

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | **A failed executor was recorded as a real run.** `executorError` was only set for spawn/fixture failures; a non-zero exit still produced a full record, metrics from the untouched fixture, and a report reading (the report turned two never-ran processes into a `durationMs` "loss"). | A live-shape run against missing profiles wrote 2 `executor:"dsh"` records with `exitCode:1` and `executorError:null`. | `status:"invalid"` on non-zero exit / no NDJSON stream / spawn error; invalid runs carry **no** metrics; a live study aborts at the first one; `report.mjs` refuses invalid records unless `--allow-invalid`, and excludes them from every endpoint even then. |
| 2 | **The live argv did not match the real CLI.** It passed `--model` (headless accepts only `--json`, `--session-id`, `-h`) and used `sdlc-web`/`default` (absent; and a `web`-template profile cannot serve a one-shot `--json` run). | `dsh --profile sdlc-web --json … → Error: profile "sdlc-web" does not exist` (exit 1). | Model is pinned via a generated `--patch` overlay (`agent-default-model`) passed to both arms; `preflightProfiles()` requires both arms to exist, be `headless`-template, and differ by the `@sdlc/*` bundles. The live plan (arms, model, DSH_HOME, seed, run count) prints before spending. |
| 3 | **Token counting silently read one frame.** A live `session.jsonl.zstd` is thousands of concatenated zstd frames; `zstdDecompressSync` decodes only the first. The parser reported "no usage" (all-null, zero errors) instead of a total. | A real log: 4652 frames, magic at offset 252; whole-buffer decode returned 310 bytes of 5.5 MB. | `lib/zstd-frames.mjs` splits frames in pure JS (RFC 8878 block walk, exact boundaries, `truncated` reported honestly). 4652/4652 frames decode; totals recover. Session usage counts committed `assistant/message` usage and never the duplicate streamed `chunk.usage`. |
| 4 | **The model was never recorded.** Records named whatever was passed on the command line, not what ran. | `request/header` events carry `data.header.config.{provider,model}`. | `lib/session.mjs` locates the run's session log (newer-than-start, confirmed by its own `cwd`) and the record stores the **observed** provider/model. |
| 5 | **Arm order was fixed** (always control, then treatment), against protocol §3. | `.eval-out/records.jsonl` arm sequence. | Seeded per-(task, repeat) randomisation; the seed is printed and written to `study.json`. |
| 6 | **Provenance and coverage gaps.** Records had no node/dsh/git/host identity; the report printed "0/12" with no way to tell "measured, no effect" from "never measured"; the bootstrap seed was not emitted; skipped acceptance checks were invisible. | Protocol §5/§9; `EVAL_PROTOCOL.md`. | `lib/env.mjs` stamps every record; the report adds an endpoint-coverage table, the bootstrap seed, and the skipped-check counts. |

Verification: `npm run eval:test` and the full offline
suite (597 tests) are green; the placebo still reports a null; the live command
now refuses to start against unconfigured profiles and writes nothing. Still
outstanding before a confirmatory run: the arm profiles must be installed
(`dsh plugin add` needs `pnpm`, absent here) and the artifact-backed endpoints
(`latency-p95`, `error-rate`, `coverage`, `mutation`) need the pinned toolchain.
