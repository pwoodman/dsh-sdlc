# Developer-value verification — how to show a developer is better off with the plugin

**Status:** proposed addendum to [`EVAL_PROTOCOL.md`](EVAL_PROTOCOL.md). This
document does not change the pre-registered code-outcome protocol; it adds the
missing developer-outcome layer and the evidence ladder needed before any
"better off" claim is published.

**Claim under test (one sentence):** *For the same developer, task, model and
limits, using the SDLC plugin produces a verified change sooner, with no more
human intervention and no worse quality, than using DeepSeek Harness alone.*

"Verified change" means: the change passes the repository's pre-existing test
suite **and** the task's independently authored, held-out acceptance checks, and
is merged (or accepted by the same independent evaluator in the baseline arm).
Tests that the agent writes about itself do not count.

---

## 1. Why the current evaluation cannot answer the question

The harness is unusually honest, but six gaps make a "developers are better off"
conclusion unsupportable today.

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| 1 | **The decisive arm is missing.** The protocol defines A (baseline), B (plugin), C (placebo-plugin) and D (docs-only); the code only supports two arms. | `ARMS = ['control','treatment']` in [`eval/lib/records.mjs`](eval/lib/records.mjs#L18); `validateRecord` rejects any other arm | If B ≈ C, the win is prompt text, not orchestration — the one confound the protocol calls fatal cannot be measured. |
| 2 | **The decision rule is prose, not code.** `buildReport()` prints counts but never returns a verdict; the 5-point rule, 5 pp acceptance margin and 25 % cost margin have no implementation. | [`eval/report.mjs`](eval/report.mjs) `buildReport()` | The reader hand-applies the rule — exactly where endpoint shopping and post-hoc interpretation enter. |
| 3 | **The planned n cannot reach significance under the corrected alpha.** Exact two-sided Wilcoxon with perfect dominance: n=5 → p=0.0625; the smallest Holm threshold for 12 endpoints is 0.004167, reached only at n=9. Even a reduced 3-endpoint family (α≈0.0167) needs n=7. | arithmetic; `pairedSampleSize` uses α=0.05, not the corrected α | The protocol's "minimum 5 repeats" can never reject anything; the power claim understates n by ~70 %. |
| 4 | **Every endpoint is a code artifact.** Duplication, complexity, cycles, regex a11y/secrets, p95/error rate, tokens. There is no time-to-verified-change, intervention, rework, review-round-trip or onboarding metric. | `PRIMARY_METRICS` in [`eval/report.mjs`](eval/report.mjs#L45) | "Better off" is inferred from code shape, not from what a developer experienced. |
| 5 | **Acceptance checks are gameable and sometimes weak.** Five of seven tasks use `file-contains` on `src`; the four code tasks all reuse `node --test tests`, while the two UI tasks rely on a rubric. | `eval/tasks/*.json` | A comment containing `cursor` can pass a check. The harness never proves a task distinguishes the seed from a correct solution. |
| 6 | **Ecological validity is limited.** Live runs are one-shot `dsh --json <requirement>` with no human, no second turn and no review. | [`eval/run.mjs`](eval/run.mjs) live executor | Human interventions are 0 in both arms by construction — the mechanism the plugin claims to improve is not exercised. |

Additional integrity holes observed by tampering (all reproduced outside the
repo):

- records with different models/providers across arms are analysed silently;
- a treatment run with no source on 3/7 tasks silently shrinks n from 12 to 6
  instead of being reported as censored;
- duplicate `runId` is refused (good) but duplicate `(task, arm, repeat)` is not;
- `costUsd` is hard-coded `null`, so cost non-inferiority can never be computed;
- `environment` is collected once per study, so a mid-study `dsh` upgrade is
  invisible.

The only report this checkout can currently produce is the placebo: all medians 0,
all p=1, CIs `[0,0]`. That is correct — and it is not evidence about DSH.

---

## 2. What "better off" means — the outcome model

A developer is better off if the plugin improves at least one of these without
regressing the others:

| Dimension | Operational definition | Why it matters |
|---|---|---|
| **Speed to verified change** | Wall-clock from requirement start to the first state that passes the held-out checks and the repo suite. | The core promise: less time spent getting to green. |
| **Completion** | Share of tasks that reach a verified change within the task budget. | A faster path that fails more often is not better. |
| **Human effort** | User turns after the initial requirement + escalations requiring a decision, per completed task. | The plugin should not turn the developer into a dispatcher. |
| **Rework** | Distinct files edited ≥2 times ÷ files edited; gate-fail→fix cycles per task. | Fewer loops means less context switching. |
| **Quality/durability** | Held-out acceptance pass rate; regression rate at 7/30 days; escaped defects per 100 merged tasks. | Speed that ships defects is a loss. |
| **Cost/trust** | Tokens, estimated cost, wall-clock overhead; NASA-TLX and trust rating; install/onboarding time. | A tool that is slower, pricier or distrusted will be abandoned. |

For each dimension, the null is "no better than plain DSH within the
pre-registered margin", not "no difference". A non-inferiority result is a
legitimate outcome; it supports "safe to adopt", not "faster".

---

## 3. The evidence ladder

Do not skip straight to a large model benchmark. Each level answers a different
question and each has a go/no-go gate.

### Level 0 — "Can a developer get to first value?" (pre-launch, 1 week)

**Participants:** 5 developers who did not write the plugin (at least 2 outside
the organisation). **Task:** install from the published tarball on a clean
machine, run `sdlc init`, start a session, and make one small verified change in
a seeded repo. Think-aloud, screen recording, no help from the authors.

**Measures:** install success without help; time to first successful
`sdlc status`; time to first verified change; blockers encountered; SUS.

**Go/no-go:** ≥4/5 install unaided, median first verified change < 30 min, no
P0 blocker. If this fails, "better off" is moot — fix onboarding first.

**Cost:** ~5 hours of participant time plus a facilitator. This is the cheapest
evidence with the highest launch value.

### Level 1 — "Is the output better at equal cost?" (deterministic, 1–2 weeks)

This is the existing A/B protocol with four corrections:

1. **Three arms, mandatory:** A control, B plugin, **C placebo-plugin** (same
   preset text, no orchestration/gates/worktrees). D docs-only is optional for
   the two UI tasks.
2. **Executable decision rule** (`verdict()`), pre-registered, printed in the
   report.
3. **Three primary endpoints, not twelve:** `duplication`, `module-cycles`, and
   `complexity` — all measurable by the offline collectors and all part of the
   claim. Reliability endpoints (`error-rate`, `latency-p95`) form a separate,
   pre-registered confirmatory family once the pinned artifact toolchain
   produces real values; they are not swapped in after seeing data. Cost and
   duration live in a **non-inferiority** family.
4. **Task suite hardening:** 12 tasks (add 2 repo-fixture tasks and 3 negative
   controls: typo, comment-only, format-only), each with a **reference patch**
   and a **seed-fails** test. A task whose seed passes its own acceptance checks
   is rejected by the validator.

**Sample size:** pilot to estimate dz. At dz=0.5, α=0.05, power 0.8 → ~32
pairs; with Holm over 3 endpoints (α≈0.0167) → ~42 pairs. 12 tasks × 4 repeats =
48 pairs is a defensible default. n=5 cannot produce significance; do not ship
a claim from it.

**Cost:** measure $/run in the pilot and commit a hard cap before the
confirmatory run (2× the pilot estimate). Shard with `--shard-index/--shard-count`
and merge.

**Go/no-go:** arm C boots and differs from B only by the orchestration rows;
all integrity tests green; at least one task where the seed fails and the
reference passes; the negative controls are neutral in the pilot.

### Level 2 — "Are developers actually faster?" (crossover, 3–5 weeks)

**Design:** full within-subject crossover. 8–12 developers, 3–4 representative
tasks, and **every developer completes every task in both arms** (so each
developer contributes one pair per task). Arm order is counterbalanced across
developers and tasks (ABBA / Latin square); task order is randomised; use
equivalent task variants or a washout between arms so the second arm is not
simply a memory test. Same model snapshot, limits, machines and held-out checks.

**Primary endpoint:** time-to-first-verified-change, log-transformed, paired by
(developer, task). **Co-primary guardrails:** completion and human
interventions. **Secondary:** rework, NASA-TLX, trust, token cost. **Analysis:**
exact Wilcoxon signed-rank on paired log differences; seeded bootstrap 95 % CI;
Holm across the three pre-registered outcomes; report every secondary endpoint
without a significance filter.

**Sample size:** n is the number of (developer, task) pairs: 10 developers × 4
tasks = 40 pairs, or 12 × 4 = 48. At dz=0.5 and α=0.0167, ~42 pairs are needed
for ~80 % power; 10×3=30 pairs is a pilot, not a confirmatory result. A full
crossover costs 2 × tasks sessions per developer (3 tasks ≈ 6–8 hours; 4 tasks
≈ 8–12 hours), so schedule 12 participants to retain 10 and price the study
accordingly. Do not add tasks after seeing outcomes.

**Thresholds (pre-registered):**

- median TTFVC improvement ≥ 20 %, 95 % CI upper bound < 0;
- completion difference ≥ −5 percentage points;
- human interventions ≤ +1 per task;
- NASA-TLX no worse by >5 points;
- token/wall-clock cost ≤ +25 %.

**Falsifiers:** TTFVC worse by >10 %, interventions +2 or more, or completion
worse by >10 pp. Any one of these means "not better off" for this population,
even if code metrics improved.

**Cost:** 10 developers × ~6–8 hours. Plan for scheduling loss; budget 12
participants to retain 10.

### Level 3 — "Does it hold in real work?" (field, 8–12 weeks)

**Participants:** 10–20 developers on real repositories, opt-in telemetry.
**Design:** interrupted time series / pre-post with a concurrent control team
where possible; not a single-team before/after.

**Measures:** lead time (requirement→merge), rework rate, review round-trips,
escaped defects at 30 days per 100 merged tasks, gate false-positive rate,
update failures, abandonment rate.

**Thresholds:** regression rate ≤0.8× baseline and lead time ≤0.8× baseline, with
no increase in false gate blocks; otherwise report the null.

**What to publish:** anonymised aggregates, the pre-registered protocol, the
task suite, the model snapshot, the raw analysis command, and the negative
controls. Publish regressions and nulls with the same prominence as wins.

---

## 4. Instrumentation to add

The plugin already emits most of the raw material; the harness needs collectors,
not new product telemetry.

| Signal | Source | Collector |
|---|---|---|
| Phase timestamps (plan, dispatch, verify, merge) | `events` table / `.sdlc/` state | `eval/lib/dx.mjs` reads the run workspace after exit |
| Gate attempts and failures | `.sdlc/verification/*` logs + gate JSON | count `fail`→retry cycles per task |
| Human interventions | session NDJSON: user messages after the first, `sdlc_request_decision`, escalations | count per completed task |
| Tool/role activity | session NDJSON tool-call events | roles used, dispatches, plan edits |
| Rework | edit/write tool calls by path | distinct path edited ≥2× ÷ distinct paths |
| Tokens/cost | existing usage parser + price table | cost is an estimate; `null` if no table |
| Environment | existing `env.mjs` | stamp every record; refuse cross-record drift |
| Acceptance | held-out checks + repo suite | evaluated after exit, never from agent claims |

Add `verdict()` to `eval/report.mjs` with this shape (pre-registered):

```js
verdict({ primary, acceptance, cost, placebo, armC, negativeControlWon }) => {
  if (!armC) return 'inconclusive: arm C missing';
  if (negativeControlWon) return 'refuted: harness bias';
  if (primary.some(regressionCIExcludesZero)) return 'refuted: primary regression';
  if (placebo >= pluginOnWinningEndpoint) return 'refuted: prompt/scaffold effect';
  if (!primary.some(winCIExcludesZero)) return 'inconclusive: no primary win';
  if (acceptance.delta < -0.05) return 'refuted: acceptance regression';
  if (cost.treatment.wallClock > 1.25 * cost.control.wallClock
      || cost.treatment.tokens > 1.25 * cost.control.tokens) return 'refuted: cost regression';
  return 'supported';
}
```

The report must print that verdict *before* the metric table, and refuse to label
a study "confirmatory" if any integrity precondition fails.

### Integrity tests the harness needs

1. **Arm integrity:** refuse a report when control and treatment models differ,
   when a `dsh` record has no observed model, or when `environment.dsh`/`node`/
   `git` drift across records from the same study.
2. **Pairing integrity:** refuse duplicate `(taskId, arm, repeat)`; when a metric
   is unavailable in one arm, mark the pair `censored` and keep n unchanged
   (never silently drop it).
3. **Placebo integrity:** `verdict()` returns `inconclusive` when arm C is
   absent; arm C's prompt text is byte-identical to B's.
4. **Protocol integrity:** parse the endpoint list from `EVAL_PROTOCOL.md` §6
   and assert set equality with `PRIMARY_METRICS`; assert cost metrics are not
   in the benefit family.
5. **Power integrity:** assert the planned n clears the corrected alpha for the
   observed effect; refuse a "confirmatory" label when n<7 with 3 endpoints or
   n<9 with 12.
6. **Task integrity:** each task's seed fails its acceptance checks; its
   reference patch passes; every task has at least one `command` check; the
   negative controls are marked `control:true`.
7. **Blinding integrity:** rubric artifacts carry no `arm`/`runId`; the
   Krippendorff α is computed and α<0.67 yields `inconclusive`.
8. **Cost integrity:** `costUsd` is populated from a checked-in price table or
   the endpoint is `unavailable`; it is never silently `null` and then treated as
   a null result.

---

## 5. Claims ladder — what may be said, when

| Evidence level | Allowed claim | Not allowed |
|---|---|---|
| None (today) | "Adds isolated worktrees, gates, evidence and an audit trail." Capability statements only. | "Faster", "better code", "fewer bugs", "beats plain DSH". |
| Level 0 | "In a 5-person usability test, 5/5 installed unaided and reached a first verified change in a median X minutes." | General productivity claims. |
| Level 1 | "On a pre-registered 12-task suite with model M, the plugin improved duplication, module cycles and complexity by X (95 % CI …), with cost non-inferior; no claim is made for other models or real projects." | "Developers are more productive." |
| Level 2 | "In a counterbalanced crossover with 10 developers and 4 tasks, verified changes were X % faster (95 % CI …), with no increase in interventions or workload." | Claims outside the tested population/tasks. |
| Level 3 | "In a 12-week field pilot across N developers, lead time and 30-day regression rate were X and Y versus baseline." | Causal claims without the concurrent control. |

Publish the protocol, the tasks, the raw records, the analysis seed, the negative
controls, and every null/regression. The current README's refusal to claim an
A/B win is the right default; this ladder tells you what would earn a stronger
sentence.

---

## 6. When *not* to use the plugin (say this out loud)

Honest positioning is part of the value proposition and protects the claim:

- one-line fixes, typo/format-only changes, and exploratory spikes where the
  overhead of planning, worktrees and gates dominates;
- repositories with no test suite and no gate commands — the plugin cannot
  verify what the project does not define;
- environments where the `dsh` CLI cannot spawn workers (for example a
  Desktop-only machine), where the lead and UI work but dispatch does not;
- developers who need a sub-minute edit-build loop; the plugin is a
  verification/coordination tool, not a faster editor.

A "do not use it here" section in the README is evidence of judgement, not a
weakness, and it makes the positive claim more credible.

---

## 7. Smallest credible pre-launch package

If there is only one week before the npm push, do this:

1. **Level 0 with 5 external developers** (2 days). Fix every install blocker
   found; publish the result as an honest usability note.
2. **T1–T13 from [`PRE_NPM_TEST_REVIEW.md`](PRE_NPM_TEST_REVIEW.md)** (3 days).
   These are release-integrity tests, not research; they prevent a broken or
   no-op publish.
3. **Level 1 pilot with 3 tasks × 1 repeat × 3 arms** (1 day, small budget).
   Prove arm C boots, the model is pinned, and the verdict is null. Do not
   publish a win from the pilot.
4. **Publish under the "capability" claim only.** Schedule Level 1 confirmatory
   and Level 2 after launch, with the pre-registered protocol unchanged.

This sequence means the first public claim is "it installs, it verifies, it
leaves an audit trail", and the first performance claim arrives only with data
that could have falsified it.

---

## 8. Open decisions for the research owner

1. Who authors the 12 tasks (external authors preferred; at minimum, someone
   other than the plugin author writes the acceptance checks)?
2. Which two model snapshots are pinned, and is a second model required before
   a public claim?
3. What is the hard budget cap for Levels 1 and 2, and who approves it?
4. Is the L2 population internal dogfooders or external developers? Internal
   dogfooders are cheaper but bias toward the tool's intended workflow.
5. Which claim, if any, ships in the launch post? Recommendation: Level 0 only.
