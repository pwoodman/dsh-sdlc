# Proof report — tested, fixed and measured

**Date:** 2026-10-18. **Version:** `0.4.0-beta.25` (release candidate). beta.24 is live.
**Scope:** pre-npm release integrity, installer/updater safety, packed
artifacts, the flow visualizer, and the deterministic verification mechanisms.
**No live model, no registry publish, no external install.** Every number below
comes from a command in this checkout; commands are listed at the end.

**One-line result:** **shipped beta.24; beta.25 adds the UI fix.** `v0.4.0-beta.24` is pushed, CI is green,
npm has **0.4.0-beta.24 on both `beta` and `latest`**, 843 offline tests pass,
the beta artifact is ~1 MiB with zero local state, the packed CLI installs and
runs, the flow panel was verified in a real browser, and the plugin's seven core
safety mechanisms are proven against an unguarded baseline (7/7 prevented vs
7/7 escaped). The Release workflow's *post-publish* smoke step failed on its
`npx` invocation (exit 127); the same install/check/probe/uninstall sequence
passes from the published tarball locally, and the workflow now packs the
tarball explicitly for the next release. Remaining items are product decisions
and the developer-productivity study.

> **Later update — beta.28.** The measurements below are the beta.25
> snapshot. beta.28 is now live on npm (`beta` and `latest`) and in the
> [GitHub release](https://github.com/pwoodman/dsh-sdlc/releases/tag/v0.4.0-beta.28).
> It fixes three user-visible sidebar defects found in a fresh live render:
> Status/Board/Config never left `loading`, same-line JSX whitespace was
> dropped (`READY8`), and the tab strip collapsed at 343 px. The beta.28 tree
> passes 844 offline tests and gates P, M0 and Q; see
> [CHANGELOG.md](CHANGELOG.md).
>
> **Later update — beta.29.** beta.29 is now live on npm (`beta` and `latest`)
> and in the [GitHub release](https://github.com/pwoodman/dsh-sdlc/releases/tag/v0.4.0-beta.29).
> It scopes the panel to the open session's workspace (the Desktop app no
> longer reads the Harness profile directory), classifies a missing flow route
> from a status probe (`HOST_OUTDATED` / `HOST_MISSING` / `HOST_UNREACHABLE`),
> and replaces the reinstall-only hint with full-quit and per-install-channel
> guidance plus panel/host builds and Copy diagnostics. 850 offline tests pass;
> gates P, M0 and Q are green.

---

## 1. Test suite

| Layer | Before this pass | Now |
|---|---|---|
| unit | 560 | **602** |
| contract | 103 | **121** |
| integration | 47 | **64** |
| fault | 23 | **27** |
| adversarial | 23 | **29** |
| **offline total** | **756** | **843 pass, 0 fail** |
| e2e | 9 pass + 1 skip | **9 pass + 1 skip** (live opt-in) |

Coverage gate (`node scripts/validate-coverage.mjs --json .validation/gate-Q.json`):

```
843 tests, 843 pass, 0 fail
all files            95.06 lines | 81.92 branches | 95.95 functions
sdlc-core            98.52        | 85.24          | (28 files)
sdlc-orchestrator    87.44        | 78.22          | (4 files)
sdlc-client-ui       95.98        | 81.85          | (6 files)
```

The gate passes every per-package threshold, per-file floor and quality
invariant. The orchestrator package — the shipped installer/updater — is up from
**71.4 % lines / 38.7 % branches** at the start of this work.

---

## 2. Release artifact: 11 MiB → ~1 MiB, zero package-store files

**Before (reproduced):** `dist/dsh-sdlc-beta.tgz` was **10.6 MiB** with **2,314**
`.pnpm-store` entries, including a pnpm distribution and a previous release
tarball. Root cause: `git status --porcelain --ignored=matching -z` emits
`!! path`, but the parser required `! path`, so it matched nothing and the
hard-coded fallback missed `.pnpm-store`.

**After** (`scripts/lib/release-excludes.mjs` wired into `build-release.mjs`):

```
$ node scripts/build-release.mjs --skip-build
  dist/dsh-sdlc-0.4.0-beta.24.tgz  1.0 MiB  sha256 a92c5639…

$ ls -lh dist/dsh-sdlc-beta.tgz
-rw-r--r-- 1 patrick patrick 1015K …

$ tar tzf dist/dsh-sdlc-beta.tgz | grep -c pnpm-store
0
```

Regression tests: `tests/unit/release-excludes.test.mjs` (real porcelain forms,
kept `lib/`, new ignored dirs) and
`tests/integration/build-release-exclusions.test.mjs` (real tarball: no store,
no `.git`/`node_modules`/`.sdlc`/`.validation`/`.eval-*`/`dist`, size ≤ 4 MiB,
required entries present).

---

## 3. Packed artifacts: 41/41 consumer checks

`node scripts/proof-artifacts.mjs` packs the real packages, inspects each
tarball, and runs the packed CLI from a consumer `node_modules` with its declared
dependencies — no registry.

```
41/41 packed-artifact checks passed
  [ok] meta ships lib/index.js, lib/install.mjs, lib/install-lib.mjs, lib/update.js
  [ok] meta ships folded presets cordis.patch.yml + locale/en.json
  [ok] meta has no dependencies (folded)
  [ok] dsh peer is optional for package managers
  [ok] installer bin is shipped (lib/install.mjs)
  [ok] UI has no broken "types" field
  [ok] UI targets lib/index.js, lib/client.js, package.json, icon.svg, cordis.patch.yml ship
  [ok] packed CLI declares core
  [ok] packed CLI runs from a consumer node_modules
       "sdlc — deterministic control plane over .sdlc/ (no model calls)"
```

The CLI check is the load-bearing one: before the fix the packed CLI died with
`ERR_MODULE_NOT_FOUND: @patwoodman/dsh-sdlc-flow-core`; it now exits 0.

---

## 4. Mechanism proof: 7/7 hazards prevented, 7/7 escape the baseline

`node scripts/proof-mechanisms.mjs` runs the same worker evidence through the
plugin's real modules and through a two-line "trust the claim" baseline:

```
[ok] scope-violation      plugin: SCOPE_VIOLATION: secrets/prod.key
                         baseline: trusted worker claim (completed)
[ok] false-done-claim     plugin: unit failed; verdict FAILED/GATE_FAILED
                         baseline: trusted worker claim (completed; tests pass)
[ok] forged-outbox        plugin: suspect=true for run forged vs run-real
                         baseline: trusted worker claim (outbox status=completed)
[ok] resource-collision   plugin: resource-collision
                         baseline: dispatched A and B concurrently
[ok] crashed-worker       plugin: 1 orphan (no-pid); reconcile transitions 1
                         baseline: task remains IN_PROGRESS; nobody reclaims it
[ok] gate-completeness    plugin: SKIPPED_GATE_NOT_PASSED (types/lint/unit/
                         integration/security missing)
                         baseline: trusted worker claim (syntax passed)
[ok] merge-single-writer  plugin: first merged, second rejected
                         baseline: merged A and B concurrently
--------------------------------------------------------------
7/7 hazards prevented by the plugin mechanism; 7/7 escaped the unguarded baseline.
```

This is a **mechanism proof, not a productivity proof**: it does not claim a
model writes better code or that developers are faster. That remains the
Level 0–3 evidence plan in
[`DEVELOPER_VALUE_VERIFICATION.md`](DEVELOPER_VALUE_VERIFICATION.md).

---

## 5. Flow visualizer (right sidebar)

A new `GET /api/sdlc.flow` returns one bounded, read-only snapshot (200 tasks,
3 runs/task, 100 events, 50 escalations). The `sdlc` right-sidebar tab now:

- registers a **guide entry** — a pure page type had no user-reachable door
  before, so it could never be opened in a fresh session;
- defaults to a **Flow** panel showing the task DAG (nodes + dependency edges),
  subagent/worker cards (role, model, status, pid, tokens, duration), routing
  decisions (tier/rule/source), gate chips, resource locks, escalations and a
  recent-event stream;
- polls every 5 s and keeps the last snapshot marked `stale` on failure instead
  of blanking (missing cost/tokens/duration render `—`, never `0`);
- auto-opens once per page load for the first session that has an SDLC project
  (`autoOpen: false` opts out).

Tests: `tests/unit/ui-flow.test.mjs` (payload shape, layer/edge, runs, gates,
event bounds/cursor, 404), `tests/unit/ui-routes.test.mjs` (`isFlowPayload`),
`tests/unit/ui-store.test.mjs` (ready/missing/stale/reset),
`tests/unit/ui-bundle.test.mjs` (guide + body/title seats, DSH store handle,
React JSX codegen; `Task DAG` compiled into the artifact).

**Live verification (DSH 0.2.1-alpha.2, temporary `sdlc-web` profile).**
Playwright opened the real GUI, dismissed the provider modal, and found the
**SDLC** tab open on the right with the **Flow** panel: 9 task nodes
(`DEMO-001 IN_PROGRESS`, eight `READY`), `22 pass / 1 fail / 0 skipped / 1 active`
gate chips, and the Subagents/Routing/Gates sections below. Screenshot:
`.validation/flow-panel.png` (gitignored).

The live render caught two integration bugs unit tests could not:
1. the client JSX compiler emitted `__jsx(tag, props, child)` — React's third
   argument is the **key**, not children — and passed `null` props, so the title
   crashed with `reading 'key'`;
2. the sidebar slot received our raw store object instead of a DSH
   `StoreHandle`, so the body never mounted (`handle.create is not a function`).

Both are fixed and pinned by `ui-bundle.test.mjs` (children-in-props, no
`null`-props `__jsx`, and `store.create` is callable).

**Beta.25 UI follow-up:** the first iteration used a 200-px-layer absolute
canvas that did not fit a ~460 px sidebar. It is now a responsive layered
layout (six KPI cards, 2–3 cards/row, collapsible sections) with no absolute
canvas. A bare 404 from `/api/sdlc.flow` is reported as `HOST_OUTDATED` with a
quit/reopen + reinstall hint; `NO_PROJECT` stays a separate state. Pinned by
`tests/unit/ui-flow-api.test.mjs` and re-verified live (no console errors).

**DSH limitation:** the right sidebar has no surface without a session, so the
Start/hero screen cannot show the panel. Start a session (the flow auto-opens) or
open it from the guide. The GUI at `http://127.0.0.1:45971` runs the plain `web`
profile, which does not compose the SDLC rows; verify on `dsh --profile sdlc-web`
after `node scripts/install-local.mjs`.

---

## 6. Ship result

```
git commit   ff5e6de  (main)
git tag      v0.4.0-beta.24  → pushed
CI           success (v0.4.0-beta.24)
npm          beta  = 0.4.0-beta.24
             latest= 0.4.0-beta.24
```

The Release workflow ran through publish (npm has all seven packages at
beta.24), then failed at `post-publish registry install smoke` with **exit 127**
from the `npx … dsh-sdlc-install` invocation. Re-running the exact sequence
against the published tarball — install `--only all`, `--check`, boot
`sdlc-probe`, uninstall — passes locally (7 tools, 20 commands, 9 services,
26 presets in the probe report). The workflow now uses
`npm pack` + `node lib/install.mjs` instead of `npx`, so the next release's
smoke is independent of npx command-resolution semantics. The beta.24 tag keeps
the historical failed step; do not move a published tag — the fix is on `main`.

## 7. Release guard

`node scripts/verify-release.mjs --allow-current-tag --json` on the tagged tree:

```json
{
  "package": "@patwoodman/dsh-sdlc-flow",
  "version": "0.4.0-beta.24",
  "ok": true,
  "problems": [],
  "warnings": []
}
```

Before the version bump, the same guard refused beta.23 with six problems: tag
already exists, version not ahead, already on npm, CHANGELOG says unpublished,
README says unpublished, dirty tree. All are fixed. The Release workflow runs on
the tag, so it passes `--allow-current-tag`: that permits exactly the tag being
released (a newer tag, or an already-published version, still fails). The guard
runs before build/publish; `release.yml` requires a `v*` tag, publishes in
dependency order, and runs the packed-tarball post-publish smoke.

Decision table: `tests/contract/release-guard.test.mjs` (9 tests).
Workflow wiring: `tests/contract/release-workflow.test.mjs` (4 tests).

---

## 8. Fixes with regression tests

| Area | Fix | Test |
|---|---|---|
| Installer | Failed `dsh plugin add` restores `package.json` + YAML byte-for-byte; atomic writes; cross-process lock; exact `--version`; `--dsh-home` validation; incompatible `dsh` refused; corrupt JSON diagnosed; desktop reported unmanaged | `installer-safety`, `install-lib-atomic` |
| YAML | `minimumReleaseAgeExclude: []`, flow lists, duplicate keys collapse to one key | `install-lib` |
| Updater | Failed install retries after short backoff; disk verification; major consent; prerelease `check` default; one install for concurrent checks | `update-safety`, `update` |
| Release | version/tag/registry/CHANGELOG/README guard; tag-gated publish; dependency order; post-publish smoke | `release-guard`, `release-workflow` |
| Gates | Risk-derived required set is the default; skipped ≠ pass; `gatesPass === true` | `verifier`, `gate-evidence-forgery`, e2e harness |
| Merge | single-writer derived inside the transaction; missing/`HEAD` merge commit refuses revert | `state-machine`, `integration`, `merge-conflict-replan` |
| Budget | per-attempt/project breach at ingest → FAILED evidence; unknown cost/tokens ≠ 0 | `budget-ingest` |
| Schema | future schema refused before DDL; `quick_check` before writes; migration backup | `schema-version-and-integrity` |
| Escalation | persisted record/resolve; approval requires a corrective plan; rejection blocks | `escalation-authority` |
| Node | `engines.node >= 22.13.0` (unflagged `node:sqlite`); docs updated | `engines-builtins` |
| Packages | CLI declares core; UI export metadata matches shipped files | `packed-deps-resolve`, `packed-exports`, artifact proof |
| UI runtime | JSX children in props, no null props; DSH store handle for the tab body | `ui-bundle` + live Playwright render |
| Windows | `dsh.cmd` resolves through `cmd.exe` | `install-lib-atomic` |

---

## 9. Still open / human decisions

1. **The beta.24 tag's Release run is red at the old `npx` smoke step.** The
   published artifacts are fine and the packed-tarball sequence passes locally;
   `release.yml` is fixed on `main` for the next release. A published tag is not
   moved.
2. **Windows CI job** is not added. The spawn resolver is unit-tested; a
   `windows-latest` runner is a CI decision.
3. **Desktop is reported, not managed.** `--check` honestly reports the
   app-owned `desktop` profile (`managed:false`); full Desktop management is a
   product decision.
4. **Start screen has no right surface** (DSH's sidebar is session-scoped), so
   the visualizer appears after a session starts.
5. **Developer-productivity claim** still needs Level 0–3 evidence; the
   mechanism proof above is not a substitute.
6. **Commit, tag and publish** remain human release actions. The tree is dirty
   until committed; the guard will pass once the commit is clean and the tag is
   created.

---

## 10. Reproduce

```sh
# all offline tests
node --test 'tests/unit/**/*.test.mjs'
node --test 'tests/contract/**/*.test.mjs'
node --test 'tests/integration/**/*.test.mjs'
node --test 'tests/fault/**/*.test.mjs'
node --test 'tests/adversarial/**/*.test.mjs'
node --test 'tests/e2e/**/*.test.mjs'

# coverage gate
node scripts/validate-coverage.mjs --json .validation/gate-Q.json

# release artifact (~1 MiB, no .pnpm-store)
node scripts/build-release.mjs --skip-build
tar tzf dist/dsh-sdlc-beta.tgz | grep -c pnpm-store   # 0

# packed artifacts (set PNPM_BIN if pnpm is not on PATH)
PNPM_BIN=/path/to/pnpm.mjs node scripts/proof-artifacts.mjs --json .validation/proof-artifacts.json

# mechanisms vs unguarded baseline
node scripts/proof-mechanisms.mjs --json .validation/proof-mechanisms.json

# release readiness (clean tree after commit)
node scripts/verify-release.mjs --json
```

Evidence files (gitignored): `.validation/gate-Q.json`,
`.validation/proof-artifacts.json`, `.validation/proof-mechanisms.json`.
