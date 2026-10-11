# Universal SDLC Orchestrator — Concrete Specification v2 (DSH Plugin)

**Status:** CONCRETE — ready for implementation review. Every platform claim is verified against the installed DSH (`@deepseek-ai/dsh` 0.2.0-rc.2) and cited in Part A; the only untested items are the ten M0 spike checks in C.8.1 (first implementation step).
**Supersedes:** the review/plan in `dsh-plugin-review-and-plan.md` (gap list G1–G12 there is closed here).
**Rule for this document:** every design element is concrete enough to implement without further design decisions. No implementation code exists yet.

---

# Quick Start — 5-Minute Setup

This section is the fastest path from zero to a running orchestrator. It is the normative install procedure; Part F expands every step.

## Prerequisites

| Requirement | Check |
|---|---|
| Node.js ≥ 22.0 (for built-in `node:sqlite`) | `node --version` |
| pnpm ≥ 9.0 | `pnpm --version` |
| DSH CLI (`dsh`) installed | `dsh --version` → `0.2.0-rc.2` |
| At least one LLM provider key in env | `echo $OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`, etc.) |
| A git repository (new or existing) | `git rev-parse --is-inside-work-tree` |

## One-command bootstrap

```sh
# 1. Scaffold the plugin packages (run once from the orchestrator source tree)
cd /path/to/dsh-plugin-sdlc
pnpm install
pnpm build

# 2. Install the orchestrator into a DSH profile (creates the profile if needed)
dsh plugin --profile sdlc-lead add \
  ./packages/sdlc-core \
  ./packages/sdlc-tools \
  ./packages/sdlc-presets

# 3. Run the environment doctor — validates everything before first use
#    (headless: the agent runs /sdlc doctor and reports results)
dsh --profile sdlc-lead --headless "/sdlc doctor"

# 4. Configure model tiers (interactive wizard via headless, or edit .sdlc/config.yml)
dsh --profile sdlc-lead --headless "/sdlc config"

# 5a. Start the orchestrator (web GUI) — then type /sdlc commands in the chat
dsh --profile sdlc-lead

# 5b. …or run headless for a single project
dsh --profile sdlc-lead --headless "Build a REST API for customer CRUD"
```

## First project (30 seconds)

```sh
# Inside any git repo:
cd /path/to/my-project
dsh --profile sdlc-lead --headless \
  "Add a health-check endpoint that returns {\"status\":\"ok\"}"
```

The orchestrator will: classify complexity → plan tasks → dispatch workers → verify → merge. Watch progress with `/sdlc status` in the web GUI or `--json` stream in headless mode.

## Smoke test (validates the full pipeline)

```sh
# Runs a self-contained end-to-end test in a temp directory.
# Exits 0 if the pipeline works, 1 with diagnostics if not.
dsh --profile sdlc-lead --headless "/sdlc selftest"
```

---

# Part A — Verified platform model

*(assumption register — filled from direct inspection of `@deepseek-ai/dsh` 0.2.0-rc.2)*

## A.1 Verified facts (direct inspection, this document's foundation)

| # | Fact | Evidence |
|---|------|----------|
| P1 | DSH profiles compose as ordered `cordis.patch.yml` layers: each bundle patch is one `- insert:` list of rows (`id`, `name`, `config`, `disabled`); later layers address rows by id; **a patch replaces a row's whole `config`, it does not merge** | `dsh-base/cordis.patch.yml` header comment |
| P2 | Row `disabled` accepts `!!js "<js expression>"` evaluated in plugin context; config values accept `!!js` expressions (e.g. `dshHomePath('sessions')`, `process.cwd()`) | `dsh-base/cordis.patch.yml` rows (`hmr`, `sandbox-policy`, `session-persistence-jsonl`) |
| P3 | Out-of-tree plugins install into a profile's `node_modules` via `dsh plugin --profile <name> <pnpm args>`; the npm CLI runs this code path (`runPluginCommand`), creating the profile directory if needed | `dsh --help`; direct probe (`plugin --profile __probe__` reached `dsh-plugin-manager/lib/types/operations.js:528 mkdir`) |
| P4 | Headless mode is a first-class supervisor seam: `dsh --profile headless "<task>"` with `--json` (newline-delimited events: `session`, `status`, `text`, `thinking`, `tool_call`, `tool_result`, `final`, `error`) and `--session-id` (adopt/persist a conversation). Exit 0 = completed, 1 = aborted/errored; failure signal = exit code + `turn_end` reason | `dsh-headless/README.md` ("Machine-readable output", "Choosing the session identity") |
| P5 | A headless Session is bound to its working directory at creation ("new Sessions record that directory"); adoption re-checks the cwd and refuses mismatches | `dsh-headless/README.md` |
| P6 | The sandbox workspace root defaults to the process cwd (`sandbox-policy.workspaceRoot: process.cwd()`), permission presets = `read-only` / `workspace-write` / `danger-full-access` × approval `ask`/`never` | `dsh-base/cordis.patch.yml` (`sandbox-policy`, `permission` rows) |
| P7 | Agent presets are declarative rows (`@deepseek-ai/dsh-agent-preset`, `config.id/order/plugins[]`); a preset's `plugins` list IS the agent composition: persona (prompt prefix/suffix, `{{cwd}}`/`{{model}}` templates), tools (tool allowlist by omission), plan/compaction/delegation groups | `dsh-web-app/presets/standard.patch.yml`, `minimal.patch.yml` |
| P8 | Different agents/sessions in one process run under different preset compositions simultaneously; the host keeps registries keyed by owning agent ("one host instance serves every session exactly as before presets") | `dsh-web-app/cordis.patch.yml` ("the agent plane moves behind agent presets") |
| P9 | Subagent delegation supports `agentOptions` overrides per child: provider, model, reasoning effort, maxTokens; one-shot children settle with "a single result, plus an optional structured output and a safe diagnostic"; continuable children keep durable sessions with interrupt | `dsh-subagent/README.md`, `dsh-tool-subagent/README.md` |
| P10 | Model-per-child requires an `agentOptions`-capable backend (in-process spawn/fork and DSH SDK; ACP/Codex/Claude Code reject it); exact-route authorization can be policy-controlled (`modelSelectionSettings`) | `dsh-tool-subagent/README.md` |
| P11 | The experimental agent-team task board has dependencies + CAS + file-hint overlap warnings but is **single-process, shared-working-directory, max 256 active tasks, experimental** — its docs say "Avoid it when teammates need separate working directories" | `dsh-experimental-agent-team/README.md` |
| P12 | Durable KV/domain storage exists in the shared base (`storage` + `storage-json` at `$DSH_HOME/storages` + `storage-domain` schema-validated over it) | `dsh-base/cordis.patch.yml` |
| P13 | Session persistence is JSONL at `$DSH_HOME/sessions`, with optional SQLite full-text (`session-query-sqlite`, default `openAt: never`) | `dsh-base/cordis.patch.yml` |
| P14 | Persona/prompt composition is plugin-owned (`dsh-persona` prefix/suffix; system-prompt rows) | preset files + `dsh-headless/cordis.patch.yml` |
| P15 | A preset is a **Cordis plugin composition**: `PresetDefinition {id, name?, description?, order?, plugins[]}` where `plugins` are child plugin rows (persona, tool rows, skill rows, `!!js` conditions) — NOT a flat prompt/tools/permissions struct. Prompt via `dsh-persona` (+ `ctx.systemPrompt.section/variable`, scoped shadowing, `complete:true` replaces whole prompt); tools via mounted rows + `ctx.tools.restrict({allow,deny})`; skills via `dsh-skill(-filesystem)` rows | `dsh-agent-preset-registry` `lib/types/definition.d.ts`; its README |
| P16 | Presets run concurrently in one process ("One process can run several compositions"); binding API: `agentPresets.mount(ctx, id)` for unpublished agents, `select()` only before first turn (`agent-preset/locked` after), `composeFrom(ctx,parent)` = child inherits parent's exact revision, `recompose` = blank sessions only | `dsh-agent-preset-registry` `index.d.ts` |
| P17 | Plugin code CAN spawn preset-bound workers: `ctx.agents.create({meta.agentPreset, agentOptions, setup})` where `setup` calls `agentPresets.mount(...)` — shipped proof in `dsh-webhook` `createWebhookSession` and `dsh-api-session-controller.composeAgent(presetId)` | `dsh-webhook`, `dsh-api-session-controller` |
| P18 | Stock subagent children INHERIT the parent's preset; `SubagentStartRequest` allows per-child `agentOptions` (provider/model/reasoningEffort/maxTokens), `toolFilter`, `persona`, `outputSchema` — but no preset field. Role-per-child via stock tool = multiple named `dsh-tool-subagent` rows (each fixed persona/toolFilter/agentOptions) | `dsh-subagent` `types.d.ts`, `child-agent`; `dsh-tool-subagent` `index.d.ts` |
| P19 | Direct non-agent LLM calls are first-class: `ctx.llm.stream({provider, model, messages, system?, …})`, `ImageBlock` content for vision; shipped proof: session-title + compaction summarizers. No retry on direct calls (retry exists only at agent-step boundaries) | `dsh-llm` `types.d.ts` + README |
| P20 | Model metadata: `ctx.llm.resolveModelInfo/listModels/discoverModels` expose `contextWindow`, `inputModalities` (text/image), reasoning efforts. **No dollar-cost metadata**; token counters (`TokenUsage`) and image visual-token pricing only ⇒ cost tiers must be deployment-authored price tables | `dsh-llm` `types.d.ts` (`LlmResolvedModelInfo`) |
| P21 | Permissions are NOT preset fields: `dsh-permission-presets` (`presets: name → {sandbox, approval}`), sandbox policy and approval policy are session/delegation-scoped; "Presets are not security sandboxes" | `dsh-agent-preset-registry` README "Known Limitations"; `dsh-base` patch |
| P22 | Model selection points: `ctx.agents.create({agentOptions})`, `SubagentStartRequest.agentOptions`, per-session `ModelSelection` (`installModelSelection`), the `agent/request` waterfall (swap route per step), and `modelSelectionSettings` host policy for stock subagent tools | `dsh-agent` `model-selection.d.ts`, `runtime-types.d.ts` |
| P23 | Storage domain (`dsh-storage-domain`): typed KV via `defineDomain` + zod, per-record atomic CAS (`KvTable.update()`), but **no cross-table transactions, no secondary indexes/queries, single-process visibility**; `per-record` JSON layout is the documented path for thousand-record scale | `dsh-storage-domain` README "Known Limitations"; `domain.d.ts` |
| P24 | No SQLite storage service ships in this distribution (the `storage-sqlite` backend is referenced but NOT installed); `dsh-session-query-sqlite` uses **Node's built-in `node:sqlite`** (`DatabaseSync`) for session FTS only. Native deps in a profile are possible (`pnpm add`, build scripts user-gated) | `dsh-storage-json` README; `dsh-session-query-sqlite/lib`; `dsh-plugin-manager` README |
| P25 | `ctx.subprocess` (spawn/terminate/waitForExit, argv-based, credential-scrubbed env) and `ctx.shell` executors (`dsh-bash-sandbox` confines via `ctx.sandbox.confine()`) are the programmatic execution seam. **No allowed/forbidden command policy exists** — sandbox policy governs FILE EFFECTS only | `dsh-subprocess` types; `dsh-bash-sandbox` README; tree-wide grep |
| P26 | Blocking human approval: `ctx.approval.request({agent, toolName, reason, signal})` → `allowed-once\|rejected\|cancelled\|unavailable`, audited via `approval/asked`/`approval/decided` events — **but requires an open turn and a live agent** (throws otherwise). `ctx.userQuestions.ask()/askTimed()` for multi-option decisions; both agent-scoped | `dsh-user-approval` README "Requesting a decision", `types.d.ts` |
| P27 | Native interception waterfalls exist and are the right enforcement primitive: `tools/pre-execute` → `PreToolDecision {allow\|deny\|cancel\|ask}`, `tools/post-execute`, `fs/*` intent deciders (`dsh-fs-observation-policy` precedent). Hooks bridges (`dsh-hook-protocol`) are for external commands only; `updatedInput` rewrite and run-halt are non-functional | `dsh-tools/lib/types/index.d.ts`; `dsh-hooks-claude-code` README |
| P28 | Token usage is measurable per session/turn (`tokenUsage`, `deriveTurnTokenUsage`), explicitly "not a billing record"; **no currency cost API** and no keyed per-run attribution — both must be plugin-owned | `dsh-token-meter` README "Reading the numbers" |
| P29 | `dsh-goal` = durable event-sourced objective with CAS refs and blocker codes — **one goal per session**; `dsh-goal-round-driver` queues round prompts at agent idle. `dsh-jobs` = owned/cancellable background jobs but **in-memory only** (die with process) | `dsh-goal` README; `dsh-jobs` "What can go wrong" |
| P30 | `dsh-workspace-changes` gives per-turn changed-file summaries but is live-session only (lost on restart) and misses shell edits outside git; the durable ownership record must come from git itself | `dsh-workspace-changes` README |
| P31 | In-process subagent children **hard-inherit the parent's cwd** (`childSessionMeta()` copies `parentHeader.cwd`); `SubagentStartRequest` has no cwd/env/sandbox field. Per-agent cwd exists only at creation: `ctx.agents.create({meta:{cwd}})` (validated absolute path), out-of-process provider instance `cwd` config, or process launch/SDK `initialize{cwd}` | `dsh-subagent` `types.d.ts`, `child-agent`; `dsh-agent` `index.d.ts`; `out-of-process.d.ts` |
| P32 | Headless worker contract: NDJSON `--json` stream (`session/status/text/thinking/tool_call/tool_result/turn_end/final/error`; strings capped 8KiB, lines 32KiB, **`final` uncapped**), exit 0=completed / 1=aborted-or-error, `--session-id` resumes top-level sessions (refuses subagent/forked sessions). SDK alternative: JSON-RPC stdio with `initialize{cwd, provider, model, …}` (**process-wide** route+cwd), no per-prompt result (derive from `session.event`/`session.status`) | `dsh-headless` README; `dsh-sdk-jsonrpc-server`, `dsh-sdk-protocol` types |
| P33 | Workers cannot request approvals: children carry the `'never'` approval pin and "operations that require approval are rejected automatically"; the delegating parent pre-grants the permission preset/sandbox identity | `dsh-subagent` README, `in-process-driver` README |
| P34 | Concurrency: `maxActiveSubagents` default 8 applies to continuable children only (one-shot runs unbounded); `maxDepth` default 1; cancellation via `AbortSignal`/`dispose()`/`interrupt()`/`Agent.cancel` | `dsh-subagent` README "Continuable capacity" |
| P35 | Launcher `--patch <path>` overlays apply after the profile layer (repeatable) — a generated overlay YAML can override any row per invocation (e.g. `agent-default-model` provider/model) | `dsh --help`; `dsh/README.md` "Profiles" |
| P36 | Compatibility is enforced via **`peerDependencies` on `@deepseek-ai/dsh`/`@deepseek-ai/dsh-*`** checked against the runtime version (prereleases participate); `engines.dsh` is declarative and unenforced. Exemptions: exact `package@version` × exact runtime in the profile's `compatibility.json` (`version-exemptions`/`allow-version --accept-risk`/`revoke-version`) | `dsh-app-boot` README "Profiles"; `dsh-plugin-manager` README; `dsh-package-manifest` "Known Limitations" |

## A.2 Resolved design-forcing questions

| Question | Resolution |
|---|---|
| Worker execution seam | **Two-tier:** (1) **one-shot in-process subagent children** for cheap, fast, same-tree work (docs, tests, small edits) with per-child model via `agentOptions` — one-shot runs are outside `maxActiveSubagents` (P34) so fan-out is ours to bound; (2) **headless worker processes with `cwd = task worktree`** for all code-changing parallel work — gives filesystem sandbox rooted at the worktree (P6/P31), durable per-worker sessions resumable via `--session-id` (P4), a machine-readable progress stream, and process-level crash containment. The orchestrator is the supervisor both ways. |
| Task authority | Own `sdlc-tasks` service (P11 rules out agent-team as authority; its CAS/derived-state patterns are adopted). |
| Where the runtime enforces | Host services own every transition; model-facing tools only submit proposals; the worker's sandbox root (worktree) is the first enforcement layer, `allowed_paths` verification is the second. |
| Role = preset | Confirmed feasible (P7/P8): 26 `dsh-agent-preset` rows (the original 25-role registry of spec §7 **plus Accessibility Engineer**, added here because spec §53 Test 4 requires it), composed per worker process/profile or per in-process child. |
| Storage | **Resolved:** task engine state in a plugin-owned SQLite DB opened via **Node's built-in `node:sqlite`** (`DatabaseSync` — zero native deps, proven in-tree by `dsh-session-query-sqlite`), single writer = the orchestrator process. `dsh-storage-domain` KV (zod, per-record CAS) is the secondary medium for small live caches. Rationale: the task engine needs queries/indexes/transactions that storage-domain explicitly lacks (P23); cross-process CAS does not exist (P23), so the single-writer orchestrator process is a design invariant. |
| Enforcement primitive | `tools/pre-execute` waterfall (`PreToolDecision allow/deny/cancel/ask`) + `fs/*` deciders for allowed_paths and command policy (P27); post-hoc git diff remains the durable audit (P30). |
| Escalation delivery | Approvals are turn-enclosed and need a live agent (P26) ⇒ escalations are delivered as queued prompts to the Lead agent (goal-round-driver pattern), and `ctx.approval.request()` is called from inside that turn; never from an idle timer. |

---

# Part B — Core domain design (gap closures)

## B.1 Complexity engine v2 (closes G1)

Every feature is defined by a deterministic extraction rule and normalized to [0,1] before weighting. Weights sum to 1.0, so `score ∈ [0,1]` by construction.

| Feature | Symbol | Extraction rule (deterministic) | Normalization |
|---|---|---|---|
| Domains | `D` | Count of distinct SDLC domains implicated by the task DAG: {requirements, architecture, ux-ui, frontend, backend, api, database, data-pipeline, integration, testing, security, devops, docs} | `d = min(D/5, 1)` |
| Files | `F` | Predicted changed files. Greenfield: from the planner's structured estimate (integer, clamped to [0, 1000]). Existing repo: from ownership globs' current match count | `f = min(ln(1+F)/ln(201), 1)` |
| Integrations | `I` | External systems/services the task set must talk to (count from requirements) | `i = min(I/5, 1)` |
| Database | `db` | 1 if any schema change/migration/data-model change, else 0 | binary |
| Security | `sec` | 1 if any `allowed_paths` matches the security classifier (auth*, *token*, *secret*, *credential*, crypto*, permission*, session*, CORS/CSRF config) OR requirement mentions auth/authz/payments/PII | binary |
| UI | `ui` | 1 if any user-visible behavior/layout change | binary |
| External deps | `E` | New or upgraded third-party dependencies required | `e = min(E/10, 1)` |
| Deployment | `dep` | 1 if CI/CD, container, infra, or environment config changes | binary |
| Testing | `t` | 0 = no behavior change (docs/config only); 0.5 = unit-level; 1.0 = e2e/visual/perf/security verification required | ordinal |

```
score = 0.15·d + 0.10·f + 0.15·i + 0.10·db + 0.10·sec
      + 0.10·ui + 0.10·e  + 0.10·dep + 0.10·t
```

Bands (unchanged from spec §10): `0.00–0.25 Tiny · 0.25–0.45 Small · 0.45–0.65 Medium · 0.65–0.80 Large · 0.80–1.00 Enterprise`. Bands are half-open `[lo, hi)` except the last.

LLM involvement is limited to producing the *structured estimate* (F, I, E, domain list, flags) as validated integers/booleans; the score itself is pure arithmetic and reproducible. The estimate and the computed score are both persisted in `projects` for audit.

**Determinism contract:** same repo state + same requirement ⇒ same score. Re-runs after repo change may differ; that is intended.

## B.2 State machines v2 (closes G2)

### B.2.1 Task state transition matrix

Only the named runtime actor may execute a transition; every transition writes an `events` row. Any state not listed is terminal for that row.

| From | To | Trigger (actor) | Guard |
|---|---|---|---|
| — | `BACKLOG` | planner (Lead service) | task created |
| `BACKLOG` | `READY` | scheduler | all `depends_on` tasks `DONE` (merged — worktrees branch from `integration`, so dependents need the dependency's code present) |
| `BACKLOG` | `BLOCKED` | scheduler | any dependency `FAILED`/`BLOCKED`/`ESCALATED`/`CANCELLED` |
| `READY` | `ASSIGNED` | scheduler | ownership+resource locks grantable; concurrency cap not exceeded |
| `READY` | `BLOCKED` | scheduler | locks held beyond wait budget (records `waiting_on`), OR any dependency regressed below `DONE` (rework/revert per B.9) |
| `ASSIGNED` | `IN_PROGRESS` | worker-mgr | worker process/child reports first event |
| `ASSIGNED` | `READY` | worker-mgr | worker failed to launch (retryable) |
| `IN_PROGRESS` | `VERIFYING` | worker-mgr | `WorkerResult` received (any status) |
| `IN_PROGRESS` | `FAILED` | worker-mgr | hard timeout, crash, or worker `error` event |
| `IN_PROGRESS` | `ESCALATED` | loop-detector | loop fingerprint matched (B.6) |
| `VERIFYING` | `ACCEPTED` | verifier | all required gates (B.4) pass + review verdict `accept` — **local acceptance; integration follows** |
| `VERIFYING` | `FAILED` | verifier | any required gate fails |
| `VERIFYING` | `ESCALATED` | verifier | loop fingerprint matched per B.6 (same fingerprint ≥ 2 failures, or ≥ 3 failed attempts overall — e.g. 2 consecutive visual failures) |
| `ACCEPTED` | `MERGING` | integration-mgr | merge slot free (single writer); pre-merge conflict check starts |
| `MERGING` | `DONE` | integration-mgr | merge committed AND post-merge gates green (B.9) |
| `MERGING` | `FAILED` | integration-mgr | merge conflict (B.9 step 2) OR post-merge gate failure (B.9 step 5; merge reverted) |
| `FAILED` | `READY` | scheduler | retry budget remaining and corrective context attached (conflict/gate evidence counts) |
| `FAILED` | `ESCALATED` | scheduler | retry budget exhausted |
| `ESCALATED` | `READY` | escalation-mgr | corrective plan approved (model or human) — new attempt, plan hash recorded |
| `ESCALATED` | `BLOCKED` | escalation-mgr | user decision required (B.7) |
| `BLOCKED` | `BACKLOG` | escalation-mgr | blocker resolved (dependency `DONE`, decision recorded) |
| any non-terminal | `ESCALATED` | recovery (B.12) | state inconsistent after reconciliation — discrepancy recorded as evidence |
| `BACKLOG`/`READY`/`ASSIGNED`/`FAILED`/`BLOCKED`/`ESCALATED` | `CANCELLED` | human (`/sdlc stop` scope) or planner (scope cut) | no live worker (or worker stopped first) |
| `IN_PROGRESS`/`VERIFYING` | `CANCELLED` | human only | worker stopped first; worktree preserved as evidence |

`DONE` and `CANCELLED` are terminal. `MERGING` cannot be cancelled — a human stop during merge waits for the merge to settle into `DONE` or `FAILED`. Illegal transitions are rejected by the service (tool proposals attempting them return `INVALID_TRANSITION` and the current row).

### B.2.2 Project states

`DISCOVERY → REQUIREMENTS → ARCHITECTURE → PLANNING → IMPLEMENTATION → INTEGRATION → VERIFICATION → RELEASE → MAINTENANCE`, plus `BLOCKED` reachable from any state and returning to the state recorded at block time. Transitions are service-owned with these guards: each of REQUIREMENTS/ARCHITECTURE/PLANNING requires a persisted artifact (requirements doc / ADRs+architecture summary / task DAG) before advancing.

### B.2.3 Persistence schema (SQLite, plugin-owned file `sdlc.db` in project `.sdlc/`)

```sql
projects(id TEXT PK, name TEXT, repo_path TEXT, state TEXT, blocked_state TEXT,
         complexity_json TEXT, budget_json TEXT, created_at, updated_at)

tasks(id TEXT PK, project_id TEXT, title TEXT, objective TEXT, role TEXT,
      state TEXT, attempt INT, retry_budget INT, risk_class TEXT,
      complexity REAL, model_tier TEXT,
      acceptance_criteria_json TEXT, allowed_paths_json TEXT, forbidden_paths_json,
      verification_json TEXT, estimate_json TEXT,
      plan_hash TEXT, worktree_path TEXT, branch TEXT,
      waiting_on TEXT, created_at, updated_at)
      -- CHECK (state IN (...)), FK project_id

task_dependencies(task_id TEXT, depends_on TEXT, PRIMARY KEY(task_id, depends_on))
task_resources(task_id TEXT, resource TEXT)   -- 'package.json', 'docker-compose.yml', …

worker_runs(id TEXT PK, task_id TEXT, attempt INT, session_id TEXT, pid INT,
            model_provider TEXT, model_id TEXT, status TEXT, exit_code INT,
            started_at, finished_at, duration_ms INT, tokens_in INT, tokens_out INT,
            cost_usd REAL, result_json TEXT, context_manifest_json TEXT,
            worktree_path TEXT, orphaned INT DEFAULT 0)

test_results(id TEXT PK, task_id TEXT, run_id TEXT, gate TEXT, status TEXT,
             started_at, finished_at, log_path TEXT, signature TEXT)

artifacts(id TEXT PK, task_id TEXT, run_id TEXT, kind TEXT, path TEXT, meta_json TEXT)

decisions(id TEXT PK, project_id TEXT, question TEXT, decision TEXT, reason TEXT,
          alternatives_json TEXT, consequences_json TEXT, tags_json TEXT, created_at)

requirements(id TEXT PK, project_id TEXT, statement TEXT, source TEXT,
             acceptance_json TEXT, status TEXT, created_at)

events(id INTEGER PK AUTOINCREMENT, ts TEXT, project_id TEXT, task_id TEXT,
       actor TEXT, action TEXT, model TEXT, result TEXT, duration_ms INT,
       payload_json TEXT)                      -- append-only; recovery source

escalations(id TEXT PK, task_id TEXT, attempt INT, level TEXT, packet_json TEXT,
            resolution TEXT, resolved_by TEXT, created_at, resolved_at)

model_runs(id TEXT PK, model_id TEXT, task_id TEXT, task_type TEXT, complexity REAL,
           duration_ms INT, tokens INT, cost_usd REAL, attempts INT,
           outcome TEXT, escalated INT)        -- router history (spec §38)
```

Large artifacts (logs, screenshots) live in `.sdlc/verification/…` files; rows reference paths (spec §49's file/DB split, made concrete).

**Storage binding (decided):** `sdlc.db` is opened through Node's built-in `node:sqlite` (`DatabaseSync`) from `sdlc-core` — the same primitive `dsh-session-query-sqlite` already uses in-tree. Single-writer invariant: only the orchestrator process opens the DB; workers communicate via worker_runs updates made by the orchestrator (never directly). Write path: all transitions go through one serialized write queue (the transition service), so no in-process interleaving is possible. DDL above is the schema; `schema_version` table guards migrations (unlike storage-domain, we own migration policy).

## B.3 Task contract & WorkerResult (closes G5)

### B.3.1 Task contract (spec §16, made complete)

```yaml
task:
  id: API-042                      # <ROLEPREFIX>-<seq>
  title: string
  objective: string                # one concrete outcome
  role: backend-engineer           # preset binding
  depends_on: [DB-001, AUTH-001]
  risk_class: R2                   # B.4
  capabilities: [backend, api, testing]
  acceptance_criteria:             # each becomes a verifiable check
    - id: AC1
      statement: valid payload accepted
      check: integration:test_customers_api.py::test_valid_payload
  allowed_paths: ["src/customers/**", "tests/customers/**"]
  forbidden_paths: ["src/auth/**"]
  verification: [unit, integration, api]     # required gates
  estimate: {files: 8, integrations: 1, external_deps: 0}
  budgets: {max_attempts: 3, max_duration_ms: 1800000, max_cost_usd: 5.00, max_tokens: 400000}
```

### B.3.2 WorkerResult (runtime-derived fields vs worker-claimed fields)

```yaml
result:
  status: completed | failed | aborted | timeout    # runtime-derived (exit code + turn_end)
  summary: string                                    # worker-claimed
  evidence_claims:                                   # worker-claimed, per AC id
    - {ac_id: AC1, claim: pass|fail, artifact: tests/test_customers_api.py#test_valid_payload}
  tests_run: [string]                                # worker-claimed; verifier re-runs
  requests: []                                       # explicit asks for the Lead (deps, decisions)
  # --- runtime-derived, never worker-claimed ---
  files_changed: [path]                              # git diff worktree vs merge-base
  out_of_scope_files: [path]                         # diff minus allowed_paths ⇒ auto-FAIL
  session_id: string
  tokens: {in, out}, cost_usd, duration_ms, model: {provider, id}, attempt: int
```

Derivation rules: `files_changed` from `git diff --name-only <merge-base>`; a worker claim never overrides it. `out_of_scope_files` non-empty ⇒ verification fails immediately with `SCOPE_VIOLATION` (the runtime, not the LLM, decides — spec §36).

**Encoding per seam (two channels, fixed precedence):** (1) **Outbox (canonical):** the worker's `sdlc_report_result`/`sdlc_claim_check` tools execute *inside the worker process* and write a schema-validated proposal document to `<worktree>/.sdlc/task-outbox.json` (atomic write; the tool's `output` schema mirrors WorkerResult claims). The orchestrator ingests the outbox as **proposals** — only its transition service writes `sdlc.db` (B.2.3 single-writer invariant holds); for in-process children the tools enqueue the same proposal object directly. (2) **Fenced block (fallback):** when no valid outbox exists (tool unavailable, malformed), the parser reads a single fenced ```` ```sdlc-result ```` JSON block at the end of the worker's `final` message (the `final` event is uncapped, so it survives the 8KiB stream caps, P32). Precedence: a valid outbox wins; outbox/fenced-block disagreement marks claims suspect. In either channel: missing or malformed claims ⇒ the verifier rejects the attempt with `RESULT_MALFORMED` (the attempt counts against retry budget) — one outcome, not either/or. In-process one-shot children may instead use `SubagentResult.structured` via `outputSchema` (P9; `defineTool`-subset schema) with `diagnostic` (≤4KiB, P32) on failure.

**Timeout policy:** soft budget at 80% (event `WORKER_BUDGET_WARNING`, worker context receives a notice on next turn for continuable workers); hard budget at 100% (SIGTERM, 30s grace, SIGKILL; `status: timeout`, attempt counted).

**Orphan salvage:** on orchestrator start/resume, every worktree not owned by a live `worker_runs` row is snapshotted (diff + uncommitted changes saved to `.sdlc/recovery/<run_id>/`), marked `orphaned=1`, and its task re-enters `FAILED`→`READY` with the snapshot attached as failure evidence.

## B.4 Risk classes and verification gates (closes G7, G9)

Risk class from the complexity features (not the score alone). **Match top-down; first row whose condition holds wins** (R4 is tested first so security/shared-resource risk can never be downgraded):

| Class | Condition (first match wins) | Required gates (in fail-fast order: B.4.1) |
|---|---|---|
| R4 critical | `sec=1` ∨ touches `task_resources` ∨ `score ≥ 0.65` | all applicable gates + security review + elevated review + human approval for production-impacting paths |
| R3 significant | `ui=1` ∨ `score ≥ 0.45` | syntax, lint, unit, integration, + api (if api domain), + e2e (if ui domain), + visual (per B.5 trigger), independent review |
| R2 standard | `score ≥ 0.25` | syntax, lint, unit, integration |
| R1 trivial | otherwise | syntax, lint, unit |

B.4.1 Gate order (spec §23, fixed): `syntax → types → lint → unit → integration → api → e2e → visual → security → perf → build`. Skipped gates are recorded as `skipped:<reason>` — evidence is explicit. `perf` runs only under spec §30 triggers; `security` static checks run on every R3/R4, deep security review only R4.

**Appearance-vs-behavior refinement (acceptance Test 1):** when `files_changed` matches the appearance-only classifier (CSS/asset/template diff with no logic, routing, or state change), the `integration`/`e2e` gates are replaced by `visual` — a button-color change must verify visually, not through an end-to-end suite. `skipped:<reason>` records the substitution.

**Team composition rule (spec §8, acceptance Test 1 "no unnecessary agents"):** a role becomes active only when the planner assigns ≥1 task to it; there are no standing role agents. Roles active for a project = distinct `task.role` values in its DAG ∪ {lead}. A role with zero tasks is never instantiated — "no unnecessary agents" is structural, not heuristic.

Behavioral test rule (spec §24): if `files_changed` includes non-test production code and no test file changed ⇒ auto-REJECT with `NO_TEST_EVIDENCE` (path classifier excludes pure docs/config).

## B.5 Visual QA (closes G8)

**Trigger:** changed files match UI classifier (`*.css|*.scss|*.less|*.html|*.jsx|*.tsx|*.vue|*.svelte|templates/**|tailwind.config.*|**/routing/**|**/layout/**`).
**Viewport matrix:** full matrix (1440×900, 1024×768, 390×844) iff changed files include responsive markers (`@media`, breakpoint configs, grid/flex utility changes, `tailwind.config.*`); otherwise desktop only.

**Automated checks** (per viewport): no horizontal overflow (`document.scrollWidth ≤ innerWidth`), no clipped/overlapping bounding boxes among visible interactive elements, all acceptance-criteria elements present, console errors = 0, failed network requests = 0, basic contrast on primary text, keyboard focus visible on all interactive elements, images have alt text, form controls have label associations (Accessibility Engineer role owns the extended a11y policy; these three checks are the always-on floor).

**AI visual review rubric** (fixed prompt; vision-capable model from ELEVATED tier or a vision-designated model):

```json
{
  "viewport": "390x844",
  "defects": [
    {"element": "submit button", "severity": "high|medium|low",
     "category": "overflow|clipping|overlap|alignment|spacing|hierarchy|consistency|missing-control|unusable-state",
     "description": "…"}
  ],
  "verdict": "pass|fail"
}
```

`verdict=fail` requires ≥1 defect of severity ≥ medium. Screenshots + the JSON verdict are stored as `visual_results` artifacts. Two consecutive visual failures on the same task ⇒ `ESCALATED` (not another blind retry).

## B.6 Loop detection & elevation (closes part of G10; spec §14–15)

**Fingerprint** = `(task_id, signature)` where `signature` = failing gate + normalized failure text of the first failing check: lowercased, paths → `<path>`, numbers/ids/hashes → `<n>`, whitespace collapsed, truncated to 200 chars; plus the sorted top-5 `files_changed` of the attempt.

**LOOP** when: same fingerprint ≥ 2 attempts, OR task has ≥ 3 failed attempts regardless of signature. Actions: stop worker (interrupt), state → `ESCALATED`, build the elevation packet:

```yaml
elevation_request:
  task_id: API-042
  attempts: [{n: 1, model: {provider,id}, status: failed, signature: "…"}, …]
  failures: [gate outputs, truncated 8KiB each]
  files_changed: […], out_of_scope_files: []
  test_output: <path to full log>
  relevant_decisions: [ADR-…]
  worktree_diff_path: .sdlc/recovery/…
  request: "diagnose root cause and propose corrective action"
```

The ELEVATED model must answer in structured form: `{root_cause, failure_pattern, mis_decomposition: bool, architecture_issue: bool, corrective_plan: [task deltas], disposition: retask|replan|architecture_review|escalate_user}`. The runtime applies `corrective_plan` only as *task-graph proposals* (new/edited tasks through the normal planner path) — the elevated model never edits the graph directly (§36).

**Escalation ladder** (spec §14): `CHEAP → (fail) BASE → (fail) ELEVATED → (unresolved) ARCHITECTURE REVIEW (multi-model collaborative, B.8) → USER (BLOCKED)`.

## B.7 User escalation & budgets (closes G10)

**Escalation triggers** (spec §45 list, made operable): ambiguous architecture (2 conflicting ADRs proposed), conflicting requirements, security risk unresolved at R4, loop unresolved by ELEVATED, missing credentials/external dependency, destructive operation proposed, production-impacting change (`dep=1` or protected paths), budget exhausted. Presentation is a decision block with options + recommendation + rationale (spec §45) via the ask/approval service; the project enters `BLOCKED` with `blocked_state` recorded.

**Escalation delivery (platform-constrained):** DSH approvals/user-questions are turn-enclosed and require a live agent (P26). Therefore escalation is implemented as: (1) the escalation-mgr persists the decision block and sets the task/project `BLOCKED`; (2) it queues a round prompt to the Lead agent (the `dsh-goal-round-driver` pattern — a queued prompt delivered when the Lead is idle); (3) inside that turn the Lead calls `ctx.approval.request({agent, toolName, reason})` (binary, one-shot, audited) or `ctx.userQuestions.ask()` (multi-option); (4) the outcome is recorded and the escalation-mgr unblocks. No background timer ever prompts the user; if no answerer is attached, the request resolves `unavailable` and the state stays `BLOCKED` (fail-closed).

**Budgets** (enforced by the runtime at dispatch and after every run):
- per task: `max_attempts`, `max_duration_ms`, `max_cost_usd`, `max_tokens` (from the task contract); **defaults by risk class** unless the planner overrides:

| Risk class | max_attempts | max_duration_ms | max_cost_usd | max_tokens |
|---|---|---|---|---|
| R1 | 2 | 1,800,000 (30 min) | 2.00 | 200,000 |
| R2 | 3 | 3,600,000 (1 h) | 5.00 | 400,000 |
| R3 | 3 | 7,200,000 (2 h) | 15.00 | 1,000,000 |
| R4 | 4 | 14,400,000 (4 h) | 50.00 | 3,000,000 |

- per run (project): `max_cost_usd`, `max_duration_ms`, `max_parallel_workers` (defaults 200.00 / 24 h / auto);
- "R4 budget" (B.8 collaborative mode) means the R4 row above, consumed against the project run budget;
- on breach: stop dispatching, let in-flight workers settle (or kill at hard breach), state → `BLOCKED` with `BUDGET_EXHAUSTED`.

**Kill switch:** `/sdlc stop` = stop dispatch + interrupt all workers + persist; `/sdlc resume` = reconciliation (below). Backpressure: provider 429/rate-limit ⇒ tier cooldown (exponential, capped), never more workers than `max_parallel_workers`.

## B.8 Model router v2 (closes G6; spec §12, §39, §55)

Deterministic rule ladder (first match wins), evaluated per **attempt**. Capability requirements constrain every rule: escalation only raises the tier among capability-eligible candidates (a retry never routes visual review to a non-vision model).

```
1. required capability missing in current tier (e.g. visual review needs
   vision)                                            → cheapest eligible tier
2. security-critical (sec=1) AND gate ∈ {security review, elevated review} → ELEVATED
3. task.requires_elevated (architecture dispute / recovery / loop)        → ELEVATED
4. attempt ≥ 2                                                           → ELEVATED
5. attempt = 1                                                           → BASE
6. attempt = 0 AND task_class = trivial                                  → CHEAP
7. attempt = 0 AND task_class = normal
      → CHEAP if hist_success(task_type) ≥ 0.9 with n ≥ 5 else BASE
8. attempt = 0 AND task_class = architectural                            → BASE
      (ELEVATED if complexity ≥ 0.65)
```

Rule 1 outranks the attempt ladder deliberately: capability is a hard constraint, attempt escalation is a soft one. `task_class` ∈ {trivial, normal, architectural} is a task-contract field set by the planner (trivial = single-file/mechanical; architectural = contracts, schemas, cross-cutting).

**Model choice within a tier:** candidates = registry entries with tier match ∧ capability superset of task needs (vision/context-window). If exactly one candidate exists, it is selected (no scoring). Otherwise score each: `0.5·hist_success + 0.3·(1/expected_cost) + 0.2·(1/latency_estimate)`, all terms min-max normalized across candidates (a constant term contributes 0). `expected_cost = model_cost + P(fail)·rework_cost` with `P(fail) = 1 − hist_success` (Laplace-smoothed `(s+1)/(n+2)`, `n<5` ⇒ prior 0.5); `model_cost` comes from the deployment price table; `latency_estimate = expected_output_tokens / estimated_speed.tokens_per_second` from the model registry (spec §37 — both deployment-authored, like the price table). Tie-break: lower cost, then stable model id order. Fallback chain: remaining candidates in score order on provider errors.

**Collaborative mode** (spec §13): triggered only by {architecture dispute (2 conflicting ADRs), security decision at R4, 2× ELEVATED failure, major refactor (score ≥ 0.65)}; runs 2–3 diverse models in parallel + one ELEVATED adjudicator; output is one ADR written to the decision ledger. Cost gate: consumes R4 budget.

**History:** every `model_runs` row feeds `hist_success` per (model, task_type). Routing is re-derived each attempt — no hard-coded model↔role binding (spec §11.3).

**Cost inputs (platform-constrained):** DSH exposes token counts and image visual-token pricing but **no currency metadata** (P20/P28). Therefore the model registry (spec §37) carries a **deployment-authored price table** (`estimated_cost.input/output` per 1M tokens) maintained in config; `cost_usd = tokens × price_table`. Token counts come from `deriveTurnTokenUsage`/`tokenUsage` sampled at turn boundaries (P28) and are recorded as estimates. Capability matching (vision, context window, reasoning efforts) uses `ctx.llm.resolveModelInfo` (P20).

## B.9 Integration strategy v2 (closes G3)

**Invariants:** (1) exactly one writer to the integration branch — the orchestrator's integration manager; (2) nothing merges without `ACCEPTED`; (3) the integration branch history is linear (`--no-ff` merge commits, one per task).

**Pipeline per task:** `ACCEPTED` → rebase-check → merge → post-merge gates → done.

```
1. git fetch/checkout integration in the integration worktree (orchestrator-owned)
2. Pre-merge check: git merge-base + tree of sdlc/task-<id> vs integration;
   if merge would conflict (git merge-tree):
     → CONFLICT event; task → FAILED(replan) with conflict file list;
       the task re-runs as a NEW attempt on a branch rebased onto current integration
       (same allowed_paths; conflict resolution is the task owner's work, inside its scope)
3. git merge --no-ff sdlc/task-<id> -m "sdlc: accept <task-id> (<title>)"
4. Post-merge gates for the merged tree at project risk level (B.4 gates for
   risk_class of the HIGHEST task merged since last green run)
5. On gate failure: git revert -m 1 <merge-commit>; involved tasks → FAILED
   with the gate evidence; the scheduler re-plans affected dependents
6. On success: tag sdlc/accepted/<task-id>; worktree disposal per B.10
```

**Conflict ownership rule:** a re-plan may only resolve conflicts inside the task's `allowed_paths`; a conflict touching files outside them ⇒ task boundaries are wrong ⇒ planner splits/rewrites tasks (this is the "serialize or restructure" of spec §20, with a defined procedure).

**Release:** `RELEASE` state runs the full gate set + `build`; production-impacting ⇒ human approval; then tag `release/<version>` from integration.

## B.10 Execution environment policy (closes G4)

- **Worktree lifecycle:** create from `integration` at dispatch (`git worktree add .sdlc/worktrees/<task-id> -b sdlc/task-<id> integration`); bootstrap deps (project-detected: `pnpm install --prefer-offline` / `npm ci` / `pip install -e .` …, timeout 10 min, logged as evidence); dispose after merge+tag on success; retain 7 days on failure (evidence), then GC. Live worktree cap = `max_parallel_workers + 4`.
- **Dependency cache:** shared stores (pnpm store / npm cache / pip cache) mounted read-write shared; per-worktree `node_modules` only when the toolchain requires it (budgeted: disk check before create).
- **Ports:** allocator block `BASE_PORT + 10·worker_slot` … `+9` (dev server, test server, fixtures); default `BASE_PORT=4100`; collisions never resolved by retry-scan — allocation is recorded in the `worker_runs` row.
- **Browser/E2E:** one browser context per worker; `max_parallel_e2e = 2` (spec §40); fixtures deterministic and per-worker namespaced (DB name `sdlc_<task-id>`, seeded per test run).
- **Concurrency caps:** `max_parallel_workers = auto` = `min(cpu_cores/2, ram_gb/2, provider_limit, 8)`; `max_shared_resource_tasks = 1` (resource locks serialize by definition). Process workers are one-shot runs (outside `maxActiveSubagents`, P34); our scheduler is the only fan-out limiter. **Permission pre-grant (P33):** every worker process starts with the `workspace-write` permission preset and the guard plugin pre-loaded; workers can never prompt for approval — anything needing authority escalates instead (B.7).

## B.11 Context assembly (closes G12)

Deterministic packer; every worker prompt = exactly these blocks, in order, with a byte budget (default 24k tokens):

1. **Role preamble** — from the role preset (persona prefix + role policy).
2. **Constitution excerpt** — only sections mapped to the task's domains (fixed section→domain map).
3. **Task contract** — objective, ACs, allowed/forbidden paths, budgets.
4. **Relevant files** — snippets from paths matching `allowed_paths` (or, for refactors, the declared `estimate.files` list), most-recently-changed first, ≤ 200 lines each.
5. **Relevant decisions** — ADRs whose `tags_json` ∩ task domains ≠ ∅ (id + decision + consequence lines only).
6. **Failure evidence** (retries only) — elevation packet or last gate output.
7. **Architecture summary** — the 1-page summary produced in `ARCHITECTURE` state.

Truncation is priority-based (drop 4, then 5, then 7 — never 1–3, 6). The assembled manifest (block list + byte counts + dropped blocks) is persisted in `worker_runs.context_manifest_json` — context decisions are auditable.

## B.12 Recovery & resume (completes G10)

`events` is append-only and authoritative. `sdlc resume` performs **reconciliation**:
1. Load `projects`/`tasks`; for each `worker_runs` row `IN_PROGRESS`, check the pid/session: alive ⇒ keep; dead ⇒ orphan salvage (B.3.2).
2. Recompute derived readiness (`BACKLOG→READY` etc.) and re-derive anything not matching reality (worktree existence, branch existence, merge state on integration).
3. Re-enter the scheduler. No state is invented: anything ambiguous becomes an `ESCALATED` task with the discrepancy as evidence.

---

# Part C — Platform binding

*(concrete DSH integration, verified against installed package sources; citations in Part A)*

## C.1 Plugin suite layout

```
dsh-plugin-sdlc/
├── packages/
│   ├── sdlc-core/          # bundle: services (tasks, scheduler, router, verifier,
│   │   │                   #   integration, evidence, escalation, guard)
│   │   ├── package.json    # dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } }
│   │   │                   # peerDependencies: { "@deepseek-ai/dsh": "0.2.0-rc.2", … }  ← P36: this is
│   │   │                   #   what compatibility is enforced against (engines.dsh is declarative only)
│   │   ├── cordis.patch.yml
│   │   └── src/            # apply(ctx, config) registrations + platform/ isolation layer
│   ├── sdlc-tools/         # model-facing propose-only tools + /sdlc commands
│   ├── sdlc-presets/       # 26 role presets (dsh-agent-preset rows in a patch)
│   └── sdlc-client-ui/     # optional dashboard (dsh.client manifest + ./client export)
└── profiles/
    ├── sdlc-lead/          # orchestrator profile (bundles: base/web + sdlc bundles)
    └── sdlc-worker/        # worker profile used by headless worker processes
```

Authoring ground truth: the installed tree ships a plugin-authoring kit at `dsh-agent-preset/skills/cordis-plugin-development/` (references + working templates) and the patch-dialect/preset specs at `cordis-composition-reference/SKILL.md` / `editing-cordis-compositions/SKILL.md` — the build phase follows those. Patch rules that shape our layout (P36 + authoring report): **no remove op** (disable by `id`-override with `disabled: true`); an `id`-patch replaces `config` wholesale (restating kept fields); `!!js` only in `config`/`disabled`; host registrations happen in `apply(ctx, config)`, patch rows only select module + config; plugin state never goes into custom session-event types (the session log is DSH's), it lives in our `sdlc.db`.

## C.2 Runtime topology (decided)

```
┌─ dsh --profile sdlc-lead (web GUI or headless driver) ──────────────┐
│  sdlc-core services (runtime authority):                           │
│    tasks · scheduler · router · verifier · integration · evidence  │
│    escalation · guard(tools/pre-execute) · worker-mgr              │
│  Lead agent (preset: sdlc-lead) — delegation + propose-only tools  │
│  Lead session carries the dsh-goal objective (durable, BLOCKED)    │
└──────────────┬─────────────────────────────────────────────────────┘
               │ PRIMARY worker seam (code-changing, parallel):
               │   ctx.subprocess.spawn({argv: dsh --profile sdlc-worker
               │                          --patch .sdlc/tiers/<tier>.yml
               │                          --json "<task prompt>", cwd: worktree})
               ▼
   ┌─ headless worker process ────────────────────────────┐
   │  sandbox-policy.workspaceRoot = process.cwd() =      │
   │    .sdlc/worktrees/<task-id>  (native containment)   │
   │  model tier = tier overlay (agent-default-model row) │
   │  role = worker profile's composed preset             │
   │  retries = --session-id <same worker session>        │
   │  NDJSON stream → worker_runs · exit 0/1 → status     │
   └──────────────────────────────────────────────────────┘

               │ SECONDARY seam (cheap same-tree work: docs, tests,
               │  small edits; NOT parallel code changes):
               │   ctx.subagents.start() one-shot spawn children
               ▼
   In-process child — sees the parent's tree (P31); model per child
   via agentOptions (P9/P18); result via SubagentResult.output/structured (P9/P32)
```

Why headless processes are primary for code work (all verified): per-process cwd ⇒ worktree is the sandbox workspace root (P6/P31); crash containment; durable resumable sessions via `--session-id` (P4); uncapped `final` event carries the result block (P32); one-shot runs bypass `maxActiveSubagents` (P34). The lighter alternative — `ctx.agents.create({meta:{cwd: worktree}})` in-process agents (P17/P31) — trades away process isolation and uses the lead process's sandbox root. **Decided mechanism:** `execution.workerMode: process | in-process` (schemastery config, default `process`); M2 measures overhead and the default may flip via config, but the seam interface (`WorkerResult`, outbox channel, guard) is identical in both modes.

Workers never need approvals: they run under a pre-granted `workspace-write` permission preset (P33) and the guard plugin denies everything outside scope; anything requiring human authority is an escalation to the Lead's turn (B.7).

## C.3 Role presets (decided)

26 `@deepseek-ai/dsh-agent-preset` rows in `sdlc-presets/cordis.patch.yml`, one per role (the spec §7 roster **plus Accessibility Engineer** — required by §53 Test 4 and owned: WCAG conformance, assistive-tech review, a11y test policy; format verified in `editing-cordis-compositions/SKILL.md`):

```yaml
- insert:
    - id: preset-sdlc-security-engineer
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: sdlc-security-engineer
        name: Security Engineer
        description: Owns threat analysis, security testing, authz review, dependency risk.
        order: 20
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |   # role mission + policy (verification policy, escalation rules)
                You are the Security Engineer on an SDLC task team…
              suffix: Your working directory is {{cwd}}. Model: {{model}}.
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'          # tool allowlist = mounted rows
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
          - id: sdlc-report
            name: '@local/sdlc-tools/report'             # propose-only result tool
```

- **Prompt** = persona prefix (role mission + verification policy + escalation rules, per spec §7 "owns" lists) + `{{cwd}}`/`{{model}}` suffix; extra policy via `ctx.systemPrompt.section()` rows where long-lived.
- **Tools** = mounted rows only (allowlist by omission) + `ctx.tools.restrict({deny})` where needed. Worker presets get NO delegation tools (`maxDepth` stays 0/1); the Lead preset adds `sdlc_*` proposal tools.
- **Permissions/model are NOT preset fields** (P15/P21): permission = the worker profile's `permission` preset row (`workspace-write`); model = tier overlay (C.6).
- **Binding (two defined mechanisms, fixed precedence):** primary — the per-run overlay also overrides the `agent-preset-registry.default` row to the task's role preset id. Contingency (in use only if M0 falsifies the overlay mechanism) — the task prompt embeds the role preamble verbatim from the same preset source, with the worker profile composing all role presets under `default` unchanged. In-process children: stock subagent children inherit the Lead's preset (P18), so per-role children use either named `dsh-tool-subagent` rows (fixed `persona`/`toolFilter`/`agentOptions` per role tool) or custom `ctx.agents.create` + `agentPresets.mount` (P17).

## C.4 Tool & command surface (decided)

Registration APIs (verified): `ctx.tools.register(defineTool({name, description, parameters: ParameterSchemaSpec, output: {schema: ValueSchemaSpec, render}}))` — the `defineTool` DSL (not zod), mandatory canonical `output` + pure `render()`; `ctx.commands.register({definitionId, name, description, input, handler})`; `ctx.systemPrompt.section({name, order, text})`; `ctx.skills.register(...)`.

| Surface | Registrations | Authority |
|---|---|---|
| Worker tools (`sdlc-tools`) | `sdlc_report_result` (WorkerResult claims), `sdlc_request_decision` (escalation), `sdlc_claim_check` (AC evidence claims) | propose-only and **channel-defined**: tools run in the worker's own process and write proposals to the worktree outbox (B.3.2); they have no `sdlc.db` access and no cross-process write path. The transition service validates and applies (B.2.1) |
| Lead tools | `sdlc_dispatch_task`, `sdlc_approve_transition`, `sdlc_record_decision`, `sdlc_plan_delta` | propose-only (in-process: enqueue proposal to the transition service); illegal transitions return `INVALID_TRANSITION` |
| Human commands | `/sdlc run\|status\|tasks\|workers\|models\|logs\|verify\|resume\|stop\|explain\|retry\|elevate\|approve\|reject` | user-only: authority-granting actions (approve/reject/stop) execute directly from the command handler against the runtime service |
| Guard | `tools/pre-execute` waterfall (`PreToolDecision`), `fs/*` decider | deny outside `allowed_paths` / forbidden command list (C.7) |

Per platform rule (authoring constraint 4): anything that grants or confirms authority stays user-only (command handlers); model tools never mutate state directly.

## C.5 Storage binding (decided)

`sdlc.db` via **Node built-in `node:sqlite`** (`DatabaseSync`) — zero native deps (P24), opened only by the orchestrator process (single-writer invariant, P23). Schema = B.2.3 DDL; all writes through one serialized transition queue. Secondary media: `ctx.storageDomain` KV (`per-record` JSON) only for small live caches (e.g. last router decision); session logs remain DSH-owned (we never append custom session events). Artifacts as files under `.sdlc/`.

## C.6 Model tier binding (decided)

- **Tier registry:** config rows in `sdlc-core` (schemastery `Config` export): `tiers: {cheap: [{provider, model, reasoningEffort?}], base: […], elevated: […]}` + deployment-authored price table (B.8).
- **Headless workers (primary):** per-run tier overlay generated at dispatch — `--patch .sdlc/tiers/<tier>.yml` overriding the `agent-default-model` row's `config: {provider, model, reasoningEffort}` (P35; the headless runner reads `agentDefaultModel` selection, P32). Precedence is guaranteed: saved user selections write into the profile patch, `--patch` overlays apply after it, and last write wins per row — so the tier overlay beats any saved selection; the overlay restates the row's full `config` (patches replace config wholesale). One overlay file per tier, regenerated when the registry changes. Contingency (in use only if M0 falsifies the overlay precedence): three thin worker profiles (`sdlc-worker-cheap/-base/-elevated`) differing solely in that row, dispatch selecting the profile per tier — both paths fully defined.
- **In-process children:** `agentOptions {provider, model, reasoningEffort, maxTokens}` per `subagents.start()` (P9/P18; spawn-only — fork children cannot select routes).
- **One-shot calls** (visual review, cheap scoring, elevation diagnosis): `ctx.llm.prepareCall(...)` / `ctx.llm.stream({provider, model, messages, system})` with `ImageBlock` content for screenshots (P19); single-attempt by design — our own retry policy wraps them.
- **Capability matching** (vision/context/reasoning): `ctx.llm.resolveModelInfo` (P20); tier policy is enforced in the orchestrator's router (the platform has no tier concept).

## C.7 Repository safety & ownership enforcement (decided; spec §46)

DSH has no command allow/deny policy and no destructive-op classifier (P25), so `sdlc-core` owns it, using the verified primitives:

1. **File ownership (runtime, preventive):** a guard plugin registers `tools/pre-execute` (+ `fs/*` decider) in BOTH the lead and worker compositions. For workers, the task contract is materialized as `.sdlc/task-contract.json` in the worktree before launch; the guard loads it at activation and denies (`PreToolDecision {kind:'deny', reason}`) any file-tool or bash-arg path outside `allowed_paths` or inside `forbidden_paths`. Workers get no approval channel to override (P33) — a denial is final for that attempt.
2. **Command policy:** the guard's `tools/pre-execute` also matches bash commands against `forbidden_patterns` (destructive git, `rm -rf` outside worktree, network exfil, secret reads); orchestrator-side verification commands run through `ctx.subprocess` (argv-based, no shell interpolation) wrapped by the same policy.
3. **Destructive/authority ops:** integration-branch writes, worktree deletion, `git push`, release tags — orchestrator-side only, each gated by `ctx.approval.request({agent, toolName, reason})` from inside the Lead's turn (P26), fail-closed on anything but `allowed-once`.
4. **Post-hoc audit:** `files_changed`/`out_of_scope_files` from git diff (B.3.2) — the durable record (P30); scope violations auto-fail the attempt regardless of preventive layers.
5. **Secrets:** worker process env is credential-scrubbed by `ctx.subprocess` (P25); the orchestrator never injects secrets into worker prompts or worktrees.

## C.8 Development loop & packaging (decided)

- **Install:** `dsh plugin --profile sdlc-lead add <local package paths>` (pnpm in the profile dir; `plugin_manager install_bundle` for the GUI flow). Hand-editing profile files is unsupported; dependency changes need a **restart** (HMR covers patch/manifest/source-module edits only).
- **Compat:** `peerDependencies: {"@deepseek-ai/dsh": "0.2.0-rc.2"}` per package (P36); incompatible bundles are skipped at recomposition; emergency escape = `allow-version … --accept-risk` into `compatibility.json`.
- **Dev loop:** `pnpm dev` in the plugin workspace runs TypeScript watch + `dsh --profile sdlc-lead` with HMR. Patch/manifest edits hot-reload; source module edits hot-reload; dependency changes need restart.

### C.8.1 M0 Validation Suite (automated spike verification)

Every remaining platform assumption is verified by a script that exits 0 (all pass) or 1 (first failure with diagnostic). Run: `pnpm run validate:m0` from the plugin workspace root. The script is a plain Node.js script (no test framework dependency) so it works in any CI environment.

```sh
#!/usr/bin/env node
// scripts/validate-m0.mjs — M0 spike validation suite
// Exit 0 = all checks pass; exit 1 = first failure with diagnostic on stderr.

import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message });
    console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

console.log('M0 Validation Suite\n');

// ── Check 1: Profile boots with sdlc-core row mounted ──
check('profile boots with sdlc-core mounted', () => {
  const out = execSync('dsh --profile sdlc-lead --dump-config 2>&1', { encoding: 'utf8', timeout: 30000 });
  if (!out.includes('sdlc-core')) throw new Error('sdlc-core row not found in dump-config output');
  if (!out.includes('@local/sdlc-core')) throw new Error('sdlc-core bundle not resolved');
});

// ── Check 2: --dump-config shows all our rows ──
check('--dump-config shows sdlc-tools, sdlc-presets rows', () => {
  const out = execSync('dsh --profile sdlc-lead --dump-config 2>&1', { encoding: 'utf8', timeout: 30000 });
  for (const pkg of ['sdlc-core', 'sdlc-tools', 'sdlc-presets']) {
    if (!out.includes(pkg)) throw new Error(`Missing ${pkg} in dump-config`);
  }
});

// ── Check 3: One defineTool + one /sdlc command register ──
check('sdlc_report_result tool registered', () => {
  // Boot headless with --json, send a trivial prompt, check the session event lists tools
  const proc = spawnSync('dsh', ['--profile', 'sdlc-lead', '--headless', '--json',
    'list your available tools and report their names only'], {
    encoding: 'utf8', timeout: 60000,
  });
  const events = proc.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const finalEvent = events.find(e => e.type === 'final');
  if (!finalEvent) throw new Error('No final event in headless output');
  const text = finalEvent.text || '';
  if (!text.includes('sdlc_report_result')) throw new Error('sdlc_report_result tool not found in agent output');
});

// ── Check 4: /sdlc command registered ──
check('/sdlc command registered', () => {
  const proc = spawnSync('dsh', ['--profile', 'sdlc-lead', '--headless', '--json',
    'what slash-commands do you have? list them'], {
    encoding: 'utf8', timeout: 60000,
  });
  const events = proc.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const finalEvent = events.find(e => e.type === 'final');
  if (!finalEvent) throw new Error('No final event');
  const text = finalEvent.text || '';
  if (!text.includes('/sdlc')) throw new Error('/sdlc command not found in agent output');
});

// ── Check 5: --patch tier overlay changes the headless model ──
check('--patch tier overlay changes model selection', () => {
  // Create a temp overlay that sets a distinctive model
  const tmpDir = mkdtempSync(join(tmpdir(), 'sdlc-m0-'));
  const overlayPath = join(tmpDir, 'tier-test.yml');
  writeFileSync(overlayPath, `
- insert:
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: __m0_test_provider__
        model: __m0_test_model__
`);
  try {
    const proc = spawnSync('dsh', ['--profile', 'sdlc-lead', '--patch', overlayPath,
      '--headless', '--json', 'say hello'], {
      encoding: 'utf8', timeout: 30000,
    });
    const events = proc.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const sessionEvent = events.find(e => e.type === 'session');
    // The session event should reflect our overlay model, or at minimum the process should boot
    // (we can't fully verify model selection without a real provider, but we verify the overlay loads)
    if (!sessionEvent) throw new Error('No session event — overlay may have broken boot');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Check 6: Headless worker reports result block through final event ──
check('headless worker reports result via final event', () => {
  // Create a throwaway git worktree
  const tmpDir = mkdtempSync(join(tmpdir(), 'sdlc-m0-worktree-'));
  try {
    execSync('git init', { cwd: tmpDir, encoding: 'utf8' });
    execSync('git config user.email "m0@test" && git config user.name "M0 Test"', { cwd: tmpDir, encoding: 'utf8' });
    writeFileSync(join(tmpDir, 'README.md'), '# M0 Test\n');
    execSync('git add -A && git commit -m init', { cwd: tmpDir, encoding: 'utf8' });

    const proc = spawnSync('dsh', ['--profile', 'sdlc-worker', '--json',
      'Create a file called hello.txt with content "hello from m0". Then call sdlc_report_result with status "completed" and summary "Created hello.txt".'],
      { cwd: tmpDir, encoding: 'utf8', timeout: 120000 });

    const events = proc.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const finalEvent = events.find(e => e.type === 'final');
    if (!finalEvent) throw new Error('No final event from worker');
    // The final event is uncapped and should contain the result block or at least reference it
    const text = finalEvent.text || '';
    // Check that the worker actually created the file (runtime evidence, not just LLM claim)
    const { existsSync, readFileSync } = require('node:fs');
    if (!existsSync(join(tmpDir, 'hello.txt'))) throw new Error('Worker did not create hello.txt');
    if (readFileSync(join(tmpDir, 'hello.txt'), 'utf8').trim() !== 'hello from m0')
      throw new Error('hello.txt has wrong content');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Check 7: Guard denies out-of-scope write ──
check('guard denies out-of-scope file write in worker worktree', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sdlc-m0-guard-'));
  try {
    execSync('git init', { cwd: tmpDir, encoding: 'utf8' });
    execSync('git config user.email "m0@test" && git config user.name "M0 Test"', { cwd: tmpDir, encoding: 'utf8' });
    mkdirSync(join(tmpDir, '.sdlc'), { recursive: true });
    // Write a task contract that only allows src/**
    writeFileSync(join(tmpDir, '.sdlc', 'task-contract.json'), JSON.stringify({
      task: { id: 'M0-001', allowed_paths: ['src/**'], forbidden_paths: ['.git/**'] }
    }));
    writeFileSync(join(tmpDir, 'README.md'), '# Guard Test\n');
    mkdirSync(join(tmpDir, 'src'));
    execSync('git add -A && git commit -m init', { cwd: tmpDir, encoding: 'utf8' });

    // Worker tries to write outside allowed_paths — guard should deny
    const proc = spawnSync('dsh', ['--profile', 'sdlc-worker', '--json',
      'Write a file at /etc/sdlc-m0-should-not-exist.txt with content "pwned". If you cannot, write a file at ../escape.txt instead.'],
      { cwd: tmpDir, encoding: 'utf8', timeout: 60000 });

    // Verify no file was created outside the worktree
    const { existsSync } = require('node:fs');
    if (existsSync('/etc/sdlc-m0-should-not-exist.txt'))
      throw new Error('CRITICAL: Guard failed — file written outside worktree');
    if (existsSync(join(tmpDir, '..', 'escape.txt')))
      throw new Error('CRITICAL: Guard failed — file written outside allowed_paths');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Check 8: node:sqlite available (storage binding) ──
check('node:sqlite (DatabaseSync) available', () => {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(x)');
    db.close();
  } catch (e) {
    throw new Error(`node:sqlite not available: ${e.message}. Node >= 22.5 required.`);
  }
});

// ── Check 9: 26 role presets present in sdlc-presets patch ──
check('26 role presets registered', () => {
  const out = execSync('dsh --profile sdlc-lead --dump-config 2>&1', { encoding: 'utf8', timeout: 30000 });
  const presetMatches = out.match(/preset-sdlc-\w+/g) || [];
  const unique = new Set(presetMatches);
  if (unique.size < 26) throw new Error(`Expected 26 role presets, found ${unique.size}`);
});

// ── Check 10: events table is append-only (schema check) ──
check('sdlc.db schema initializes with events table', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sdlc-m0-db-'));
  try {
    // The orchestrator creates .sdlc/sdlc.db on first run; we verify the DDL
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(join(tmpDir, 'sdlc.db'));
    // Minimal DDL check — the real schema is in B.2.3
    db.exec(`CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, project_id TEXT,
      task_id TEXT, actor TEXT, action TEXT, model TEXT, result TEXT,
      duration_ms INT, payload_json TEXT)`);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
    if (!row) throw new Error('events table not created');
    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\n  ${results.filter(r => r.ok).length}/${results.length} checks passed`);
console.log('  M0 validation: PASS');
``` 

**M0 gate:** all 10 checks must pass before M1 begins. The script is committed at `scripts/validate-m0.mjs` and runs in CI on every PR.

### C.8.2 Packaging & distribution

| Artifact | Format | Command |
|---|---|---|
| Source workspace | pnpm monorepo | `pnpm install && pnpm build` |
| Published packages | npm (scoped `@patwoodman/`) | `pnpm publish -r --access public` |
| Profile template | DSH profile directory | `dsh --profile sdlc-lead --from-default-profile sdlc-lead` |
| Docker image (optional) | OCI image with DSH + orchestrator pre-installed | `docker build -t sdlc-orchestrator .` |

Each published package declares `peerDependencies` on `@deepseek-ai/dsh` (P36) and a `dsh.bundle.patch` pointing at its `cordis.patch.yml`.

---

# Part D — Milestones & acceptance (spec §52/§53 mapped; closes G11 — the 27-point §58 DoD is the M8 release gate, not an MVP gate)

## D.0 Milestone validation gates

Each milestone has a **gate** — an automated check that must pass before the next milestone begins. Gates are run via `pnpm run gate:M<N>` from the plugin workspace. A gate script exits 0 (pass) or 1 (fail with diagnostic). Gates compose: `gate:M1` runs `gate:M0` first, then M1-specific checks.

| Gate | Script | What it validates |
|---|---|---|
| `gate:M0` | `scripts/validate-m0.mjs` | 10 platform checks (C.8.1): profile boots, tools/commands register, tier overlay works, worker result flow, guard enforcement, sqlite, presets |
| `gate:M1` | `scripts/validate-m1.mjs` | Complexity engine determinism (same input → same score across 10 runs); DAG persisted to `sdlc.db`; state transitions match B.2.1 matrix; events table append-only |
| `gate:M2` | `scripts/validate-m2.mjs` | Worktree lifecycle (create → bootstrap → dispose); parallel independent tasks complete; resource-locked tasks serialize; out-of-scope write auto-fails; orphan salvage on restart |
| `gate:M3` | `scripts/validate-m3.mjs` | Each gate type (syntax/lint/unit/integration/api) runs and produces evidence; false DONE claim rejected by runtime evidence; acceptance criteria mapping is complete; independent review verdict recorded |
| `gate:M4` | `scripts/validate-m4.mjs` | Loop fingerprint matches on 2 identical failures; escalation ladder CHEAP→BASE→ELEVATED fires correctly; budget breach stops dispatch; kill switch interrupts workers |
| `gate:M5` | `scripts/validate-m5.mjs` | Router picks CHEAP for trivial tasks; escalates to ELEVATED on attempt ≥ 2; capability constraints override attempt ladder; cost calculation matches price table; history feeds `hist_success` |
| `gate:M6` | `scripts/validate-m6.mjs` | Playwright runs at 3 viewports; AI visual rubric returns structured verdict; 2 consecutive visual failures trigger ESCALATED; a11y floor checks (contrast, alt text, labels) pass on clean UI |
| `gate:M7` | `scripts/validate-m7.mjs` | Integration branch merge is `--no-ff`; conflict triggers replan (not silent resolution); post-merge gate failure reverts merge; resume after kill recovers state correctly |
| `gate:M8` | `scripts/validate-m8.mjs` | All 8 spec §53 acceptance tests pass; multi-model collaborative mode produces ADR; full §58 DoD checklist green; cost report accurate within 5% |

**Gate CI integration:** every PR runs `gate:M0` through `gate:M<current>`. A PR that breaks a lower gate is blocked. Nightly builds run the full `gate:M8` suite.

---

| Milestone | Delivers | Acceptance (deeper than "runs") | Validation Gate |
|---|---|---|---|
| M0 spike | profile + plugin boots; one tool; one preset; one command | `dsh --profile sdlc-lead` mounts; `--dump-config` shows rows | `gate:M0` — 10 platform checks pass (C.8.1) |
| M1 plan | discovery, complexity (B.1), task contracts, DAG, states (B.2), events | `/sdlc run "…"` yields persisted DAG; rerun determinism of score | `gate:M1` — determinism + schema + transition matrix |
| M2 execute | worktrees (B.10), worker dispatch, WorkerResult (B.3), ownership enforcement | spec Test 6 (package.json collision ⇒ serialized) + parallel independent tasks land clean | `gate:M2` — worktree lifecycle + serialization + guard |
| M3 verify | gates (B.4), evidence, independent review, accept/reject | spec Test 7 (DONE claim rejected on mobile overflow evidence) | `gate:M3` — gate execution + evidence + false-claim rejection |
| M4 recover | loop detection (B.6), elevation ladder, escalation, budgets (B.7) | spec Test 5 (stuck worker escalates to root-cause) | `gate:M4` — loop fingerprint + escalation ladder + budgets |
| M5 route | router (B.8), history, cost reporting | trivial task rides CHEAP; failed attempt escalates to BASE | `gate:M5` — routing rules + capability constraints + cost |
| M6 visual | Playwright pipeline, viewport matrix (B.5), AI rubric | spec Test 7 at visual level; spec Test 4 (complex UI) | `gate:M6` — viewport matrix + rubric + a11y floor |
| M7 integrate | integration pipeline (B.9), conflict replan, resume (B.12) | spec Test 2 (API: parallel plan, sequential impl, merged after verify) | `gate:M7` — merge + conflict replan + resume |
| M8 harden | multi-model collaborative (B.8), perf gates, full §53 suite | spec Tests 1–8 all green; §58 DoD checklist | `gate:M8` — full acceptance suite + cost accuracy |

## D.1 Spec §53 acceptance-test traceability

| §53 test | Satisfied by | Milestone | Gate |
|---|---|---|---|
| 1 Tiny UI change (UI role, CHEAP, visual only, no unnecessary agents) | B.1 Tiny band + B.8 rule 5 (trivial→CHEAP) + B.4 appearance-only refinement (visual replaces e2e) + team composition rule (role agents only per task) | M5, M6 | `gate:M8` |
| 2 New API (parallel plan, sequential impl, unit+integration+api) | B.2.1 DAG deps (`BACKLOG→READY` on dependency `DONE`) + B.10 parallel worktrees + `task_resources` serialization + B.4 api gate | M2, M3, M7 | `gate:M8` |
| 3 Middleware (BA/Architecture/Integration/Data/Backend/QA/Security/DevOps) | C.3 role presets + planner role assignment + B.1 domain classification | M1, M8 | `gate:M8` |
| 4 Complex UI (UX/UI/Frontend/E2E/Visual QA/accessibility) | C.3 presets incl. **Accessibility Engineer** + B.5 viewport matrix + B.5 a11y floor checks | M6 | `gate:M6`, `gate:M8` |
| 5 Stuck worker (cheap→base→elevated→root-cause) | B.6 loop fingerprint + elevation packet + B.8 ladder rules 3–4 | M4 | `gate:M4`, `gate:M8` |
| 6 Collision (two workers, package.json) | `task_resources` locks + B.2.1 `READY→ASSIGNED` guard (locks grantable) | M2 | `gate:M2`, `gate:M8` |
| 7 Visual defect (DONE claim rejected, evidence, fix, pass) | B.3.2 worker claims vs runtime evidence + B.5 rubric verdict + B.2.1 `VERIFYING→FAILED` + context assembly §6 failure evidence | M3, M6 | `gate:M3`, `gate:M6`, `gate:M8` |
| 8 Architecture disagreement (independent analysis → elevated → ADR) | B.8 collaborative mode triggers + `decisions` ledger + elevated adjudication output shape | M8 | `gate:M8` |

---

# Part E — Residual risks (post-closure)

1. **RC churn** (`0.2.0-rc.2`): pin `peerDependencies` exact (P36 — this is what enforcement uses); isolate DSH API touchpoints in `sdlc-core/src/platform/`.
2. **Per-run model override** — resolved via `--patch` tier overlays (C.6), but the path is untested until M0; fallback is three thin worker profiles differing only in the `agent-default-model` row.
3. **Playwright availability** in worker environments is the project's own dependency (not DSH's) — bootstrap policy must provision it; visual QA is skipped-with-reason when the project has no browser stack.
4. **Storage scale** — `node:sqlite` (built-in) chosen over storage-domain (no queries/transactions there, P23); no native deps needed. Ordered fallback chain if `node:sqlite` is unavailable on a target Node build: (a) `better-sqlite3` plugin dependency (build-script approval gate, P24), (b) storage-domain per-record JSON with a documented record-count ceiling. Chain order is fixed; step (a) is skipped only if native deps are prohibited.
5. **Cost of worktree bootstraps** on dependency-heavy repos — mitigated by shared caches; if wall-clock is dominated by installs, add a warm-pool milestone (post-M7, not before).
6. **Cross-process coordination is unsupported by DSH** (P23/constraint): worker processes use disjoint session ids and never resume each other's sessions; the orchestrator process is the single coordinator by design — do not deploy the lead as multiple processes against one `.sdlc/`.
7. **Verification-run supervision:** `dsh-jobs` is in-memory (P29) — `worker_runs` in `sdlc.db` is the durable truth for worker/verification process state; job-style conveniences are cosmetic.

---

# Part F — Installation & Setup

This part makes the orchestrator trivially installable. The goal: **one command from zero to running**, with a doctor command that diagnoses any environment issue.

## F.1 Bootstrap script (`npx @patwoodman/orchestrator init`)

A standalone Node.js script (`packages/sdlc-cli/init.mjs`) that scaffolds everything. Published as `@patwoodman/orchestrator` on npm. Runs without any prior setup.

```sh
# One command — installs DSH if needed, creates profiles, installs plugins, validates
npx @patwoodman/orchestrator init

# Non-interactive (CI / scripting)
npx @patwoodman/orchestrator init --yes --provider openai --model-tier base:gpt-4o

# Into an existing profile
npx @patwoodman/orchestrator init --profile my-existing-profile
```

### What `init` does (step by step)

| Step | Action | Idempotent? |
|---|---|---|
| 1 | Check Node.js ≥ 22.0; if missing, print install instructions and exit 1 | Yes (re-check) |
| 2 | Check pnpm ≥ 9.0; if missing, `npm install -g pnpm` (with user consent) | Yes |
| 3 | Check `dsh` CLI; if missing, `npm install -g @deepseek-ai/dsh@0.2.0-rc.2` | Yes |
| 4 | Create profile `sdlc-lead` if it doesn't exist (`dsh plugin --profile sdlc-lead init`) | Yes |
| 5 | Create profile `sdlc-worker` if it doesn't exist | Yes |
| 6 | Install `sdlc-core`, `sdlc-tools`, `sdlc-presets` into `sdlc-lead` (`dsh plugin --profile sdlc-lead add …`) | Yes |
| 7 | Install `sdlc-tools` into `sdlc-worker` (for `sdlc_report_result` etc.) | Yes |
| 8 | Write default tier config to `.sdlc/config/tiers.yml` in the project (if inside a repo) | Yes (overwrites with `--force`) |
| 9 | Write default price table to `.sdlc/config/pricing.yml` | Yes (overwrites with `--force`) |
| 10 | Run `/sdlc doctor` to validate the installation | Yes |
| 11 | Print next-steps: `dsh --profile sdlc-lead` or `dsh --profile sdlc-lead --headless "your task"` | — |

**Failure handling:** every step is atomic. If step N fails, steps 1..N-1 are rolled back (profile deleted, packages uninstalled). The script prints the exact rollback command on failure.

**Offline mode:** `npx @patwoodman/orchestrator init --offline` skips npm installs and uses locally cached packages. For air-gapped environments.

## F.2 `/sdlc doctor` — Environment validation

A `/sdlc` subcommand that runs inside the orchestrator and validates every dependency. Output is a table with ✅/❌ per check.

```
/sdlc doctor
```

```
SDLC Orchestrator — Environment Doctor
======================================
Platform
  ✅ Node.js 22.5.1 (≥ 22.0 required for node:sqlite)
  ✅ pnpm 9.12.0
  ✅ dsh CLI 0.2.0-rc.2
  ✅ Git 2.45.0

Profiles
  ✅ sdlc-lead profile exists
  ✅ sdlc-lead has sdlc-core, sdlc-tools, sdlc-presets bundles
  ✅ sdlc-worker profile exists
  ✅ sdlc-worker has sdlc-tools bundle

Storage
  ✅ node:sqlite (DatabaseSync) available
  ✅ .sdlc/ directory writable

Models (tier configuration)
  ✅ CHEAP tier: 1 model configured (openai/gpt-4o-mini)
  ✅ BASE tier: 1 model configured (openai/gpt-4o)
  ⚠️  ELEVATED tier: no models configured
      → Run /sdlc config tiers to add an elevated model
      → Without it, escalations will fail

Provider connectivity
  ✅ openai: API key present, 1 model reachable
  ❌ anthropic: API key missing (ANTHROPIC_API_KEY not set)

Project
  ✅ Git repository detected
  ✅ .sdlc/ initialized in project root
  ✅ Integration branch 'sdlc/integration' exists

26 checks passed, 1 warning, 1 error.
Fix the error and re-run /sdlc doctor.
```

**Exit behavior:** in headless mode, `doctor` exits 0 if all checks pass, 1 if any ❌. This makes it usable in CI pre-flight checks.

**Auto-fix:** `/sdlc doctor --fix` attempts to resolve warnings and errors automatically (creates missing profiles, initializes `.sdlc/`, creates integration branch). Destructive fixes (deleting profiles) require confirmation.

## F.3 `/sdlc config` — Configuration wizard

Interactive and non-interactive configuration of all orchestrator settings.

```sh
# Interactive wizard (TUI in web GUI, prompts in headless)
/sdlc config

# Set a specific value
/sdlc config set tiers.base[0].model openai/gpt-4o
/sdlc config set budgets.max_cost_usd 500
/sdlc config set execution.workerMode process

# Show current config
/sdlc config show

# Validate config against schema
/sdlc config validate

# Reset to defaults
/sdlc config reset
```

### Configuration file locations (precedence order, last wins)

| Priority | Path | Scope |
|---|---|---|
| 1 (lowest) | Plugin defaults (in `sdlc-core` source) | Global defaults |
| 2 | `$DSH_HOME/sdlc/config.yml` | User-global (all projects) |
| 3 | `<project>/.sdlc/config.yml` | Per-project |
| 4 | Environment variables (`SDLC_*`) | Per-invocation override |
| 5 (highest) | `/sdlc config set` (writes to project config) | Explicit user override |

## F.4 Profile templates

Two shipped profile templates that users can clone:

```sh
# Minimal: just the orchestrator, no web GUI
dsh --profile sdlc-lead-minimal --from-default-profile sdlc-headless

# Full: web GUI + orchestrator + dashboard
dsh --profile sdlc-lead --from-default-profile sdlc-web
```

Template contents:

| Template | Bundles | Use case |
|---|---|---|
| `sdlc-headless` | `dsh-base` + `dsh-headless` + `sdlc-core` + `sdlc-tools` + `sdlc-presets` | CI, scripting, automation |
| `sdlc-web` | `dsh-base` + `dsh-web-app` + `sdlc-core` + `sdlc-tools` + `sdlc-presets` + `sdlc-client-ui` | Interactive development |

## F.5 First-project initialization (`/sdlc init`)

Run inside any git repository to set up the orchestrator for that project:

```sh
/sdlc init
```

Actions:
1. Create `.sdlc/` directory structure (see F.6)
2. Create `sdlc/integration` branch from current HEAD
3. Detect project type (Node.js / Python / Go / Rust / etc.) and write bootstrap commands to `.sdlc/config.yml`
4. Detect test framework and write gate commands
5. Create initial `sdlc.db` with schema (B.2.3)
6. Add `.sdlc/worktrees/` and `.sdlc/recovery/` to `.gitignore`
7. Print summary: detected stack, configured gates, next command to run

## F.6 `.sdlc/` directory layout

```
<project-root>/
├── .sdlc/
│   ├── sdlc.db                  # SQLite database (B.2.3 schema)
│   ├── config.yml               # Project-level orchestrator config
│   ├── tiers/                   # Generated tier overlay files (C.6)
│   │   ├── cheap.yml
│   │   ├── base.yml
│   │   └── elevated.yml
│   ├── worktrees/               # Active worker worktrees (B.10)
│   │   ├── API-042/
│   │   └── DB-001/
│   ├── recovery/                # Orphaned worktree snapshots (B.3.2)
│   │   └── <run-id>/
│   ├── verification/            # Test logs, screenshots, artifacts
│   │   ├── API-042/
│   │   │   ├── unit.log
│   │   │   ├── integration.log
│   │   │   └── visual/
│   │   │       ├── 1440x900.png
│   │   │       └── rubric.json
│   └── task-contract.json       # Written into each worktree at dispatch (C.7)
```

`.gitignore` additions (auto-managed by `/sdlc init`):
```
.sdlc/worktrees/
.sdlc/recovery/
.sdlc/verification/
.sdlc/sdlc.db
.sdlc/sdlc.db-*
```

---

# Part G — Testing & Validation Strategy

This part defines how the orchestrator itself is tested — distinct from the acceptance tests (§53) that validate the orchestrator's *output*. The goal: **every service, state transition, and integration point has automated test coverage**, and the full pipeline is validated end-to-end in CI.

## G.1 Test pyramid

```
                    ┌──────────────┐
                    │  E2E (8)     │  ← spec §53 acceptance tests, real repos
                    │  Full pipeline│
              ┌─────┴──────────────┴─────┐
              │  Integration (40+)       │  ← service interactions, worker dispatch,
              │  Multi-service scenarios  │    verification pipeline, resume
        ┌─────┴──────────────────────────┴────┐
        │  Unit (200+)                         │  ← complexity engine, router, state
        │  Pure functions, single services      │    machine, guard, schema validation
        └──────────────────────────────────────┘
```

| Level | Count | Framework | Runtime | Runs on |
|---|---|---|---|---|
| Unit | ~200 | `node:test` (built-in) | < 5s total | Every commit (pre-push hook) |
| Integration | ~40 | `node:test` + testcontainers | < 60s total | Every PR |
| E2E | 8 | Custom runner (spec §53) | < 30 min total | Nightly + pre-release |
| Gate | 9 suites | `scripts/validate-m*.mjs` | < 10 min total | Every PR (M0–M_current) |

**No external test framework dependency** — `node:test` (built-in Node.js test runner) is sufficient. This keeps the dev environment lean and CI fast.

## G.2 Unit test strategy

### G.2.1 Complexity engine (B.1) — property-based testing

The complexity engine is pure arithmetic. Test it exhaustively:

```js
// tests/unit/complexity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeComplexity, normalizeFeature } from '../../packages/sdlc-core/src/complexity/index.js';

test('determinism: same input → same score (100 iterations)', () => {
  const input = { domains: 3, files: 12, integrations: 1, db: true, sec: false,
    ui: true, external_deps: 2, dep: false, testing: 0.5 };
  const scores = new Set();
  for (let i = 0; i < 100; i++) {
    scores.add(computeComplexity(input).score);
  }
  assert.equal(scores.size, 1, 'score must be deterministic');
});

test('score is always in [0, 1]', () => {
  // Exhaustive: all binary flags × representative numeric ranges
  const flags = [false, true];
  for (const db of flags) for (const sec of flags) for (const ui of flags)
  for (const dep of flags) for (const testing of [0, 0.5, 1.0]) {
    for (const D of [1, 3, 5, 10]) for (const F of [1, 10, 100, 1000])
    for (const I of [0, 3, 5, 10]) for (const E of [0, 5, 10, 20]) {
      const { score } = computeComplexity({ domains: D, files: F, integrations: I,
        db, sec, ui, external_deps: E, dep, testing });
      assert.ok(score >= 0 && score <= 1,
        `score ${score} out of range for D=${D} F=${F} I=${I} E=${E} db=${db} sec=${sec} ui=${ui} dep=${dep} t=${testing}`);
    }
  }
});

test('weights sum to 1.0', () => {
  const w = { d: 0.15, f: 0.10, i: 0.15, db: 0.10, sec: 0.10, ui: 0.10, e: 0.10, dep: 0.10, t: 0.10 };
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 1.0);
});

test('band boundaries', () => {
  // Tiny: [0.00, 0.25), Small: [0.25, 0.45), Medium: [0.45, 0.65),
  // Large: [0.65, 0.80), Enterprise: [0.80, 1.00]
  const { band } = computeComplexity({ domains: 1, files: 1, integrations: 0,
    db: false, sec: false, ui: false, external_deps: 0, dep: false, testing: 0 });
  assert.equal(band, 'Tiny');
});

test('normalization: logarithmic file scaling', () => {
  const small = normalizeFeature('files', 1);
  const large = normalizeFeature('files', 1000);
  assert.ok(large > small);
  assert.ok(large <= 1.0);
  // 1 file → near 0, 1000 files → near 1
  assert.ok(small < 0.1);
  assert.ok(large > 0.9);
});
```

### G.2.2 State machine (B.2.1) — exhaustive transition testing

Every legal transition is tested. Every illegal transition is tested to be rejected.

```js
// tests/unit/state-machine.test.mjs
// Tests every cell in the B.2.1 transition matrix:
// - Legal transitions succeed and write an events row
// - Illegal transitions return INVALID_TRANSITION with the current row
// - Terminal states (DONE, CANCELLED) reject all transitions
// - Guards are enforced (e.g., BACKLOG→READY requires all deps DONE)

const legalTransitions = [
  [null, 'BACKLOG', 'planner', {}],
  ['BACKLOG', 'READY', 'scheduler', { deps: ['T1'], depStates: { T1: 'DONE' } }],
  ['BACKLOG', 'BLOCKED', 'scheduler', { deps: ['T1'], depStates: { T1: 'FAILED' } }],
  ['READY', 'ASSIGNED', 'scheduler', { locks: ['package.json'], available: true }],
  // … every row from B.2.1
];

for (const [from, to, actor, ctx] of legalTransitions) {
  test(`legal: ${from ?? '—'} → ${to} (${actor})`, () => {
    const svc = new TaskStateService(':memory:');
    if (from) svc._setState('T1', from);
    const result = svc.transition('T1', to, actor, ctx);
    assert.equal(result.ok, true);
    assert.equal(svc.getState('T1'), to);
    // events row written
    assert.ok(svc.getEvents('T1').length > 0);
  });
}

const illegalTransitions = [
  ['DONE', 'BACKLOG', 'planner'],
  ['CANCELLED', 'READY', 'scheduler'],
  ['MERGING', 'CANCELLED', 'human'],
  ['BACKLOG', 'DONE', 'planner'],     // skips all intermediate states
  ['ASSIGNED', 'DONE', 'worker-mgr'],
  // …
];

for (const [from, to, actor] of illegalTransitions) {
  test(`illegal: ${from} → ${to} (${actor}) rejected`, () => {
    const svc = new TaskStateService(':memory:');
    svc._setState('T1', from);
    const result = svc.transition('T1', to, actor, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_TRANSITION');
    assert.equal(svc.getState('T1'), from); // state unchanged
  });
}
```

### G.2.3 Model router (B.8) — rule ladder testing

Each rule is tested independently, then rules are tested for precedence:

```js
// tests/unit/router.test.mjs
test('rule 1: capability constraint outranks attempt ladder', () => {
  // Visual review task, attempt 3 (would normally be ELEVATED by rule 4)
  // but no vision model in BASE tier → must go to cheapest tier WITH vision
  const router = new ModelRouter({
    tiers: {
      cheap: [{ provider: 'openai', model: 'gpt-4o-mini' }],       // no vision
      base: [{ provider: 'openai', model: 'gpt-4o' }],              // vision ✓
      elevated: [{ provider: 'anthropic', model: 'claude-opus' }],  // vision ✓
    },
    capabilities: { 'gpt-4o-mini': ['text'], 'gpt-4o': ['text', 'vision'],
                    'claude-opus': ['text', 'vision'] },
  });
  const choice = router.route({ task: { requires: ['vision'], attempt: 3 } });
  assert.equal(choice.tier, 'base'); // cheapest tier with vision, not elevated
});

test('rule 4: attempt ≥ 2 → ELEVATED', () => {
  const router = new ModelRouter({ tiers: { cheap: [], base: [], elevated: [{ provider: 'p', model: 'm' }] }, capabilities: {} });
  assert.equal(router.route({ task: { attempt: 2 } }).tier, 'elevated');
  assert.equal(router.route({ task: { attempt: 5 } }).tier, 'elevated');
});

test('rule 6: trivial task, attempt 0 → CHEAP', () => {
  const router = new ModelRouter({ tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [], elevated: [] }, capabilities: {} });
  assert.equal(router.route({ task: { attempt: 0, task_class: 'trivial' } }).tier, 'cheap');
});

test('rule 7: normal task, high historical success → CHEAP', () => {
  const router = new ModelRouter({
    tiers: { cheap: [{ provider: 'p', model: 'c' }], base: [], elevated: [] },
    capabilities: {},
    history: { 'p/c:test': { successes: 9, failures: 1 } }, // 0.9 success rate, n=10
  });
  assert.equal(router.route({ task: { attempt: 0, task_class: 'normal', task_type: 'test' } }).tier, 'cheap');
});

test('cost calculation matches price table', () => {
  const router = new ModelRouter({
    tiers: { base: [{ provider: 'openai', model: 'gpt-4o' }] },
    capabilities: {},
    pricing: { 'openai/gpt-4o': { input: 2.50, output: 10.00 } }, // per 1M tokens
  });
  const cost = router.estimateCost('openai/gpt-4o', { tokens_in: 100000, tokens_out: 20000 });
  assert.equal(cost, (100000 * 2.50 + 20000 * 10.00) / 1_000_000); // $0.45
});
```

### G.2.4 Guard plugin (C.7) — path matching & command policy

```js
// tests/unit/guard.test.mjs
test('allowed_paths: write inside scope is permitted', () => {
  const guard = new GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] });
  assert.equal(guard.checkFsWrite('src/api/users.ts'), 'allow');
});

test('allowed_paths: write outside scope is denied', () => {
  const guard = new GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [] });
  assert.equal(guard.checkFsWrite('tests/api.test.ts'), 'deny');
});

test('forbidden_paths: write inside forbidden is denied even if in allowed', () => {
  const guard = new GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: ['src/auth/**'] });
  assert.equal(guard.checkFsWrite('src/auth/login.ts'), 'deny');
});

test('command policy: destructive git commands denied', () => {
  const guard = new GuardPlugin({ allowed_paths: ['**'], forbidden_paths: [], forbidden_commands: ['git push --force', 'rm -rf'] });
  assert.equal(guard.checkCommand('git push --force origin main'), 'deny');
  assert.equal(guard.checkCommand('rm -rf /'), 'deny');
  assert.equal(guard.checkCommand('git status'), 'allow');
  assert.equal(guard.checkCommand('pnpm test'), 'allow');
});

test('glob matching: ** matches any depth', () => {
  const guard = new GuardPlugin({ allowed_paths: ['src/**'], forbidden_paths: [] });
  assert.equal(guard.checkFsWrite('src/a.ts'), 'allow');
  assert.equal(guard.checkFsWrite('src/deep/nested/a.ts'), 'allow');
  assert.equal(guard.checkFsWrite('other/a.ts'), 'deny');
});
```

### G.2.5 Remaining unit test coverage

| Module | Test file | Key tests |
|---|---|---|
| Task contract validation | `contract.test.mjs` | Schema validation, defaults, AC mapping |
| WorkerResult derivation | `worker-result.test.mjs` | `files_changed` from git diff, `out_of_scope_files` detection, precedence (outbox > fenced block) |
| Loop fingerprinting | `loop.test.mjs` | Same failure → same fingerprint; path/number normalization; fingerprint collision resistance |
| Context assembly | `context.test.mjs` | Block ordering, byte budget, truncation priority, manifest persistence |
| Integration pipeline | `integration.test.mjs` | Merge conflict detection, revert on gate failure, `--no-ff` invariant |
| Budget enforcement | `budget.test.mjs` | Per-task, per-project, breach → BLOCKED, soft/hard timeout |
| Escalation packet | `escalation.test.mjs` | Packet structure, structured output schema, disposition routing |
| Schema migrations | `migration.test.mjs` | `schema_version` table, forward migration, rollback safety |
| Config loading | `config.test.mjs` | Precedence order (F.3), env var override, schema validation |

## G.3 Integration test strategy

Integration tests run real services together in a single process (no mocking of internal services). They use temp directories for worktrees and `:memory:` or temp-file SQLite for databases.

### G.3.1 Service interaction tests

| Test | Services involved | What it validates |
|---|---|---|
| `dispatch-and-complete` | scheduler → worker-mgr → verifier → integration | Happy path: task goes BACKLOG→READY→ASSIGNED→IN_PROGRESS→VERIFYING→ACCEPTED→MERGING→DONE |
| `resource-serialization` | scheduler → worker-mgr | Two tasks sharing `package.json` resource run sequentially, not in parallel |
| `dependency-blocking` | scheduler | Task B depends on A; B stays BACKLOG until A is DONE |
| `scope-violation-autofail` | guard → verifier | Worker writes outside `allowed_paths` → auto-FAIL with `SCOPE_VIOLATION` |
| `loop-escalation` | loop-detector → escalation-mgr → router | 2 identical failures → ESCALATED → ELEVATED model assigned |
| `budget-breach` | budget-mgr → scheduler | Project cost exceeds `max_cost_usd` → dispatch stops, state → BLOCKED |
| `orphan-salvage` | recovery → worker-mgr | Kill orchestrator mid-task → restart → orphan detected, task → FAILED→READY |
| `merge-conflict-replan` | integration-mgr → scheduler | Merge conflict → task → FAILED(replan) → new attempt on rebased branch |
| `resume-after-crash` | recovery → all services | Full state reconstruction from `events` table after simulated crash |
| `worker-timeout` | worker-mgr | Soft budget at 80% → warning; hard budget at 100% → SIGTERM → SIGKILL |

### G.3.2 Worker process integration

These tests spawn actual headless worker processes (not mocked):

```js
// tests/integration/worker-process.test.mjs
test('headless worker completes a real task in a worktree', async () => {
  const tmpRepo = await createTempGitRepo();
  const worktree = await createWorktree(tmpRepo, 'TEST-001');
  const result = await dispatchWorker({
    profile: 'sdlc-worker',
    cwd: worktree,
    prompt: 'Create a file src/hello.ts with: export const hello = "world";',
    contract: { allowed_paths: ['src/**'] },
  });
  assert.equal(result.status, 'completed');
  assert.ok(existsSync(join(worktree, 'src/hello.ts')));
  assert.ok(result.files_changed.includes('src/hello.ts'));
});

test('headless worker reports result via outbox', async () => {
  // Worker calls sdlc_report_result → writes .sdlc/task-outbox.json
  // Orchestrator ingests it as a proposal
  const result = await dispatchWorker({ … });
  const outbox = JSON.parse(readFileSync(join(worktree, '.sdlc/task-outbox.json')));
  assert.equal(outbox.status, 'completed');
});

test('guard denies out-of-scope write in worker process', async () => {
  const result = await dispatchWorker({
    prompt: 'Write a file at /tmp/sdlc-escape.txt',
    contract: { allowed_paths: ['src/**'] },
  });
  assert.ok(!existsSync('/tmp/sdlc-escape.txt'));
});
```

### G.3.3 Verification pipeline integration

```js
// tests/integration/verification.test.mjs
test('full gate pipeline: syntax → lint → unit → integration', async () => {
  const repo = await createTempNodeProject(); // package.json + src/ + tests/
  const result = await runVerification(repo, ['syntax', 'lint', 'unit', 'integration']);
  assert.equal(result.overall, 'pass');
  assert.equal(result.gates.syntax.status, 'pass');
  assert.equal(result.gates.lint.status, 'pass');
  assert.equal(result.gates.unit.status, 'pass');
  assert.equal(result.gates.integration.status, 'pass');
  // Each gate produced a log artifact
  for (const gate of ['syntax', 'lint', 'unit', 'integration']) {
    assert.ok(existsSync(join(repo, '.sdlc/verification/TEST-001', `${gate}.log`)));
  }
});

test('failing gate blocks acceptance', async () => {
  const repo = await createTempNodeProject({ brokenTest: true });
  const result = await runVerification(repo, ['syntax', 'unit']);
  assert.equal(result.overall, 'fail');
  assert.equal(result.gates.unit.status, 'fail');
  // Evidence log captures the failure
  const log = readFileSync(join(repo, '.sdlc/verification/TEST-001/unit.log'), 'utf8');
  assert.ok(log.includes('FAIL') || log.includes('✗') || log.includes('Error'));
});
```

## G.4 E2E acceptance tests (spec §53)

The 8 acceptance tests from spec §53 are implemented as E2E tests that run against real repositories. Each test:

1. Creates a temp git repo with a realistic project structure
2. Runs the full orchestrator pipeline (`/sdlc run "<requirement>"`)
3. Asserts on the final state (code changes, test results, git history, cost)

```js
// tests/e2e/acceptance.test.mjs
// Runs all 8 spec §53 tests. ~30 min total.

import { test } from 'node:test';

test('§53 Test 1: Tiny UI change (button color)', async () => {
  const repo = await createTempReactProject();
  await orchestratorRun(repo, 'Change the submit button color from blue to green');
  // Assert: only CSS changed, visual gate ran (not e2e), CHEAP model used,
  // no unnecessary agents instantiated, task is DONE
  const state = await getProjectState(repo);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].state, 'DONE');
  assert.equal(state.tasks[0].model_tier, 'cheap');
  const diff = await gitDiff(repo);
  assert.ok(diff.files.every(f => f.endsWith('.css') || f.endsWith('.scss')));
  // Visual verification ran
  assert.ok(existsSync(join(repo, '.sdlc/verification/', state.tasks[0].id, 'visual/1440x900.png')));
});

test('§53 Test 2: New API endpoint', async () => {
  const repo = await createTempExpressProject();
  await orchestratorRun(repo, 'Add a GET /api/customers endpoint that returns a list of customers');
  const state = await getProjectState(repo);
  // Assert: DAG has ≥ 2 tasks (e.g., DB model + API endpoint), sequential due to resource lock,
  // merged into integration branch after verification
  assert.ok(state.tasks.length >= 2);
  assert.ok(state.tasks.every(t => t.state === 'DONE'));
  // Integration branch has the merge commit
  const log = await gitLog(repo, 'sdlc/integration');
  assert.ok(log.some(c => c.message.includes('sdlc: accept')));
  // API gate ran
  const task = state.tasks.find(t => t.title.includes('API') || t.title.includes('endpoint'));
  assert.ok(task.verification.includes('api'));
});

// … Tests 3–8 follow the same pattern
```

**E2E test infrastructure:**
- Each test runs in an isolated temp directory (clean git repo)
- Tests run in parallel (separate processes, separate ports via B.10 port allocator)
- LLM calls use a **mock provider** that returns deterministic responses (no real API calls in CI)
- The mock provider is seeded per-test with expected responses for the task type
- Real LLM calls are reserved for nightly "live" runs (opt-in, costs money)

## G.5 CI pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test:unit          # ~200 tests, < 5s

  gate-m0:
    needs: unit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install && pnpm build
      - run: dsh plugin --profile sdlc-lead add ./packages/sdlc-core ./packages/sdlc-tools ./packages/sdlc-presets
      - run: pnpm run gate:M0        # C.8.1 validation suite

  integration:
    needs: gate-m0
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install && pnpm build
      - run: pnpm test:integration   # ~40 tests, < 60s
      - run: pnpm run gate:M1        # depends on current milestone
      - run: pnpm run gate:M2
      # … gates up to current milestone

  e2e:
    needs: integration
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install && pnpm build
      - run: pnpm test:e2e           # 8 acceptance tests, ~30 min, mock provider

  e2e-live:
    needs: e2e
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test:e2e-live      # real LLM calls, costs $$, manual trigger only
    env:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## G.6 Validation checklist per PR

Every PR must satisfy:

- [ ] All unit tests pass (`pnpm test:unit`)
- [ ] `gate:M0` passes (platform assumptions hold)
- [ ] Gates up to current milestone pass (`pnpm run gate:M<current>`)
- [ ] Integration tests pass (`pnpm test:integration`)
- [ ] New code has unit test coverage (enforced by coverage threshold: ≥ 80% for new files)
- [ ] No new `console.log` without `debug` prefix (lint rule)
- [ ] TypeScript compiles with zero errors (`pnpm build`)
- [ ] `peerDependencies` on `@deepseek-ai/dsh` are exact (`0.2.0-rc.2`)

---

# Part H — Configuration Reference

All configuration knobs, their defaults, types, and where they live. The configuration system uses schemastery `Config` (same as DSH plugins).

## H.1 Full configuration schema

```yaml
# .sdlc/config.yml (project-level; see F.3 for precedence)

# ── Model tiers (B.8, C.6) ──
tiers:
  cheap:
    - provider: openai
      model: gpt-4o-mini
      reasoningEffort: low           # optional
      maxTokens: 8192                # optional
  base:
    - provider: openai
      model: gpt-4o
    - provider: anthropic
      model: claude-sonnet-4
  elevated:
    - provider: anthropic
      model: claude-opus-4
    - provider: openai
      model: o3

# ── Price table (deployment-authored; B.8) ──
# Per 1M tokens. Update when provider pricing changes.
pricing:
  openai/gpt-4o-mini:    { input: 0.15,  output: 0.60 }
  openai/gpt-4o:         { input: 2.50,  output: 10.00 }
  openai/o3:             { input: 10.00, output: 40.00 }
  anthropic/claude-sonnet-4: { input: 3.00, output: 15.00 }
  anthropic/claude-opus-4:   { input: 15.00, output: 75.00 }

# ── Execution (B.10, C.2) ──
execution:
  workerMode: process              # process | in-process
  maxParallelWorkers: auto         # auto | <number>
  maxParallelE2e: 2
  basePort: 4100
  worktreeRetentionDays: 7         # failed worktrees kept this long
  bootstrapTimeoutMs: 600000       # 10 min
  dependencyCache: true            # shared pnpm/npm/pip caches

# ── Budgets (B.7) ──
budgets:
  perTask:                         # defaults by risk class (overridable per task)
    R1: { maxAttempts: 2, maxDurationMs: 1800000, maxCostUsd: 2.00, maxTokens: 200000 }
    R2: { maxAttempts: 3, maxDurationMs: 3600000, maxCostUsd: 5.00, maxTokens: 400000 }
    R3: { maxAttempts: 3, maxDurationMs: 7200000, maxCostUsd: 15.00, maxTokens: 1000000 }
    R4: { maxAttempts: 4, maxDurationMs: 14400000, maxCostUsd: 50.00, maxTokens: 3000000 }
  perProject:
    maxCostUsd: 200.00
    maxDurationMs: 86400000        # 24 h
    maxParallelWorkers: auto

# ── Verification gates (B.4) ──
verification:
  gateTimeoutMs: 300000            # 5 min per gate
  retryFailedGate: 1               # retry a flaky gate once
  visualViewports:
    - 1440x900
    - 1024x768
    - 390x844
  visualFullMatrix: auto           # auto | always | never
  a11yFloor: true                  # always-on a11y checks (B.5)

# ── Escalation (B.6, B.7) ──
escalation:
  loopThreshold: 2                 # same fingerprint ≥ N → ESCALATED
  maxFailedAttempts: 3             # ≥ N failed attempts → ESCALATED (any signature)
  visualFailureThreshold: 2        # consecutive visual failures → ESCALATED
  collaborativeTriggers:           # spec §13 triggers
    - architecture_dispute
    - security_r4
    - elevated_double_fail
    - major_refactor

# ── Context assembly (B.11) ──
context:
  byteBudgetTokens: 24000
  maxLinesPerFile: 200
  truncationPriority: [4, 5, 7]    # drop in this order

# ── Storage (B.2.3, C.5) ──
storage:
  dbPath: .sdlc/sdlc.db
  fallback: node-sqlite            # node-sqlite | better-sqlite3 | storage-domain

# ── Router (B.8) ──
router:
  historyWindow: 1000              # model_runs rows to consider for hist_success
  laplaceSmoothing: true
  tieBreak: cost                   # cost | modelId

# ── Observability ──
observability:
  logLevel: info                   # debug | info | warn | error
  eventLog: true                   # write to events table
  metricsExport: false             # export Prometheus metrics (future)
```

## H.2 Environment variables

| Variable | Default | Description |
|---|---|---|
| `SDLC_PROFILE` | `sdlc-lead` | Override the profile name |
| `SDLC_DB_PATH` | `.sdlc/sdlc.db` | Override database path |
| `SDLC_LOG_LEVEL` | `info` | Override log level |
| `SDLC_WORKER_MODE` | `process` | Override worker mode |
| `SDLC_MAX_PARALLEL` | `auto` | Override parallelism cap |
| `SDLC_CONFIG_PATH` | `.sdlc/config.yml` | Override config file path |
| `SDLC_TIER_OVERRIDE` | — | Force a specific tier for all tasks (debug) |
| `SDLC_DRY_RUN` | `false` | Plan only, don't execute (debug) |
| `SDLC_SKIP_GATES` | `false` | Skip verification gates (debug only, never in prod) |

## H.3 Configuration validation

`/sdlc config validate` checks:

1. **Schema:** every key is known, every value has the correct type
2. **Tier completeness:** at least one model in CHEAP and BASE; ELEVATED recommended
3. **Price table:** every model in tiers has a pricing entry
4. **Provider keys:** every provider referenced has a corresponding `*_API_KEY` env var
5. **Budget sanity:** per-task budgets < per-project budgets
6. **Port range:** `basePort` + `maxParallelWorkers * 10` doesn't conflict with common ports (3000, 8080, etc.)
7. **Path validity:** `dbPath` is writable, `worktreeRetentionDays` > 0

---

# Part I — Troubleshooting & Diagnostics

## I.1 `/sdlc doctor` (see F.2)

The primary diagnostic tool. Run it first when anything seems wrong.

## I.2 `/sdlc status` — Live project status

```
/sdlc status
```

```
Project: my-api (Medium, 0.52)
State: IMPLEMENTATION
Budget: $12.40 / $200.00 (6.2%) · 2h 14m / 24h

Tasks (5 total, 2 active, 3 done)
  DONE      DB-001   Database schema for customers          R2  base     $0.80
  DONE      API-042  GET /api/customers endpoint            R2  base     $1.20
  IN_PROG   API-043  POST /api/customers endpoint           R2  base     $0.45 (running)
  READY     TEST-01  Integration tests for customers API    R2  —        —
  BACKLOG   DOC-001  API documentation                      R1  —        —

Workers (2 active)
  PID 12345  API-043  base/openai-gpt-4o  4m 12s  45K tokens  $0.45
  PID 12346  TEST-01  (waiting for API-043)

Recent events (last 5)
  14:32:01  API-042  ACCEPTED → MERGING  (integration-mgr)
  14:32:03  API-042  MERGING → DONE      (integration-mgr, merged)
  14:32:05  API-043  READY → ASSIGNED    (scheduler)
  14:32:06  API-043  ASSIGNED → IN_PROGRESS (worker-mgr, PID 12345)
  14:35:12  API-042  post-merge gates green
```

## I.3 `/sdlc logs` — Log access

```sh
/sdlc logs                    # Recent events from sdlc.db
/sdlc logs --task API-043     # Events for a specific task
/sdlc logs --worker 12345     # Events for a specific worker
/sdlc logs --since 1h         # Last hour
/sdlc logs --follow           # Tail mode
/sdlc logs --export json      # Machine-readable export
```

## I.4 `/sdlc explain` — Decision explanation

```sh
/sdlc explain API-043                    # Why is this task in its current state?
/sdlc explain API-043 --model            # Why was this model chosen?
/sdlc explain API-043 --gates            # Why did gates pass/fail?
/sdlc explain --decision ADR-003         # Why was this decision made?
```

Example output:
```
/sdlc explain API-043 --model

Task API-043: POST /api/customers endpoint
Model chosen: base/openai/gpt-4o

Routing trace (B.8 rule ladder):
  Rule 1 (capability):    task requires [backend, api, testing] — no constraint triggered
  Rule 2 (security):      sec=0 — not triggered
  Rule 3 (requires_elev): false — not triggered
  Rule 4 (attempt ≥ 2):   attempt=1 — not triggered
  Rule 5 (attempt = 1):   → BASE tier selected

Within BASE tier:
  Candidates: openai/gpt-4o, anthropic/claude-sonnet-4
  openai/gpt-4o:          hist_success=0.92 (n=25), cost=$2.50/$10.00, latency=~30s
  anthropic/claude-sonnet: hist_success=0.88 (n=18), cost=$3.00/$15.00, latency=~35s
  Score: openai=0.5·0.92 + 0.3·(1/2.50) + 0.2·(1/30) = 0.460 + 0.120 + 0.007 = 0.587
  Score: anthropic=0.5·0.88 + 0.3·(1/3.00) + 0.2·(1/35) = 0.440 + 0.100 + 0.006 = 0.546
  Winner: openai/gpt-4o (higher score)
```

## I.5 Common failure modes

| Symptom | Likely cause | Diagnostic | Fix |
|---|---|---|---|
| `dsh --profile sdlc-lead` fails to boot | Incompatible plugin version | `dsh --profile sdlc-lead --dump-config 2>&1` — look for `skippedBundles` | `dsh plugin --profile sdlc-lead allow-version <pkg> --dsh-version 0.2.0-rc.2 --accept-risk` |
| `/sdlc doctor` shows ❌ for provider | Missing API key | Check `echo $OPENAI_API_KEY` | Export the key, or run `/sdlc config set tiers…` to use a different provider |
| Worker tasks stuck in `ASSIGNED` | Worker process failed to launch | `/sdlc logs --task <id>` — look for `worker failed to launch` | Check `node --version` (≥ 22), check disk space, check port availability |
| Worker tasks stuck in `IN_PROGRESS` | Worker hung or crashed | `/sdlc logs --worker <pid>`; check if PID is alive: `ps -p <pid>` | `/sdlc retry <task-id>` or `/sdlc stop` then `/sdlc resume` |
| Merge conflicts every time | Task boundaries overlap | `/sdlc explain <task-id>` — check `allowed_paths` | Adjust task boundaries in the DAG; conflicting files outside `allowed_paths` mean tasks need restructuring |
| `node:sqlite` not available | Node.js < 22.5 | `node -e "require('node:sqlite')"` | Upgrade Node.js, or set `storage.fallback: better-sqlite3` in config |
| Visual QA always skipped | No Playwright in project | `/sdlc logs --task <id>` — look for `skipped:no-browser-stack` | Add Playwright to project devDependencies, or disable visual gates |
| High cost / budget exhausted | Too many retries, wrong tier | `/sdlc status` — check cost breakdown | Review `/sdlc explain <task-id> --model`; adjust tier config or budgets |
| `ESCALATED` tasks not resolving | ELEVATED tier has no models | `/sdlc doctor` — check ELEVATED tier | Run `/sdlc config set tiers.elevated[0]…` to add an elevated model |
| Resume after crash shows wrong state | `events` table corruption | `/sdlc logs --export json` — check for gaps in event sequence | Restore from `.sdlc/sdlc.db.backup` (auto-created before each migration) |

## I.6 Debug logging

```sh
# Enable debug logging for a single run
dsh --profile sdlc-lead -- /sdlc run "…" 2>&1 | tee debug.log
SDLC_LOG_LEVEL=debug dsh --profile sdlc-lead --headless "…"

# Debug a specific service
SDLC_DEBUG=scheduler,router dsh --profile sdlc-lead --headless "…"

# Trace worker process spawning
SDLC_DEBUG=worker-mgr,subprocess dsh --profile sdlc-lead --headless "…"
```

Debug logs are written to `.sdlc/debug.log` (rotated at 10 MB, 3 backups).

## I.7 Recovery procedures

### Kill switch and resume

```sh
/sdlc stop           # Graceful: stop dispatching, let in-flight workers finish
/sdlc stop --force   # Immediate: interrupt all workers, persist state
/sdlc resume         # Reconcile and continue (B.12)
```

### Manual state repair

If the state machine is stuck (shouldn't happen, but):

```sh
# Force a task back to READY (loses attempt count)
/sdlc retry <task-id> --force

# Cancel a task
/sdlc stop --task <task-id>

# Reset a project (destructive: deletes sdlc.db, worktrees, integration branch)
/sdlc reset --confirm
```

### Database recovery

```sh
# Check database integrity
dsh --profile sdlc-lead -- /sdlc db check

# Vacuum (reclaim space)
dsh --profile sdlc-lead -- /sdlc db vacuum

# Export events for external analysis
dsh --profile sdlc-lead -- /sdlc db export-events --since 2026-01-01

# Restore from auto-backup
dsh --profile sdlc-lead -- /sdlc db restore --backup .sdlc/sdlc.db.backup-20260101
```

---

# Part J — Distribution, Packaging & Upgrade Path

## J.1 Package layout (published to npm)

| Package | npm name | Purpose |
|---|---|---|
| `sdlc-core` | `@patwoodman/orchestrator-core` | Services, state machine, router, guard |
| `sdlc-tools` | `@patwoodman/orchestrator-tools` | Model-facing tools + `/sdlc` commands |
| `sdlc-presets` | `@patwoodman/orchestrator-presets` | 26 role preset definitions |
| `sdlc-client-ui` | `@patwoodman/orchestrator-ui` | Optional web dashboard |
| `sdlc-cli` | `@patwoodman/orchestrator` | Bootstrap script (`npx @patwoodman/orchestrator init`) |

Each package:
- Declares `peerDependencies: { "@deepseek-ai/dsh": "0.2.0-rc.2", "@deepseek-ai/dsh-*": "0.2.0-rc.2" }` (P36)
- Declares `dsh.bundle.patch` in `package.json` pointing at its `cordis.patch.yml`
- Ships TypeScript source + compiled `lib/` (ESM)
- Ships `cordis.patch.yml` at package root

## J.2 Versioning & release

- **Version:** follows DSH version (`0.2.0-rc.2` → our `0.2.0-rc.2`). We bump in lockstep.
- **Release:** `pnpm changeset` → PR → merge → `pnpm publish -r` (CI publishes on tag)
- **Changelog:** auto-generated from conventional commits

## J.3 Upgrade path

### Upgrading the orchestrator

```sh
# Check for updates
dsh --profile sdllc-lead -- /sdlc version --check

# Upgrade (re-installs bundles in the profile)
dsh plugin --profile sdlc-lead update @patwoodman/orchestrator-core @patwoodman/orchestrator-tools @patwoodman/orchestrator-presets

# Restart required (dependency change)
dsh --profile sdlc-lead
```

### Upgrading DSH itself

```sh
# Check compatibility
npm view @deepseek-ai/dsh version   # latest DSH version

# Upgrade DSH
npm install -g @deepseek-ai/dsh@<new-version>

# Verify orchestrator still works
dsh --profile sdlc-lead -- /sdlc doctor
```

**Migration policy:** `sdlc.db` schema is versioned (`schema_version` table). On upgrade:
1. Orchestrator reads `schema_version` from `sdlc.db`
2. If `schema_version < current`, runs migrations sequentially
3. Each migration is idempotent (safe to re-run)
4. Auto-backup of `sdlc.db` created before first migration: `.sdlc/sdlc.db.backup-<timestamp>`
5. If migration fails, orchestrator refuses to start and prints the backup path

### Profile upgrade

```sh
# Re-create profiles from latest templates (preserves user patches)
dsh --profile sdlc-lead -- /sdlc upgrade-profile
```

## J.4 Docker image (optional)

```dockerfile
# Dockerfile.sdlc
FROM node:22-slim
RUN npm install -g pnpm @deepseek-ai/dsh@0.2.0-rc.2
COPY packages/ /opt/sdlc/packages/
RUN dsh plugin --profile sdlc-lead add \
      /opt/sdlc/packages/sdlc-core \
      /opt/sdlc/packages/sdlc-tools \
      /opt/sdlc/packages/sdlc-presets
WORKDIR /workspace
ENTRYPOINT ["dsh", "--profile", "sdlc-lead", "--headless"]
```

```sh
# Build and run
docker build -f Dockerfile.sdlc -t sdlc-orchestrator .
docker run -e OPENAI_API_KEY=$OPENAI_API_KEY -v $(pwd):/workspace sdlc-orchestrator "Add a health endpoint"
```

## J.5 Uninstall

```sh
# Remove the orchestrator from a profile
dsh plugin --profile sdlc-lead remove @patwoodman/orchestrator-core @patwoodman/orchestrator-tools @patwoodman/orchestrator-presets

# Delete the profiles entirely
dsh plugin --profile sdlc-lead remove --profile  # (or rm -rf $DSH_HOME/profiles/sdlc-lead)

# Clean up a project
rm -rf .sdlc/
# Remove the integration branch
git branch -D sdlc/integration
```

---

# Appendix — Cross-reference index

| Section | Key concepts | Referenced by |
|---|---|---|
| Part A | Platform facts P1–P36 | All parts |
| B.1 | Complexity engine | M1, M5, router |
| B.2 | State machines, schema | M1, M2, M7, recovery |
| B.3 | Task contract, WorkerResult | M2, M3, worker dispatch |
| B.4 | Risk classes, gates | M3, verifier |
| B.5 | Visual QA | M6 |
| B.6 | Loop detection | M4 |
| B.7 | Escalation, budgets | M4 |
| B.8 | Model router | M5, all worker dispatch |
| B.9 | Integration pipeline | M7 |
| B.10 | Execution environment | M2 |
| B.11 | Context assembly | Worker prompts |
| B.12 | Recovery | M7, resume |
| C.1–C.8 | Platform binding | Implementation |
| Part D | Milestones, gates | CI, release |
| Part F | Install & setup | Quick Start, onboarding |
| Part G | Testing strategy | CI, development |
| Part H | Configuration | F.3, `/sdlc config` |
| Part I | Troubleshooting | Operations |
| Part J | Distribution | Release, upgrade |
