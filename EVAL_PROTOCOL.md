# EVAL_PROTOCOL.md — proving the DSH + SDLC plugin advantage

**Status:** pre-registered protocol. The *harness* in `eval/` is implemented and
tested offline; executing the confirmatory study requires live model runs, which
cost money and are run only on explicit approval.

**Claim under test.** For the same task, the same model, the same machine and the
same limits, DeepSeek Harness **with** the SDLC plugin produces a measurably
better engineering outcome than DeepSeek Harness **alone** — better architecture
and less duplication, more and better tests, faster and more reliable APIs, safer
code, a more coherent UI/UX — at non-inferior cost and wall-clock time.

This document exists because a claim like that is worthless without a design that
could have falsified it. Everything below is fixed *before* the data is seen.

---

## 1. Why the obvious comparison is not enough

"Run the plugin, look at the output, declare it better" has at least five confounds
that would invalidate the result:

1. **The prompt and tool surface change too.** The plugin ships role presets and
   guidance, so an observed win might come from prompt engineering, not from the
   orchestration (planning, worktrees, gates, evidence, review). We must separate
   the two.
2. **Model nondeterminism.** A single run per task is noise, not a result.
3. **Task leakage.** If the acceptance checks are visible to the agent, it can
   satisfy the check rather than the requirement.
4. **Evaluator bias.** "This UI is beautiful, not slop" is a judgement; unblinded
   judgement tracks expectations.
5. **Cherry-picking.** Reporting only the tasks where the plugin won.

The design below neutralises all five.

---

## 2. Arms

| Arm | Composition | Purpose |
|---|---|---|
| **A — baseline** | DSH, stock profile, no SDLC plugin | the control |
| **B — plugin** | DSH + SDLC plugin (planning, worktrees, gates, evidence, presets) | the hypothesis |
| **C — placebo** | DSH + a *no-op plugin* with the same prompt/preset text but no orchestration, no gates, no worktree isolation | isolates prompt/scaffold effects from orchestration |
| **D — docs-only** | DSH + the plugin's documentation/guidance, single-threaded | separates "better prompting" from "better process" |

The confirmatory comparison is **B vs A**. Arms C and D are explanatory: if
B ≈ C, the win is prompt text and the orchestration claim is not supported.

The arms differ **only** in the composed DSH profile. Requirement text, fixture,
model id, model snapshot, temperature, seed (where supported), cwd, wall-clock
and cost limits, and the acceptance harness are identical by construction.

**How the model is held identical.** `dsh` exposes no `--model` launcher flag and
the one-shot app does not accept one, so the snapshot is pinned by a generated
`--patch` overlay that sets `agent-default-model` (`provider` + `model`) and is
passed to *both* arms. The harness records the model it observes in each run's
persisted session log (`request/header`), not the model it intended to use, so an
unpinned or drifted run is visible in the record rather than assumed away. Both
arms must be `headless`-template profiles; the harness refuses to start otherwise.

---

## 3. Design and unit of analysis

- **Unit:** one (task, arm, repeat) run. Records are append-only JSONL
  (`eval/lib/records.mjs`) with the model and executor identity stamped in.
- **Pairing:** every task is run in every arm, and pairs are formed by repeat
  index. This removes task-to-task difficulty as a source of variance.
- **Randomisation:** arm execution order is randomised per task/repeat, so a
  time-of-day or machine-load drift cannot favour one arm.
- **Isolation:** every run gets a fresh workspace materialised from the pinned
  fixture; no state carries over.
- **Repetitions:** n per arm per task is set from the power calculation (§7),
  minimum **5**, target **10** for the confirmatory run. At dz = 0.8 this is
  ≈ 7 pairs; at dz = 0.5 it is ≈ 32, so a pilot must estimate dz before the
  confirmatory run is sized.
- **Frozen environment:** one container image, pinned by digest, with the
  analysis toolchain pinned (see §5). The host's `node`, `git` and `dsh` versions
  are recorded in every record.

---

## 4. Task suite

`eval/tasks/*.json` holds declarative manifests: the exact requirement given to
both arms, the fixture, the acceptance checks, the metric set, the budget and the
strata (risk class, size).

Shipped tasks cover the dimensions the claim names:

| Task | Dimension | What it discriminates |
|---|---|---|
| `arch-csv-export` | architecture, code-quality | reuse of an existing layer vs a second data path |
| `ui-dashboard` | ui, ux | responsive layout, one design scale, honest empty/error states |
| `ui-form-a11y` | ui, ux | labels, announced errors, keyboard completion |
| `api-pagination` | api-performance, api-reliability | stable cursor semantics under mutation |
| `sec-authz` | security | server-side object-level authorization |
| `refactor-dedupe` | architecture, code-quality | consolidation without behaviour change |
| `control-docs-typo` | (negative control) | the plugin must be **neutral**, not better |

Rules:

- **Acceptance checks are held out.** They live in the manifest, never in the
  prompt, and the harness evaluates them after the agent has exited. A task whose
  checks the agent can read is not admissible.
- **The negative control is mandatory.** If the plugin "improves" a one-word typo
  fix, the harness is measuring noise or bias, and the study is void.
- **Expansion follows the same schema.** New tasks must be added *before* the
  confirmatory run, not after seeing results.
- **Fixtures are pinned.** `greenfield` fixtures are inline seed files; `repo`
  fixtures name a URL and a commit SHA. A moving branch is inadmissible.

---

## 5. Measurement

### 5.1 Objective, automatable

The offline harness ships dependency-free collectors (`eval/lib/metrics.mjs`) and
is explicit about their strength (`method`, and `available:false` with a reason
when it cannot measure). **No public claim may rest on a proxy alone.** The
confirmatory run uses the pinned toolchain:

| Dimension | Metric | Tool (authoritative) | Offline proxy shipped |
|---|---|---|---|
| Architecture | duplication ratio | `jscpd` | normalised 4-line window clone ratio |
| Architecture | dependency cycles | `madge`/`dpdm` | relative-import DFS |
| Code quality | cyclomatic complexity | `eslint complexity` / `lizard` | decision-point regex |
| Code quality | dead code, unused exports | `knip` | — (unavailable) |
| Tests | line coverage | `node --test --experimental-test-coverage` / `c8` | — (artifact) |
| Tests | mutation score | `stryker` | — (artifact) |
| Tests | test-to-source ratio | path classification | path classification |
| UI | accessibility | `axe-core` (via Playwright) | static regex proxy |
| UI | contrast, layout, CLS/LCP | Lighthouse | — (artifact) |
| API performance | p95/p99 latency, RPS | `k6` / `autocannon` | — (artifact) |
| API reliability | error rate under load | `k6` | — (artifact) |
| Security | SAST findings | Semgrep (OWASP ruleset) | dangerous-pattern regex |
| Security | secrets | `gitleaks` | high-signal regex scan |
| Security | dependency vulns | `npm audit --json` / OSV | — (artifact) |
| Security | authz negative tests | the task's held-out checks | — |

### 5.2 UI quality — beauty is judged, not vibes

Beauty and "not slop" are measured by a **blinded jury** on a pre-registered
rubric (`eval/rubric/`), because no linter measures taste.

Procedure:

1. Screenshots at the B.5 viewport matrix (375/768/1440), identical browser and
   device-pixel ratio, rendered from the arm's build.
2. Identities stripped; file order randomised per rater; arms unlabelled.
3. **≥3 raters**, at least two humans and at most one vision model, scoring each
   pre-registered criterion 1–5: visual hierarchy, spacing rhythm, type scale
   consistency, colour/contrast discipline, state completeness (empty/loading/
   error), affordance clarity, consistency across screens.
4. Inter-rater reliability must reach **Krippendorff's α ≥ 0.67**; below that the
   rubric is judged unreliable and the result is reported as inconclusive, not
   averaged away.
5. A binary **slop checklist** (gratuitous gradients, inconsistent radii,
   colour-only errors, placeholder lorem, mismatched icon sets, spinner-per-card)
   is scored separately and reported as counts.

### 5.3 Workflow / UX smoothness

- task completion (boolean) and time-to-first-green;
- **number of human interventions** and clarification rounds (the plugin's
  headless workers cannot unblock themselves; the baseline can drift);
- a consistency check: same action labelled the same way, same error format,
  same navigation pattern across the flow;
- a click-path test for any interactive deliverable.

### 5.4 Cost and speed

Tokens in/out, wall-clock, and cost from the deployment price table (DSH exposes
no currency metadata — cost is always an estimate and is labelled as such). These
are **non-inferiority** endpoints: the plugin must not be materially slower or
more expensive.

---

## 6. Analysis

All statistics live in `eval/lib/stats.mjs` and are unit-tested against closed-form
values.

- **Orientation.** Every metric is oriented so positive = treatment better
  (`eval/report.mjs` `METRIC_ORIENTATION`). `loc` and `api-surface` are
  informational and are never endpoints.
- **Effect estimate:** median paired improvement, with a **seeded bootstrap 95 %
  CI** (10,000 resamples) so the number is reproducible.
- **Test:** two-sided **Wilcoxon signed-rank**, **exact** when tie-free and
  n ≤ 20 (dynamic programming), otherwise the tie-corrected normal approximation
  with continuity correction. The method used is recorded per row.
- **Multiplicity:** the confirmatory family (12 primary endpoints) is corrected
  with **Holm–Bonferroni** at α = 0.05; per-endpoint thresholds are printed.
- **Effect size:** Cohen's dz for paired data, plus the required n to detect it.
- **Acceptance:** passed/total checks per arm, reported as rates.

---

## 7. Decision rule (pre-registered)

**Data-integrity precondition.** A run whose executor failed (non-zero exit, no
machine-readable stream) is recorded `status:"invalid"`; it contributes no metric
values, it aborts a live study at the first occurrence, and `report.mjs` refuses
to analyse a record set containing one unless `--allow-invalid` is passed. Even
then the invalid runs are disclosed and excluded from every endpoint. A run that
did not happen is not a null result, and an arm that never executed is not a
paired observation. The analysis is computed only when every record is valid.

The plugin's claim is **supported** only if all of the following hold:

1. **Primary win:** at least one of {duplication, complexity, module-cycles,
   secrets, dangerous-patterns, static-a11y, error-rate} favours B with a 95 % CI
   above zero **and** survives Holm; and
2. **No regression:** no primary endpoint has a 95 % CI below zero (a regression
   must be reported, not averaged away); and
3. **Acceptance non-inferiority:** B's acceptance rate is not worse than A's by
   more than the pre-registered margin (5 percentage points); and
4. **Cost/speed non-inferiority:** B's median wall-clock and token use are within
   the pre-registered margin (25 %) of A; and
5. **Placebo control:** B > C on the primary win, otherwise the effect is
   attributed to prompt text and the orchestration claim is withdrawn.

**Falsifiers.** The claim is refuted if the negative control shows a "win"
(harness is biased), if C ≥ B on the primary endpoint, or if any primary
regression appears with a CI excluding zero.

**Stopping rule.** No peeking. The confirmatory run is analysed once, at the
pre-registered n. Pilots are explicitly labelled and never merged into the
confirmatory data.

---

## 8. Threats to validity, and the control for each

| Threat | Control |
|---|---|
| Model identity drift (0.2.0-rc churn) | pin the snapshot; record it in every run record; re-run if it changes |
| Nondeterminism | n from power analysis, pairing, randomisation, seeded bootstrap |
| Prompt/tool-surface confound | arms C and D |
| Task leakage | held-out acceptance checks, never in the prompt |
| Evaluator bias | blinding, randomisation, ≥3 raters, α ≥ 0.67 |
| Proxy metrics mistaken for truth | `method` + `available` on every metric; authoritative toolchain required for public claims |
| Single-machine artefacts | record host/node/git/dsh versions; repeat on a second host before publishing |
| Simulator mistaken for evidence | `simulate` records are a placebo, marked in-band, and the report refuses them unless explicitly allowed |
| Cost-to-completion confound | non-inferiority margins on time and tokens |
| Publication bias | the full task suite is pre-registered; the negative control and any regressions are always reported |

---

## 9. Reproducibility

- Container image pinned by digest; tool versions pinned and recorded.
- Every run emits an append-only JSONL record with arm, executor, model, the
  **observed** provider/model, host/node/dsh/git identity, timestamps, tokens, and
  the full metric block including unavailability reasons.
- Token counts come from the headless NDJSON stream where DSH already
  de-duplicates retried attempts, and fall back to the persisted session log
  (`assistant/message` committed usage only — the streamed `chunk.usage` is the
  same attempt's usage and is never counted twice). A session log that decodes
  only partially is reported as `truncated` and its totals are treated as
  unreadable, never as zero.
- The bootstrap seed is recorded in the report (byte-reproducible from records).
- `eval/report.mjs` regenerates the markdown report from records alone; a reader
  can re-run the analysis without re-running the models. It prints per-endpoint
  coverage, so an endpoint that was never measured cannot be read as a null.

## 10. Cost governance

Live runs are opt-in (`--live`) and refuse to start without it. The harness
prints the arm, task, model and budget before spending. A pilot (1 repeat, 2
tasks) should precede any confirmatory run so the budget is known before it is
committed.

---

## 11. Reporting template

`eval/report.mjs` emits: the verdict block, a per-metric table (n, medians,
median improvement, 95 % CI, p, Holm threshold, significance, dz), acceptance
rates, and a standing "threats to validity" section. `--out` writes the markdown;
the JSON summary is available programmatically via `buildReport()`.
