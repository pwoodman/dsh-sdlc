# Universal SDLC Orchestrator — Spec Review & DeepSeek Harness Plugin Plan

> **Status update:** superseded by `universal_sdlc_orchestrator_dsh_spec_v2.md` (concrete spec). Its Part 5 open decisions are now resolved: (1) execution backbone = headless worker processes + one-shot in-process children (experimental agent-team rejected — shared working directory, single-process); (2) first milestone = M0–M3 (spike → plan → execute → verify); (3) dedicated `sdlc` profiles; (4) TypeScript in-plugin. The G1–G12 gap list below remains the reference index — each is closed in spec v2 Part B.

**Reviewed:** `universal_sdlc_orchestrator_full_spec_architecture.md` (v1.0, 2,631 lines)
**Target:** Build as an out-of-tree DeepSeek Harness (DSH) plugin suite
**DSH runtime observed:** `@deepseek-ai/dsh` 0.2.0-rc.2 (Cordis-based plugin/bundle architecture)

---

## Part 1 — Review of the spec

### 1.1 What is strong (keep these)

1. **The central rule (§36, §58) is exactly right.** "LLM proposes → runtime validates → runtime executes → runtime verifies → runtime updates state" is the single most important design decision in the document. It maps directly onto DSH's host-service/tool split: host-side Cordis services own authority, model-facing tools only submit proposals.
2. **Roles are configuration, not codebases (§52 Phase 2).** "prompt + capabilities + permissions + verification policy + routing policy" is a precise match for DSH agent presets (`@deepseek-ai/dsh-agent-preset` + `dsh-agent-preset-registry`). This is free in DSH.
3. **Conflict prevention trio (§19–21):** worktree isolation + file ownership (`allowed_paths`) + shared-resource locks. Preventing ownership collisions at schedule time rather than at merge time is the correct priority.
4. **Evidence-based acceptance (§42) + independent review (§43).** A worker cannot declare its own task done; completion requires evidence proportional to risk. This is what makes autonomy safe.
5. **Expected-cost routing (§39).** `expected_cost = model_cost + P(failure) × rework_cost` is the right objective; it avoids the classic "cheap model fails 3× and costs more" trap.
6. **Explicit non-goals (§2.2)** and the "don't rebuild an agent framework" stance (§6) — both will be tested by the plugin pivot below, but the instinct is right.
7. **Loop detection as a first-class runtime concern (§15)** with a hard stop-and-escalate action.

### 1.2 Gaps and problems to fix before/while building

| # | Section | Issue | Fix |
|---|---------|-------|-----|
| G1 | §10 Complexity engine | The formula mixes raw counts and booleans (`files * 0.10`, `security * 0.10`) and then says "normalize to 0–1" without defining per-feature normalization. As written it is not deterministic or reproducible. | Define each input explicitly: 0/1 flags for `security`, `ui`, `database_changes`, `deployment`; log-scaled normalized counts for `files`, `integrations`, `external_dependencies`; ordinal levels for `testing_complexity`. Publish the exact mapping so two runs give the same score. |
| G2 | §35 + §49 | Task/project states are listed, but there is **no transition table** and the SQLite schema is a list of table names with no columns. "The runtime controls state transitions" is unimplementable without an allowed-transitions map (who may move `VERIFYING → ACCEPTED`, what happens to dependents on `FAILED`, etc.). | Write the transition matrix and the minimal DDL before code. Decide surrogate keys, status enums, and where evidence blobs live (files, per §49 — good). |
| G3 | §22 Integration strategy | This is the **highest-risk area of the system and the thinnest section**: a pipeline diagram with no merge semantics. Unanswered: rebase or merge? who owns the integration branch? what happens when two *accepted* branches still conflict (glob ownership does not prevent two tasks legitimately touching one file in sequence)? how is a bad integration rolled back? | Add an explicit integration ADR: merge order policy (topological + verified), conflict path (reject → re-plan task), integration branch single-writer (the orchestrator only), and a revert procedure. |
| G4 | §19 + §40 | Worktrees are cheap to create but **expensive to make buildable**: per-worktree `node_modules`/venv installs, build artifacts, E2E ports, database fixtures. The spec mentions "browser capacity" but not port ranges, DB isolation, or dependency-install strategy. | Add an execution-environment policy: shared read-only dep cache (e.g. pnpm store / venv cache), per-worker port allocation, per-worker test data, and a cap on live worktrees. |
| G5 | §6 Adapter interface | `launch/status/collect_result/stop` has no result contract: what *is* a result (structured JSON? diff? transcript?), what are the timeouts, what happens when a worker dies mid-edit (half-applied diff in a worktree)? | Define a `WorkerResult` schema (summary, diff, evidence claims, tokens, duration, exit reason), a timeout policy, and an orphan-worktree salvage rule. |
| G6 | §12 Router | Eleven inputs are listed but **no scoring function**; §38/§39 supply history and cost but never combine them into a testable selection algorithm. No provider-down fallback. | Specify `select(task)` as deterministic rules first (§55 is nearly it), with historical overrides applied only above a minimum sample count. Add a fallback chain per tier. |
| G7 | §42 Evidence | "Completion requires sufficient evidence for the task risk" — but risk tiers and their required gates are undefined. | A small matrix: risk class × required verifications (e.g. trivial UI → lint + visual; auth change → unit + integration + security review + elevated review). |
| G8 | §27–28 Visual QA | AI visual review needs vision modality routed to the model and a defined trigger for "warranted" viewports; "alignment, spacing, hierarchy" judgments need a rubric or they are non-reproducible. | Define the change→viewport trigger rule (responsive-affecting paths ⇒ full matrix) and a fixed reviewer rubric with pass/fail/defect-list output. |
| G9 | §29–30 Security/Performance | "Risk-based" is right but risk classification is undefined. | Tie it to G7's risk classes; reuse `allowed_paths`/`forbidden_paths` hints (auth, crypto, migrations, network ⇒ elevated). |
| G10 | Global | No cost ceiling, no kill switch, no backpressure story beyond "current load", and **no crash-recovery procedure** for the orchestrator itself (an event log exists, but no "resume from where" rule). | Add: per-run budget (tokens/$/wall-clock) with hard stop; `sdlc resume` semantics defined as "reconcile DB state against git/worktree reality, then re-dispatch"; make the event log append-only and authoritative for recovery. |
| G11 | §58 Definition of Done | 27 independent capabilities is a roadmap, not an MVP. Attempting it linearly guarantees a never-finishing build. | Slice vertically (see Part 3). The DoD becomes the acceptance checklist of the *final* milestone, not of v0.1. |
| G12 | §34 Context management | "Relevant files / relevant decisions / relevant architecture" has no retrieval rule, so it degenerates into "dump everything" or ad-hoc guessing. | Deterministic context assembly: task contract + files matched by `allowed_paths` + decisions tagged with the touched subsystem + last failing test output. Cite what was included and why. |

### 1.3 Scope sanity

The spec is coherent as a *product* vision. Its internal sequencing (§52 Phases 1–9) is reasonable. The problem is only the word "MVP": treat §52 as the milestone ladder and §53's eight tests as the acceptance suite for the top milestone.

---

## Part 2 — The pivot: standalone Python CLI → DSH plugin suite

The spec (§5, §6, §47, §51) assumes a standalone Python control plane with its own CLI and agent adapters. Building inside DSH **inverts the dependency**: DSH already provides the harness, the agent runtime, the tool sandbox, the session/event store, and the UI. The plugin should implement only the SDLC control plane as host services + model-facing tools, and delegate everything else to existing DSH packages.

### 2.1 Concept mapping

| Spec concept | DSH equivalent | Notes |
|---|---|---|
| Python control plane (§5) | TypeScript Cordis plugin bundle(s) | Out-of-tree npm package(s) with `package.json.dsh.bundle.patch → cordis.patch.yml`, installed per profile via `dsh plugin --profile <name> …` (pnpm) |
| `sdlc` CLI (§47) | `@deepseek-ai/dsh-commands` slash commands + tools | `/sdlc run`, `/sdlc status`, … run against the agent without becoming model messages; `sdlc approve/reject` maps to `dsh-user-approval` / `dsh-client-ui-approval` |
| Role registry (§7) | `@deepseek-ai/dsh-agent-preset` rows | Each role = prompt sections + tools + skills + permissions + verification policy. Exactly the preset-registry contract ("failed definitions remain visible"; one process runs several compositions) |
| One Lead, many specialists (§3) | `@deepseek-ai/dsh-subagent` (spawn/fork children) — or `@deepseek-ai/dsh-experimental-agent-team` | Agent-team is literally Lead + named teammates + durable messaging + shared task board. **But:** experimental (no stability promise) and its task board has no DAG/ownership/locks. Recommendation in §2.2 |
| Workers (§6 adapters) | Subagent providers: in-process, ACP, SDK, Codex, Claude Code children | "OpenCode/Pi/DeepSeek/GenericCLI adapters" collapse into existing provider backends; the orchestrator stays backend-agnostic as §6 demands |
| Model tiers CHEAP/BASE/ELEVATED (§11) | Model entries per tier in profile config over `dsh-llm` providers (`dsh-llm-deepseek`, `dsh-llm-pi-ai`, …) | Router is our code; providers are DSH's. "Required modality: vision" (§12) must be a registry capability flag |
| Task DAG, ownership, locks (§16–21) | **New plugin service** (`ctx.sdlcTasks`) | Nothing in DSH does dependency DAG + glob ownership + resource locks. This is the core IP — build it as a host service with `dsh-storage` domain persistence (typed records; precedent for sqlite-backed domains exists) |
| Git worktrees (§19) | Plugin service shelling to git through `dsh-sandbox`/`dsh-bash-sandbox` | Enforce isolation by rooting each subagent child in its worktree; enforce `allowed_paths` post-hoc from `dsh-workspace-changes`-style diffs before any merge |
| Verification (§23–30) | Plugin verifier service + bash pipelines in sandbox; Playwright for E2E; screenshots + vision model for visual QA | "Cheapest checks first, fail fast" is straightforward orchestration over tool executions |
| Event log (§50) | Session events + `dsh-storage` domain | Session log already gives durable, replayable history (`dsh-session-persistence`, `dsh-session-query`) |
| Cost/tokens/duration (§38–39) | `dsh-token-meter`, `dsh-session-stats`, `dsh-session-telemetry` | Measurement exists; add per-task/per-model attribution tables |
| Project memory (§31–33) | Filesystem `.sdlc/` (constitution, ADRs) + storage domain for state | Keep artifacts as files per §49's own advice; DB only for metadata/state |
| User escalation (§45) | `dsh-tool-ask-user`, `dsh-user-approval`, `dsh-goal` (durable blocked state across restarts) | `dsh-goal` gives exactly the "one durable completion objective per session, survives restart, blocked with policy code" semantics |
| Loop detection (§15) | Plugin service over `worker_runs` attempt fingerprints | — |
| Web dashboard | Optional `dsh-client-ui-*` plugin | Task board / evidence / cost views; note client-plugin HMR needs `pnpm run dev:web` running from the DSH checkout |

### 2.2 Key architectural decision: what to reuse vs. build

**Build (this is the product):**
- `sdlc-tasks` — task contract model, dependency DAG, state machine w/ explicit transitions, glob ownership, shared-resource locks, scheduler ("maximum safe concurrency with zero known ownership collisions", §18)
- `sdlc-runtime` — worktree manager, worker dispatch to subagent backends, `WorkerResult` contract, loop detector, escalation ladder (CHEAP→BASE→ELEVATED→review→user), evidence engine, integration gate
- `sdlc-router` — tier routing per §55 + expected-cost math + history
- `sdlc-verify` — verification pipelines, risk→gate matrix (G7), visual QA rubric
- Role presets — declarative YAML for the 25 roles (thin; mostly prompts)

**Reuse (do not rebuild):**
- Agent runtime, tools, sandbox/approvals, session persistence/events, token metering, subagent backends, skills, UI shell

**Deliberately avoid:**
- Building on `dsh-experimental-agent-team`'s task board as the scheduler — it is message/board plumbing without DAG semantics and carries no stability promise. Consider it later for *worker-to-worker messaging*, not for task authority. (If wanted, the Lead/teammate model can be layered on once the task engine exists.)
- Model-written workflow scripts (`dsh-workflow`) as the *authoritative* scheduler — fine as an orchestration escape hatch, but §36 requires runtime-owned state; the scheduler must be host code whose transitions tools can only propose.

### 2.3 Plugin shape

```text
dsh-plugin-sdlc/                  (one repo, small suite)
├── packages/
│   ├── sdlc-core/                host services: tasks, router, runtime, verify, evidence
│   │   ├── package.json          dsh.bundle.patch → cordis.patch.yml
│   │   ├── cordis.patch.yml      service + tool + preset rows
│   │   └── src/
│   ├── sdlc-tools/               model-facing tools (propose-only) + /sdlc commands
│   ├── sdlc-presets/             25 role presets (prompt+tools+policy YAML)
│   └── sdlc-client-ui/           optional dashboard card(s)
└── docs/
```

- Install: `dsh plugin --profile sdlc add ./packages/sdlc-core …` into a dedicated profile (e.g. `--from-default-profile`).
- Compatibility: declare `engines.dsh` against `0.2.0-rc.x`; RC churn means pin exact versions and expect to bump (plugin-manager's version-exemption flow exists for this).
- Safety: presets are **not** sandboxes (their own docs say so) — repository safety (§46: allowed/forbidden commands, protected branches, destructive-op approval) must live in the host services + `dsh-sandbox` policy, never in prompts.

---

## Part 3 — Build plan (vertical slices)

Each slice ends runnable and testable; §52's phases map onto them.

**Slice 0 — Spike (1–2 days)**
Profile boots with the plugin mounted: one service, one tool, one preset, one `/sdlc` command. Validates manifest/patch/version plumbing before any real logic.

**Slice 1 — Task engine + planning (spec Phase 1–2)**
Discovery (lightweight), complexity scoring with the fixed formula (G1), task contracts (§16), DAG + state machine with explicit transitions (G2), events, storage domain. `/sdlc run "…"` produces a persisted plan with a rendered DAG. *Acceptance: plan is reproducible and inspectable.*

**Slice 2 — Execution seam (Phases 3–4)**
Worktree manager, subagent dispatch per task, `WorkerResult` contract, ownership + resource-lock enforcement, diff-based `allowed_paths` enforcement, orphan handling. *Acceptance: two independent tasks run in parallel worktrees and land without conflicts (spec Test 6).*

**Slice 3 — Verification + evidence + review (Phase 6)**
Cheapest-first gate pipeline (§23), risk→gate matrix (G7), evidence records (§42), independent-reviewer preset, accept/reject loop with evidence feedback. *Acceptance: spec Test 7 (worker says DONE, visual/evidence gate rejects, worker fixes).*

**Slice 4 — Elevation + recovery (Phase 8)**
Loop fingerprints (§15), escalation ladder with failure-evidence packets (§14), recovery/replan path, user-escalation gates (§45), budgets/kill switch (G10). *Acceptance: spec Test 5.*

**Slice 5 — Router + cost (Phase 9, partial)**
Tier routing (§55), expected-cost selection (§39), history tables (§38), per-task cost reporting (G6). *Acceptance: trivial UI task rides CHEAP; failed task escalates.*

**Slice 6 — E2E + visual QA (Phase 7)**
Playwright pipelines, viewport matrix triggers (G8), vision-model reviewer with fixed rubric, screenshots as evidence artifacts.

**Slice 7 — Integration + hardening (G3)**
Integration-branch single-writer merge pipeline, conflict→re-plan path, crash recovery/resume (G10), full §53 acceptance suite as the release gate, optional client-UI dashboard.

---

## Part 4 — Risks

1. **RC churn:** DSH is `0.2.0-rc.2`; plugin peer-version ranges and experimental packages will move under us. Mitigation: pin exact, isolate DSH API touchpoints behind thin adapters in `sdlc-core`.
2. **Experimental agent-team temptation:** it looks like the spec's org chart, but its task board is not a DAG engine and its API is explicitly unstable. Use subagent providers as the execution seam; revisit later.
3. **Worktree economics:** parallel worktrees with full dependency installs can dominate wall-clock and disk. Mitigation: shared dep caches, worktree cap, reuse windows.
4. **Parallel E2E resource contention:** ports, browsers, DB fixtures need allocation policy (G4) or Slice 6 will flake.
5. **Over-scoped MVP:** the §58 checklist is 27 capabilities. The slices above deliberately defer multi-model collaborative mode (§13) and performance engineering (§30) past the first usable milestone.
6. **Visual QA determinism:** "does it look right" without a rubric is unaccountable; keep the rubric fixed and store screenshots as evidence.

---

## Part 5 — Open decisions (need your call)

1. **Execution backbone:** subagent children (recommended — stable, provider-agnostic) vs. experimental agent-team (nice messaging model, unstable) vs. hybrid later.
2. **First milestone scope:** Slices 0–3 (plan → parallel execute → evidence-gated accept) is the smallest end-to-end loop that proves the spec's core rule. Confirm or trim.
3. **Profile strategy:** dedicated `sdlc` profile (recommended) vs. mounting into your existing `web` profile.
4. **Language of the control plane:** TypeScript in-plugin (recommended — everything above assumes it) vs. Python sidecar (keeps §5 but fights the platform; not recommended).
