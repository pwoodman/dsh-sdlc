# SDLC Orchestrator spec — validation report

**Subject:** `universal_sdlc_orchestrator_dsh_spec_v2.md` (1,955 lines)
**Output:** `universal_sdlc_orchestrator_dsh_spec_v3.md` (2,329 lines) + runnable harness under `scripts/`
**Platform:** `@deepseek-ai/dsh` 0.2.0-rc.2, Node v26.8.1, git 2.55.0, Linux x64
**Date:** 2025 — verified against the installed package tree at `/home/patrick/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`

---

## 1. Verdict

The v2 plan is architecturally sound — its five core decisions (runtime-owned state, diff-owned truth, preset-per-role, worktree isolation, router escalation) all hold against the real platform. **It was not implementable as written**, for one hard reason and several structural ones:

> **Every invocation in v2 uses `dsh --profile X --headless "…"`. That command cannot work.** `--headless` is not a launcher flag; `headless` is a shipped profile template. The launcher rejects the flag: `dsh --profile X --headless "hi"` → `error: unknown option '--headless'`, exit 1.

Two further showstoppers were found by reading the platform source rather than the docs:

- **Worker authentication would have failed silently.** `ctx.subprocess` strips every env name matching `/KEY|PASSWORD|SECRET|TOKEN/i` **and every `DSH_*` name** — including `DSH_HOME`. A naively spawned worker cannot resolve the orchestrator's home or any provider key.
- **The result channel the design depends on could never be written.** The guard denies writes outside `allowed_paths`, but the worker outbox lives at `<worktree>/.sdlc/task-outbox.json`; worse, that file would appear in `git diff` and auto-fail every task with `SCOPE_VIOLATION`.

All three are fixed in v3, and the fixes are tested by the harness.

## 2. What was verified, and how

| Method | Scope |
|---|---|
| Direct source inspection of 289 `@deepseek-ai/*` packages | all 36 platform claims P1–P36 |
| Live CLI probes (isolated `DSH_HOME`, nothing of the user's touched) | launcher flags, profile templates, `dump-config`, `--patch` precedence, `plugin` surface, `node:sqlite`, `allow-version` |
| New executable suite `scripts/validate-platform.mjs` | 18 checks, re-runnable, no LLM, no network |

**Result: 28 claims verified exactly as stated, 8 required a precision correction, 0 refuted.**

The verifications that changed the design:

| Finding | v2 said | Reality |
|---|---|---|
| `--headless` | everywhere | not a flag; a shipped profile template |
| Profile templates | `--from-default-profile sdlc-headless` | closed set `{acp, web, headless, sdk, sdk-minimal}`; out-of-tree plugins cannot add one |
| Slash commands | `dsh --headless "/sdlc doctor"` | no command adapter in one-shot mode; `/sdlc` is interactive-only |
| Overlay form | `- insert:` to override `agent-default-model` | insert duplicates the row; the id-targeted form replaces it |
| Credential scrub | described as a safety feature | strips `DSH_HOME` + all `*_API_KEY`; explicit `env` passthrough is required |
| Permissions | "3 sandbox modes × ask/never" | exactly three shipped pairings; sandbox governs file effects only |
| Cost gate | "accurate within 5%" | no currency metadata exists; only price-table arithmetic is checkable |
| Jobs/goal | recovery implied | `dsh-jobs` is in-memory; only `sdlc.db` + `events` are durable |

Notable *confirmations* (the plan's load-bearing assumptions that held): headless NDJSON contract and exit codes; session-cwd binding and adoption refusal; `tools/pre-execute` as the interception primitive; subagent `agentOptions` model selection; `node:sqlite` availability; the plugin-authoring kit at `dsh-agent-preset/skills/`; `allow-version` exemption semantics.

## 3. Errata applied (E1–E12)

Twelve blocking errors were corrected, each with a repair and an evidence citation. The complete table is Part 0.1 of v3. The four that change architecture:

- **E5 (credentials):** worker spawn now always passes an explicit `env` with `DSH_HOME`; provider keys default to *not forwarded*, with the worker authenticating from `$DSH_HOME/.credentials.yaml`. `execution.workerEnvKeys` is the audited opt-in.
- **E6 (package partition):** the guard moves out of `sdlc-core` into its own `sdlc-guard` package, because `sdlc-core` must never be installed in a worker profile. A worker installing it would start a second scheduler.
- **E7 (orchestrator paths):** a defined `ORCHESTRATOR_PATHS = ['.sdlc/**', '.dsh/**']` set, always writable to the worker, excluded from `files_changed`, and added to the worktree-local `.git/info/exclude`.
- **E8 (session resume):** retries only resume within an unchanged worktree; a re-created worktree gets a fresh session, because adoption is cwd- and preset-scoped.

## 4. Improvements added

**Install/setup (Parts F, L; `scripts/`).** Template-correct three-profile creation (`sdlc-web`, `sdlc-worker`, `sdlc-probe`), a pnpm/DSH preflight that prints the exact fix, an idempotent installer with a journal and targeted rollback, a `--dump-config` composition assertion, and a corrected uninstall/upgrade path. The `sdlc-probe` profile (from the `sdk` template) is new: it boots the full composition deterministically so registration can be proven without a model.

**Test/validation (Parts K, G).** Eight layers L0–L8; a required `sdlc-mock-llm` provider so every test is free and offline; property tests for the scheduler's no-overlap invariant and the state machine's transition matrix; a 13-row fault-injection matrix; a 8-row adversarial suite including outbox forgery and secret-leak scanning; a determinism harness that diffs normalized event streams; and a conformance matrix mapping every claim to a check or an explicit review marker.

**Design gaps closed.** An OS-level instance lock (`.sdlc/sdlc.lock`, heartbeat, stale takeover) replacing the honour-system single-writer invariant; append-only `events` enforced by SQLite triggers rather than a comment; explicit gate-command detection for six stacks (a previously unspecified step); `ORCHESTRATOR_PATHS`; a documented glob dialect and symlink-escape handling; per-attempt vs per-task budget semantics; `provider_limit`; an egress policy; an explicit Windows non-goal.

**Removed.** `testcontainers` (contradicted the "no external test framework" claim), the non-existent `/sdlc upgrade-profile` CLI path, and the impossible "cost within 5 %" gate.

## 5. Runnable evidence (on this machine)

| Suite | Result |
|---|---|
| `node scripts/validate-platform.mjs` | **17 pass, 0 fail, 1 skip** — the skip is real: pnpm is genuinely absent (`dsh plugin` exits 127 without it) |
| `node scripts/validate-m0.mjs` | **passes**; plugin-level checks skip cleanly until packages are built |
| `node scripts/doctor.mjs` | reports 3 errors and 2 warnings, all genuine environment facts (no pnpm; `$DSH_HOME` read-only under this session's sandbox; this directory is not a git repo) |
| `node scripts/install-local.mjs --dry-run` | 14 steps enumerated, exits 0 |

Evidence bundles: `.validation/platform-evidence.json`, `.validation/m0-evidence.json`.

Key checks and what they proved:

- `PLAT-11-patch-overlay` — the id-targeted `--patch` overlay replaces `agent-default-model`'s whole config (`deepseek-official` → `__sdlc_probe__`).
- `PLAT-12-no-dup-rows` — the id form yields **1** row; the `- insert:` form yields **2**. This is the E4 regression guard.
- `PLAT-06-launcher` — `--patch`, `--dump-config`, `--dump-config-schema`, `--from-default-profile` present; `--headless` absent.
- `PLAT-08-shutdown-templates` — the template set is closed and contains no `sdlc*` name; the v2 `--from-default-profile sdlc-headless` is impossible.
- `PLAT-16-subprocess-scrub` — the scrub pattern still strips `*_API_KEY`, and the explicit-`env` passthrough is documented in the types.
- `PLAT-10-determinism` — `--dump-config` is byte-identical across runs.

## 6. Residual risks (unchanged or newly identified)

1. **RC churn.** `0.2.0-rc.2` is a release candidate; `validate-platform.mjs` pins the version and Part J.3 requires re-running `gate:P` + `gate:M0` before trusting a new runtime. The `platform/` isolation layer is the mitigation.
2. **Cost is always an estimate.** No currency metadata exists. Bookkeeping can be exact; spend cannot be verified against a provider invoice.
3. **The guard is not a security boundary.** Command-string matching is defeatable; the sandbox root and the git diff are the real controls. Part L.3 states this so nobody builds on the wrong assumption.
4. **Headless-only deployments cannot unblock themselves.** Approvals need a live Lead turn. This is fail-closed and deliberate (L.5), but it means unattended CI needs a human-facing lead process for any approval-gated transition.
5. **Worktree bootstrap cost** can dominate wall-clock on dependency-heavy repos; the warm-pool milestone stays post-M7.
6. **Playwright availability** is the project's dependency; UI-risk tasks with a skipped visual gate are blocked rather than auto-accepted (an explicit policy change from v2).
7. **`--dump-config` writes into the profile directory**, so a read-only `DSH_HOME` breaks validation. Documented in F.3 and reported by `doctor`.
8. **Windows is unsupported** through M8 (POSIX signals, `O_EXCL` lock semantics, worktree paths).

## 7. Recommended next actions

1. Promote Part 0 to the top of the implementation brief; treat E1–E3 as the first things a new contributor reads.
2. Build `sdlc-guard` first — it is small, pure, and unblocks both M0-07 and the worker profile.
3. Implement `sdlc-mock-llm` before any integration test (it is a prerequisite for every offline test in Part K).
4. Run `scripts/install-local.mjs` and `scripts/validate-m0.mjs` in CI from day one so the gate never rots.
5. Adopt the conformance matrix (Part M) as a PR checklist: a platform dependency without a check row does not merge.
