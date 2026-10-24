# Changelog — dsh-sdlc-flow

All notable changes to the DSH SDLC Flow plugin suite.

## [1.2.3] — 2026-10-24 — CI green under Node 22 workers

### Fixed

- **PATH-hardened every `git`/`node` shell-out (the actual CI killer).**
  Node 22 multi-file test workers run with a PATH that omits the node
  binary's own directory, and sandboxed runners keep `git` outside
  `/usr/bin:/bin`. Three swallows became loud, deterministic passes:
  the installer fake takes absolute `FAKE_NODE` and aborts the add when
  the pin fails (was: exit-127 swallowed by `sh`, unpinned "success");
  `tests/lib/helpers.mjs run()` widens PATH for bare `git`/`node`
  (explicit `opts.env.PATH` still wins); production `defaultGitRunner`
  (`sdlc init`) and `defaultRunner` (gates) widen the same way, and the
  salvage-plan test executes through `run()`. The `git` failure message
  now carries status, PATH and stderr instead of a bare `failed:`.
  Verified: harshest simulation (empty HOME, `CI=true`, 2 CPUs, Node
  22.18, via `npm`) green 3/3 at 914 pass / 0 fail / 19 skip; Node 24
  green at 930 / 0 / 3.
- **1.2.1 postscript:** shipped a JS template-literal break (backticks in
  the fake's `sh` comment) — file failed to parse at all. All backticks
  removed from the embedded comment in 1.2.2.

## [1.2.2] — 2026-10-23 — CI-green patch: hermetic installer fake (re-release)

### Fixed

- **The installer-safety fake is hermetic (re-released as 1.2.2).**
  1.2.1 contained the right fix (absolute `FAKE_NODE` instead of PATH
  `node`) but shipped a JS template-literal break: backticks inside the
  fake's `sh` comment terminated the test file's template string, so the
  file failed to parse at all. All backticks removed from the embedded
  comment; file parses under Node 22 and 24; full 933-test aggregate green
  3/3 under Node 22.18 (previously 6/6 red) and green under Node 24.
- Same worker-PATH root cause as 1.2.1: Node 22 multi-file test workers
  omit the node binary dir from PATH; `sh` swallowed `node: command not
  found` (exit 127, no `set -e`) and the add "succeeded" unpinned. A
  failed pin now aborts the add (exit 1).

## [1.2.1] — 2026-10-23 — CI-green patch: hermetic installer fake (broken)

### Fixed

- **The installer-safety fake no longer resolves `node` via PATH.**
  Node 22's multi-file test workers run with a PATH that omits the node
  binary's own directory, so the fake `dsh`'s `node -e` manifest pin died
  with `node: command not found` — swallowed by `sh` (no `set -e`), so the
  add "succeeded" with the dependency unpinned and `npm test` failed on CI
  (Node 22.18) while passing locally (Node 24 workers inherit PATH). The
  fake now takes the absolute `process.execPath` as `FAKE_NODE` and aborts
  the add if the pin fails. Verified: full 933-test aggregate green 3/3
  under Node 22.18 (previously 6/6 red) and green under Node 24.

## [1.2.0] — 2026-10-23 — lead auto-on, real parallelism, Tier A correctness

### Added

- **Lead auto-on: using the Lead means a project exists.** First Lead touch
  auto-creates exactly one `default` project row (idempotent, fail-closed,
  never touches user projects). Every "no project yet — run `/sdlc run`"
  dead end is reworded: the workspace is ready and a project is active —
  describe your goal to the Lead (e.g. `/sdlc run <your goal>`).
- **Real dispatch parallelism (B.10 finally wired).**
  `Runtime.dispatchParallelism()` computes the cap from
  `effectiveParallelism` × `providerLimitFromRegistry` over configured,
  project and provider ceilings; `Runtime.dispatchBatch()` applies the
  capped ASSIGNED batch concurrently. M1–M7 gates fan out via `Promise.all`
  behind a P → M0 serial prefix (first sanctioned `Promise.all` in
  production-adjacent code).
- **Run-once coverage.** `scripts/collect-coverage.mjs` persists
  `.validation/coverage.json`; gate Q and the M8 consumer reuse it when
  fresh instead of re-spawning the suite.
- **Tier D decision docs.** `docs/decisions/D21–D25` scope the execution
  seams, authority handlers, DISK_EXHAUSTED, missing gate types + Playwright
  driver, and spec identity re-sync — each with options, recommendation,
  cost and first step. Includes a 3-vector skipped disk-full skeleton.

### Fixed

- **Orphan salvage persisted.** `worker_runs.orphaned=1` is now written for
  dead workers and `sdlc resume` routes through `recovery.reconcile()`
  (single transition per task, K.5 `ORPHAN_SALVAGE` evidence kept).
- **Runtime lock rollback** on failed DB open; **atomic O_EXCL-safe** lock
  takeover via temp + rename.
- **M8-05 layers corrected** (contract/integration in, e2e out — e2e is the
  L7 browser layer); **M0 sleep-spawn removed** (60 s → ~10 ms fail-fast);
  **`process.execPath`** for every node spawn.
- **Spec config fidelity restored.** The H.1 keys are all present with spec
  values (`visualViewports`, `visualFullMatrix`, `a11yFloor`,
  `retryFailedGate`, `visualFailureThreshold`, `maxParallelE2e`,
  `bootstrapTimeoutMs`, `dependencyCache`, `egress`, `fallbackChain`,
  router tunables, `eventLog`); `workerMode` validates (`process`
  supported, anything else an explicit unsupported error — Tier D owns the
  spawn).

### Verification

- **943 offline tests pass, 0 fail**: 685 unit, 125 contract, 64
  integration, 27 fault (+3 intentional Tier D skips), 29 adversarial,
  9 e2e (§53 acceptance suite, mock provider). Gates M1–M8 + Q green;
  gate P/M0 environment checks require the `dsh`/`pnpm` binaries CI
  installs (absent in this sandbox, pre-existing).

## [1.1.1] — 2026-10-20 — no workspace is a dead end

### Fixed

- **Markerless workspaces bootstrap with manual gates instead of failing.**
  1.1.0's fail-closed choice turned "never guess gate commands" into "no
  product at all" for any workspace without a lockfile-type stack marker — a
  plain folder, a Node project with only `package.json`, a
  `requirements.txt` Python project. Auto-setup now proceeds with
  `verification.detection: manual` and empty gates (the artifact 1.1.0's own
  failure message prescribed); nothing is guessed, `sdlc config validate`
  visibly warns that verification passes vacuously until gates are authored,
  and the explicit `sdlc init` still refuses to guess. Auto-setup also no
  longer writes a `.gitignore` outside a git repository.
- **"No project yet" is no longer reported as a setup failure.** A
  bootstrapped workspace with no project row used to render the flow
  panel's *auto-setup failed* card. The flow route now answers a distinct
  `NO_PROJECT_ROW` code and the panel renders an accurate empty state:
  "This workspace is set up — create a project with `/sdlc run`."
- **The failure card shows the host's real reason.** When auto-setup
  genuinely fails (e.g. an unwritable workspace), the reason from the host
  now reaches the card instead of a canned guess — and the CLI prints a
  clean `BOOTSTRAP_FAILED` report instead of a stack trace.
- **npm detection matches the spec's F.5 table.** A bare `package.json` was
  wrongly treated as an npm marker, writing `npm ci`/`npm test` gate
  commands that can never run on a lockfile-less project — the guessing F.5
  forbids. `package-lock.json` is the npm marker, as the spec table states;
  a `package.json`-only project now gets manual gates.

### Verification

- **906 offline tests pass**: 665 unit, 121 contract, 64 integration,
  29 adversarial, 27 fault. New coverage pins the manual-gates bootstrap
  (config content, visible vacuous-verification warning, explicit-init
  strictness, no lockfile guessed), the `NO_PROJECT_ROW` empty state at the
  route and client layers, reason threading, a Node-project-without-a-
  lockfile end-to-end bootstrap, and clean failure reports on an unwritable
  workspace.
- All 11 gates green (P, M0–M8, Q); 9/10 e2e (1 live opt-in skip); 41/41
  packed-artifact checks; 7/7 mechanism hazards. Coverage 95.70 lines /
  82.51 branches / 95.91 functions.

## [1.1.0] — 2026-10-20 — no init step, and the LLM the Harness already has

### Added

- **No init step — bootstrap on first touch.** A workspace materialises
  `.sdlc/` the moment it is first needed: the first panel request, `sdlc
  status` and `sdlc config use-host-model` all auto-create the tree, DB, gate
  detection and integration branch (`ensureProject`, spec v3 F.4).
  `ensureProject` is the single authority on "complete" — config.yml AND the
  DB — so either half-state repairs itself on the next touch (an early `sdlc
  tasks` opens the DB before any config exists; a `git clean -fdx` removes
  the gitignored DB and keeps the config). The panel's guided state now
  appears only when auto-setup genuinely fails (no recognised stack marker)
  and carries the real, actionable reason; the next request retries, so
  fixing the workspace recovers without a host restart. Three hard
  guarantees, each pinned by tests: an authored config is never rewritten by
  a read; a config POST (and adoption) requires a COMPLETE project, so a
  failed bootstrap's leftover tree can never be poisoned into a wedged
  OpenAI-default config; and a failed bootstrap mutates nothing in the
  user's git repository — the integration branch is created only after
  stack detection succeeds. Bootstrap errors (including an unwritable
  workspace) resolve into the guided state, never a rejected fetch.
- **Harness model adoption — no second API key.** A fresh bootstrap writes
  three tiers and a price table that name exactly the model the current DSH
  session resolves (`deepseek-account/deepseek-flash` on a signed-in
  Desktop) — so a new user is never asked for an OpenAI/Anthropic key.
  Settings shows the live route and can rewrite the tiers of an existing
  config in one click; `sdlc config use-host-model` does the same from the
  CLI, and `sdlc init` adopts by default (`--no-host-model` opts out — reads
  never write the spec defaults; `--provider`/`--model` must be given
  together, and init only claims adoption when it actually wrote). Adoption
  keeps the user's own price rows without re-introducing legacy ones, and
  the adopted tier entry carries the Harness's `reasoningEffort` so the
  worker overlay reproduces the exact route. The host plugin reads
  `agentDefaultModel` opportunistically (verified against the runtime's
  service declaration), so older profiles still mount. In-process subagents
  already inherit the parent route; process workers use the adopted tier
  overlay plus the shared `DSH_HOME` credential store — no provider key is
  ever materialized into a worker environment.
- **Explicit unknown pricing.** A tier model may declare
  `pricing.<provider/model>: { input: null, output: null, unknown: true }` when
  DSH exposes no currency metadata. Validation accepts it with a warning and cost
  renders as `—`; missing price entries still fail rather than guessing.

### Verification

- **902 offline tests pass**: 661 unit, 121 contract, 64 integration,
  29 adversarial, 27 fault. New coverage includes host-model profile discovery,
  tier/price adoption, the Settings adoption route, the CLI command, explicit
  unknown pricing, `ensureProject` bootstrap semantics (adoption, opt-out,
  no-op on complete projects, half-state repair in BOTH directions,
  fail-closed), CLI auto-bootstrap for `status`/`init`/`use-host-model`/`debug`
  (including the DB-only half state that used to leave OpenAI/Anthropic
  defaults silently in effect), and plugin-level auto-bootstrap
  (first-request materialisation, recovery without restart, authored-config
  preservation, write-fence poisoning refusal, contained errors on an
  unwritable workspace, re-bootstrap after `.sdlc` deletion); the CLI remains
  above the K.9 90% line threshold.
- **All 11 gates pass** (P, M0–M8, Q) — 18/18 platform, coverage 95.60 lines /
  82.03 branches / 95.80 functions. The packed publish proof installs, boots
  the probe, creates a lead session and uninstalls cleanly (41/41
  packed-artifact checks); the 1.1.0 no-clone tarball installs end-to-end in a
  fresh `DSH_HOME` and passes M0.
- **Real Chromium verification** (Settings card, earlier in this release):
  Settings rendered the live `deepseek-account/deepseek-flash` card; one click
  rewrote all three tiers and showed “Tiers updated”, with `.sdlc/config.yml`
  validated and no API key.

## [1.0.0] — 2026-10-20 — first production release

First production release. The sidebar is now an attention-first live flow view
with an animated task map, real-data-only workspace scoping, parallel-worker
capacity, cheaper polling, and a validated settings surface. The demo fixture
that seeded fake project rows is gone; every rendered row comes from the open
session's own `.sdlc` database.

### Changed

- **Flow now answers “what needs attention?” first.** A single queue surfaces
  unresolved escalations, failed tasks, failing gates, orphaned worker runs and
  path conflicts; each row opens the task that owns it. Below it: one progress
  ring, state distribution and spend, the staged DAG, live workers, and
  collapsible gates/routing/activity evidence.
- **Task cards open an inline detail** at the top of their stage: role, risk,
  tier/model, attempts, resources, branch, dependencies, runs, gates and the
  latest event, plus **Compare runs** (prefilled when the task has two runs).
- **Tasks replaces the column board** with search, All/Active/Blocked/Done
  filters, lifecycle grouping, attention markers, and the same inline detail.
- **Review is select-driven.** Task and run pickers are populated from the flow
  snapshot, default to the newest two runs, and show signed time/token/cost
  deltas, changed gates and a collapsed trace path. Stale results are hidden when
  the selection changes.
- **Settings is a secondary surface behind the gear.** Fields are grouped by
  section, only changed fields show Save, and rejected writes still never touch
  `.sdlc/config.yml`.
- **One snapshot feeds Flow and Tasks.** The tab polls `/api/sdlc.flow` once and
  keeps the last snapshot as stale on failure; config loads only when Settings
  opens.
- Every panel string is localized (en/zh), including project states, with a
  parity test that fails when a key is missing from either dictionary.
- Empty and unavailable states are actionable: a guided “No SDLC project here”
  card with a copyable `sdlc init` command, and a compact host-mismatch panel
  with versions, quit/update steps and diagnostics.

### Added

- **Live animated task map** on Flow. A deterministic SVG is derived in the
  browser from the flow snapshot — no model call and no generated HTML. Stages
  are horizontal bands, so parallel branches sit side by side; running nodes
  glow, active dependency edges stream dashed packets, completed paths stay lit,
  and blocked/failed paths turn red. Hover or select a node to trace the upstream
  and downstream path. Keyboard focus, `aria-label`s and reduced-motion fallbacks
  are included.
- **Parallel-worker meter**. The host snapshot now exposes
  `totals.parallelism` (`configured`, `effective`, `active`, `saturated`) using
  the scheduler's documented `min(cores/2, ram/2, provider, configured)` rule;
  the panel shows active slots and capacity instead of guessing from `auto`.
- **Token-throughput line.** The progress card shows recorded tokens per
  completed task, derived only from runs that actually recorded tokens (no
  fabricated zero). The visual itself adds no model calls.
- **Cheaper polling.** Flow/Tasks poll every 2.5 s while work is in flight and
  every 8 s when quiet. Each poll carries the newest event id as a cursor, so the
  host returns only new events and the client merges them into a bounded window.

### Removed

- The **demo fixture** (`demo/`), the demo seeder (`scripts/demo-run.mjs`) and
  the `DEMO` project/tasks it wrote into `.sdlc/sdlc.db`. The panel renders only
  the current workspace's project and tasks; there is no seeded/fallback task
  data. Flow and status ignore a project row whose `repo_path` belongs to
  another checkout.
- The **Status** and **Board** tabs. Both rendered data already present in the
  flow snapshot (project/totals/spend; every task), so they were a second view
  to maintain and a third place to look for the same answer.
- The free-text Review picker (typing task and run IDs) and the always-expanded
  trace path.
- Per-panel Reload buttons and reload-on-tab-switch fetches; one refresh target
  per surface remains.
- Two competing root CSS blocks and the dead rules behind the removed panels.

### Verification

- **875 offline tests pass**: 634 unit, 121 contract, 64 integration,
  29 adversarial, 27 fault. New unit coverage includes attention ordering,
  task-detail joins, review defaults, number/cost formatting, and en/zh key
  parity with every static `t()` key checked against both dictionaries.
- **Live-map coverage**: 49 UI unit tests pass on the current tree (graph
  geometry and parallel lanes, edge lifecycle states, path tracing, the
  old-host no-fabricated-cap fallback, compact token formatting, cursor merge
  and workspace reset, bundle/syntax contract plus React-binding completeness,
  en/zh parity). The full unit
  suite (`node --test 'tests/unit/**/*.test.mjs'`) passes 634/634.
- **All 11 gates pass** (P, M0–M8, Q) on the final tree. M0 was run against a
  fresh `install-local` profile: the lead composes exactly one self-contained
  `@patwoodman/dsh-sdlc-flow` bundle (197 unique rows incl. `sdlc-ui` and the
  Lead Orchestrator preset).
- **Real Chromium verification** against a workspace-scoped fixture at 647 px
  and 343 px: the Flow map rendered 4 nodes with active and blocked edges, the
  parallel meter showed 1/2 slots, Tasks/Blocked filtering, Review pickers,
  Settings fields, inline task detail and keyboard activation all worked, and
  reduced motion removed the travelling packets. There were zero page errors and
  zero horizontal overflow (`scrollWidth === clientWidth` at 343 px); the only
  console entry is the expected 404 when a workspace has no project.
- **Packed publish proof passes**: every member packs without `src/`, the
  tarballs install into scratch profiles, the probe boots 7 tools / 20 commands
  / 9 services / 26 presets, the packed lead creates a session and uninstalls
  cleanly. The 1.0.0 no-clone tarball also installs end-to-end in a fresh
  `DSH_HOME`, composes 197 unique rows, and passes M0.
- **Runtime and mechanism proofs pass**: 26/26 role compositions mount with the
  expected scoped tools, and 7/7 hazard mechanisms are prevented by the plugin
  versus 7/7 escaping the unguarded baseline; 41/41 packed-artifact checks pass.
- **E2E**: 9 deterministic §53 tests pass; the live-provider test is skipped by
  design unless a funded key is supplied.

## [0.4.0-beta.29] — 2026-10-19 — Desktop workspace scoping; honest host diagnostics

### Fixed

- **The panel reads the open session's workspace, not the Harness process
  directory.** The host plugin is not session-scoped, so on the Desktop app it
  read `<profile>/.sdlc` — usually no project at all. The tab body now sends its
  session `cwd` with every request; the host accepts it only when it is an
  absolute, existing directory and otherwise falls back to the configured root.
  The auto-open probe uses the same workspace. Status/Board/Config/Review share
  the routing, and the config POST is still constrained to an existing `.sdlc`.
- **A missing flow route is diagnosed instead of assumed.** A bare 404 used to
  claim "the panel is newer". The client now probes `/api/sdlc.status`:
  - status answers + flow 404 → `HOST_OUTDATED` (an old host build is loaded);
  - no SDLC route answers → `HOST_MISSING` (plugin not loaded/enabled);
  - the probe cannot reach the server → `HOST_UNREACHABLE`.
- **The restart guidance is actionable.** The panel explains that closing the
  window can leave Harness running in the background (with per-OS quit/kill
  examples), that the Desktop app updates through **Plugins → Add plugin**, and
  that the `npx` installer only manages the `sdlc-web` / `sdlc-worker` /
  `sdlc-probe` CLI profiles. It shows the panel and host builds and offers
  **Copy diagnostics**.
- `pluginVersion` is included in the status and flow payloads so a current host
  can identify itself to a newer panel (an old host naturally reports unknown).

### Verification

- Against the still-running Oct-18 Desktop host (old host, current panel):
  `/api/sdlc.status` 200, `/api/sdlc.flow` 404 → the panel renders the new
  `HOST_OUTDATED` state with panel build/host unknown, quit/update steps, and no
  page errors.
- A host launched from `.validation` (no project) serving a session whose
  workspace is this repo requested `/api/sdlc.status` and `/api/sdlc.flow` with
  `?cwd=<repo>`, proving the session workspace — not the host process cwd —
  selects the project.
- Flow and status are now workspace-scoped: a project row whose `repo_path`
  points at another checkout is ignored, so stale or foreign rows (including
  the removed demo seed) can never render as real data.
- 875 offline tests pass, gates P/M0/Q are green, 41/41 packed-artifact checks
  pass, and the 1.0 MiB release tarball installs end-to-end (all profiles, M0
  green).

## [0.4.0-beta.28] — 2026-10-19 — sidebar panels actually load; render fixes

### Fixed

- **Status, Board and Config no longer hang on “Loading…”.** Only the Flow panel
  had a loader; the other three stores stayed in `loading` forever and their
  Reload buttons were behind the loading branch. Every tab now loads its
  snapshot when revealed (`stores.loadPanel`), pinned by `ui-store` and the
  bundle contract test.
- **The JSX compiler preserves a same-line space between expression children.**
  `{state} {count}` compiled to `(state), (count)`, so the legend rendered
  `READY8` / `IN_PROGRESS1`; multiline indentation is still dropped per JSX
  rules. Rebuilt bundles now carry `(segment.state), " "`.
- **The panel tab strip no longer collapses at narrow widths.** The root is a
  scrolling flex column, and a scrollable child gets an automatic min-height of
  0; at a 343 px sidebar the five tab labels were clipped to a 6 px sliver. The
  tabs are now `flex: 0 0 auto`.
- **State colours reach the task cards.** The generic `.sdlc-node` border
  shorthand overrode the tone classes, so every card had a grey left edge. The
  left edge, the state-distribution strip and its legend swatches now paint the
  real state colour instead of a 7 % chip tint.
- The stage header reads `9 tasks` instead of an unlabelled `9`, and clicking a
  task card opens Review with that task ID prefilled in the picker.

### Changed

- Status/Board/Config/Review use the same quiet card system as Flow: styled
  Reload/Compare/Save controls, bordered field cards, state pills, board rows
  and a compact comparison table, in light and dark themes.

### Verification

- Live Playwright render against a fresh `sdlc-web` install on DSH 0.2.0-rc.2:
  all five tabs render data, zero console/page errors, zero failed requests, no
  horizontal overflow at 647 px and 343 px sidebar widths, light and dark themes,
  9 task cards, 22 gate passes / 1 failing, and all fold sections expand. Task
  click → Review is prefilled. Screenshots in gitignored `.validation/ui/`.
- 844 offline tests pass; gates P, M0 and Q are green.

## [0.4.0-beta.27] — 2026-10-19 — flow panel layout nits

### Changed

- KPI cards are a balanced **2×2** grid at sidebar widths (the 3+1 wrap read as
  an orphaned card).
- Stage labels render as `Stage 1` / `Stage 2` with their space intact, and the
  task grid targets three cards per row at ~650 px and two at ~460 px.
- No behavioural change; tests and the live render remain green.

## [0.4.0-beta.26] — 2026-10-19 — visual hierarchy pass for the flow panel

### Changed

- **Apple-inspired hierarchy and restraint.** The panel now opens with an
  `SDLC FLOW` overline, the project name, a state pill and a live/stale dot;
  the refresh action is a single quiet icon control. The six equal KPI cards
  became four high-signal cards plus a progress meter, so the eye lands on
  tasks/running/pass/failing first. Spacing, type scale and borders follow one
  rhythm instead of per-widget defaults.
- **Domo-inspired glanceability.** A completion bar and a stacked state
  distribution bar (with a four-item legend) summarise the whole task mix above
  the DAG. Gate counts paint pass/fail/skipped/unknown consistently across the
  panel.
- **Cursor-inspired developer density.** Task/run/event identifiers are
  monospace, counts are tabular, the DAG is a responsive layered card grid
  (2–3 cards per row at sidebar widths) instead of an absolute canvas, and
  Subagents/Routing/Gates/Locks/Escalations/Events are collapsible sections
  with counts. Task cards gained a state-coloured left edge, hover lift and
  focus-visible rings.
- The host-outdated panel gained an `!` status mark and a **Copy command**
  action; it remains a distinct state from `NO_PROJECT`.
- Motion is limited to 120–240 ms hover/progress transitions and disabled under
  `prefers-reduced-motion`; colours use `Canvas`/`CanvasText`/`color-mix` so
  light and dark themes stay legible.

### Verification

- Live Playwright render on DSH 0.2.1-alpha.2 at the real sidebar width: no
  page/console errors, 9 task cards, 1 running, 22 gate passes, 1 failing,
  collapsible sections, and a route-intercepted 404 showing the actionable
  host/client mismatch state.
- 843 offline tests pass; the coverage gate is green.

## [0.4.0-beta.25] — 2026-10-19 — flow panel polish and host-version diagnostics

### Fixed

- **The Flow panel no longer shows a generic `http 404: Not Found` after an
  in-place update.** A 404 from `/api/sdlc.flow` is split into the expected
  `NO_PROJECT` state and a `HOST_OUTDATED` state. The latter tells the user the
  client panel is newer than the loaded host code, to quit DeepSeek Harness
  completely and reopen it, and gives the exact reinstall command. Generic HTTP
  errors still render with their real reason.
- **The panel is redesigned for a narrow right sidebar.** The wide absolute
  DAG canvas (200 px layers, 168 px cards, 700 px+ tall) is replaced by a
  responsive layered layout: six compact KPI cards, 2–3 task cards per row,
  state-coloured borders, and collapsible Subagents/Routing/Gates/Locks/
  Escalations/Events sections with counts. It uses `Canvas`/`CanvasText` and
  `color-mix` so it follows light and dark themes, and the panel switcher is a
  compact segmented control instead of browser-default buttons.
- The Flow panel now stays usable at ~420–650 px wide, which is the actual
  rendered sidebar width; no horizontal page growth and no giant empty canvas.

### Verification

- `tests/unit/ui-flow-api.test.mjs` pins `NO_PROJECT`, bare-404
  `HOST_OUTDATED`, and malformed-payload handling.
- Live Playwright render on DSH 0.2.1-alpha.2: no console/page errors, 9 task
  cards, 22/1 gate KPIs, collapsible sections; screenshot captured.

## [0.4.0-beta.24] — 2026-10-19 — pre-npm hardening and the flow visualizer

### Added

- **Right-sidebar flow visualizer.** The `sdlc` tab now opens from the right
  sidebar guide as **SDLC Flow**, defaults to a live `Flow` panel, and auto-opens
  once per page load for the first session with an SDLC project
  (`autoOpen: false` opts out). It shows the task DAG with dependency edges,
  subagent/worker cards (role, model, status, pid, tokens, duration), routing
  decisions (tier/rule/source), gate chips, resource locks, escalations, and a
  bounded recent-event stream. It polls `/api/sdlc.flow` every 5 s and keeps the
  last snapshot as `stale` on failure instead of blanking.
- `GET /api/sdlc.flow` returns one bounded, read-only snapshot (200 tasks,
  3 runs/task, 100 events, 50 escalations); missing cost/tokens/duration stay
  `null` with a `source`/reason, never zero. `isFlowPayload` and `fetchFlow`
  validate the shape.
- `scripts/verify-release.mjs` refuses a version already tagged or published,
  a missing/stale CHANGELOG section, a README that calls the release unpublished,
  or a dirty tree. `release.yml` runs it before building, requires a version tag
  to publish, publishes in dependency order, and adds a post-publish registry
  install smoke (`--only all`, `--check`, probe, uninstall).
- `scripts/proof-mechanisms.mjs` proves 7/7 hazards against an unguarded
  baseline; `scripts/proof-artifacts.mjs` proves 41/41 packed-artifact checks.

### Fixed

- **The beta tarball no longer carries local state.** `git status --ignored`
  emits `!! path`, but the parser expected `! `, so `.pnpm-store` (11 MiB,
  2,314 files, including a pnpm distribution) travelled in every release
  artifact. The artifact is now ~0.9 MiB with zero store entries.
- **A failed install no longer leaves an unbootable profile.** The installer
  snapshots `package.json` + `pnpm-workspace.yaml`, restores them on any failure,
  writes atomically, and holds a cross-process lock with stale/dead-pid reclaim.
  `--version` accepts only an exact semver (no swallowed flags), `--dsh-home`
  requires a value, an incompatible `dsh` is refused, and corrupt profile JSON is
  diagnosed instead of rewritten.
- **`minimumReleaseAgeExclude: []` no longer produces a duplicate YAML key**;
  inline, flow-style, block and duplicate-key forms collapse to one key.
- **Auto-update fails safe.** Failed installs get a short retry backoff instead
  of a 24 h suppression; "installed" requires the version on disk; a major
  release needs explicit consent; prerelease builds `check` by default while
  stable builds still install; concurrent checks share one install.
- **ACCEPTED is no longer fail-open.** `decideAcceptance` takes an explicit
  `requiredGates` set and requires every required gate to be present and
  passing (skipped is not a pass); the reference harness derives it from the
  task's risk and configured gates, and `gatesPass` now requires `=== true`.
- **MERGING enforces one writer from the database**, inside the same
  transaction (`mergeSlotFree` can be vetoed by the caller, never granted).
  `postMergeOutcome` refuses a missing/`HEAD` merge commit instead of reverting
  an arbitrary merge.
- **Budget overruns are evidence at ingest.** Per-attempt/project breaches
  transition an IN_PROGRESS task to FAILED with `BUDGET_EXHAUSTED` payload;
  missing cost/tokens are `unknown`, not zero.
- **Schema safety:** a database written by a newer schema is refused before any
  DDL, `quick_check` runs before writes, and migration is attempted only after
  compatibility passes.
- **Escalations are persisted and composable:** `recordEscalation`,
  `getEscalations`, and `resolveEscalation`; approval unblocks only with an
  explicit corrective plan, rejection blocks, and every resolution is audited.
- **Published packages are complete.** The CLI declares its core dependency
  (packed CLI verified to run standalone); the UI no longer advertises missing
  `types`/`src` targets; `engines.node` is `>=22.13.0` (the first version where
  `node:sqlite` is unflagged).
- The installer reports the app-managed `desktop` profile instead of silently
  ignoring it, and `dsh` spawn resolves `dsh.cmd` through `cmd.exe` on Windows.
- **The client JSX compiler now matches React's automatic runtime**: children
  live in props (the third `jsx` argument is a key) and empty props are `{}`,
  not `null`. The title previously crashed with `reading 'key'` on the first
  real render. The right-sidebar body also passes a DSH `StoreHandle`
  (`create/getSnapshot/subscribe/clearPersisted`) instead of a raw store object.
  Found by a live Playwright render on DSH 0.2.1-alpha.2 and pinned by
  `tests/unit/ui-bundle.test.mjs`; the panel then rendered 9 tasks,
  22/1 gate chips, subagents and routing in the right sidebar.

### Verification

- 835 offline tests pass (unit 594, contract 121, integration 64, fault 27,
  adversarial 29) plus 9 E2E (1 live skip); the coverage gate is green. The
  flow panel was also verified in a real browser against a temporary
  `sdlc-web` profile (DSH 0.2.1-alpha.2).
- `PROOF_REPORT.md` records the measured evidence, the release guard output,
  the artifact/mechanism proofs, and the items still deliberately open.

## [0.4.0-beta.23] — 2026-10-18 — SDLC tool lifecycle and execution contracts

### Fixed

- The lead preset's persona suffix no longer references `{{cwd}}`. DSH's prompt
  registry provides only `provider` and `model`, so `{{cwd}}` failed every new
  turn with `unknown prompt variable "{{cwd}}" in section
  "deployment:persona-suffix"`. The suffix is now `Model: {{model}}.`; the
  working directory remains available through the runtime-context entry.
- The lead bundle now publishes only the Lead Orchestrator as a selectable
  `@deepseek-ai/dsh-agent-preset`. DSH's Settings and new-session preset picker
  were listing all 26 role compositions (DevOps Engineer, QA Engineer, Technical
  Writer, …) as user choices. The full registry still drives planner role
  assignment and remains in the probe/member bundle and the offline composition
  verifier, but it is no longer part of the interactive preset menu.
- `dsh-sdlc-install` now upgrades an existing install in place: it prunes member
  packages and the pre-rename `orchestrator` family left by older releases,
  drops stale suite bundles, and skips the package-manager run when the profile
  is already at the target version. `--check` reports installed vs published
  without changing anything; `--uninstall`/`--remove` removes the packages and
  bundle selections; `--force` allows a reinstall or downgrade.
- The lead checks npm for a newer published version on startup (at most once
  per 24 hours) and installs it through DSH's plugin manager. Updates report
  `restart-required`; `SDLC_AUTO_UPDATE=off` disables the check and
  `SDLC_AUTO_UPDATE=check` only reports availability. Link/file/git installs
  are never replaced.
- Report, dispatch and plan loader entries now preserve `inject: ['tools']`.
  Cordis waits for the provider instead of silently dropping registrations.
- Model tools register `execute(args, exec)` and render content from the output
  value (the second render argument), matching Harness's actual registry API.
  Registration failures now reject activation rather than populate a misleading
  self-test report. Optional commands are probed through `ctx.get()`.
- Raw tool registrations now validate required fields, primitive types and enums
  before invoking proposal handlers. Harness applies the strict argument wrapper
  to `defineTool()`, not arbitrary raw `register()` definitions; the real pipeline
  negative control caught missing decision arguments previously being accepted.
- The folded lead's host row registers no global model tools; retained preset
  slices own them, so workers cannot inherit lead-only dispatch/planning tools.

### Verification

- Source and folded entries have real Cordis lifecycle regression coverage.
- Installer `--check`, upgrade cleanup and `--uninstall --dry-run` are covered
  by a no-network integration test; semver ordering, registry-only auto-update,
  interval caching and profile discovery are unit-tested.
- `node scripts/verify-tool-runtime.mjs <unpacked-runtime-dir>` asserts the
  shipped lead exposes exactly one selectable preset, then mounts all 26 role
  compositions using real Harness registries, checks 7/3 scoped SDLC tools, and
  exercises the actual tool execution pipeline plus worker-visibility and
  invalid-input negative controls. OS/delegation boundaries are explicitly
  stubbed; no server, subprocess or model is started. An optional second
  argument selects an unpacked plugin tarball to verify the ship artifact.
- The reported `never started` diagnostic specifically means import/pre-fiber
  failure. The public beta.22 tarball imports successfully in isolation; the
  original failed installation's initial loader log is still needed to identify
  that exact failure. These repairs address independently reproduced API bugs,
  not a claimed reproduction of the missing-fiber failure.

## [0.4.0-beta.22] — `npx` installer stops pulling the whole DSH runtime

### Fixed

- `npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install` made npm
  auto-install the package's `@deepseek-ai/dsh` peer — the entire ~500 MB
  runtime — before the installer could run (observed as `ENOSPC` on a tmpfs).
  The meta-bundle now marks that peer **optional for package managers** via
  `peerDependenciesMeta`. DSH still enforces the same peer range when it loads
  the plugin (`evaluatePluginCompatibility` reads `peerDependencies`, not the
  meta field); only npm/npx's automatic peer installation is disabled.

## [0.4.0-beta.21] — presets proven live; registry install takes the latest build

### Added

- **`dsh-sdlc-install`: one command that always installs the published
  `latest`.** Ships as a bin in `@patwoodman/dsh-sdlc-flow`:
  `npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install`. It resolves the
  version from the npm registry itself, pins it exactly, creates the profile
  when missing, installs with `dsh plugin add`, re-selects the bundle (a failed
  uninstall can leave it installed-but-disabled), and verifies the installed
  `package.json`. `--only all` also provisions the worker and probe profiles;
  `--tag beta` and `--version` are available. This removes the Desktop
  Add-plugin field's dependence on pnpm's release-age resolution when a fresh
  beta is involved.
- **A live preset regression gate.** `verify-publish.mjs` now boots the packed
  lead on an ephemeral port, authenticates with its launch token, and creates a
  real `sdlc-lead` session through `session/create` — the exact path a new
  session takes. beta.19 passed every static preset test, `--dump-config`, the
  M0 probe and `SDLC_SELFTEST`, then failed here with `tool-todo ... invalid
  config` / `never started`. A pre-publish failure now names the registry's
  diagnostic instead of stranding users.

### Fixed

- **A malformed pnpm release-age exemption silently installed the previous
  beta.** `minimumReleaseAgeExclude: ['pkg@a || pkg@b']` is not a valid pnpm
  pattern; pnpm ignores it, so beta.20 stayed invisible to `latest` and the
  plugin manager kept installing beta.19. The installer rewrites combined
  entries into one item per pattern (carrying the package name onto a bare
  version), preserves unrelated settings, deduplicates and sorts, and is
  idempotent.
- **README install instructions now match the shipped path.** One command
  (`npx … dsh-sdlc-install`), exact-pin plus per-item exemption for a manual
  install, and an explicit "quit the app completely before reopening" warning —
  a running lead keeps the old module tree in memory even after the package on
  disk changes.

## [0.4.0-beta.20] — presets mount on DSH 0.2.0-rc.2; uninstall no longer blocks

### Fixed

- **New sessions failed with `agent-preset invalid` and never started the SDLC
  tools.** DSH 0.2.0-rc.2 made two tool config values required: the preset
  mounted `tool-todo` without `allowParallelInProgress` and `tool-subagent`
  without `provider`. Separately, the three SDLC preset rows named the tools
  package ROOT, which exports data but no `apply`, so the same mount also
  reported `sdlc-report`, `sdlc-dispatch` and `sdlc-plan` as `never started`.
  Every preset now sets `allowParallelInProgress` explicitly (workers `false`,
  Lead `true` because it fans work out to children), the Lead's delegation row
  sets `provider: spawn`, `toolName: subagent` and `backgroundMode: continuable`,
  and the three SDLC rows name real loader subpaths (`./report`, `./dispatch`,
  `./plan`) that register only their role's tools and never the command
  surface. `gen-presets` carries all of it into the generated patch. New tests
  pin the required configs and the slice entry points on all 26 presets and on
  the generated artifact.
- **Uninstall was blocked by `agent-preset-registry`.** The lead meta-bundle
  inserted a second `agent-preset-registry` row on the web template. The loader
  accepted the duplicate, but the plugin manager's uninstall audit matches live
  loader rows by id+name: after the bundle was disabled, the shipped row still
  matched the bundle's contribution and the manager returned `bundle-in-use`.
  The lead patch now overrides the shipped row's default to `sdlc-lead`; only
  the member presets patch — used by headless/sdk profiles that ship no
  registry — still inserts it. A contract test pins the override and forbids
  the duplicate in the lead patch.

## [0.4.0-beta.19] — folded runtime siblings ship; Desktop activation fixed

### Fixed

- **Enabling the npm-installed bundle failed with ENOENT on Desktop.** The
  folded `presets` plugin's `declaredPresetIds()` reads
  `new URL('../cordis.patch.yml', import.meta.url)`, i.e.
  `lib/rows/presets/cordis.patch.yml` after the fold. `fold-meta` copied only
  `lib/` and wrote a stub `package.json`, so a source checkout passed while
  every packed install (beta.13 through beta.17) threw
  `ENOENT: …/dsh-sdlc-flow/lib/rows/presets/cordis.patch.yml` when the loader
  activated the bundle. Folded members now carry the runtime siblings their
  code resolves relatively (`cordis.patch.yml`, `locale/`, `schema/`,
  `icon.svg`).
- **The fold can no longer ship without them silently.** `fold-meta.mjs`
  asserts every expected sibling travelled, `publish-shape.test.mjs` pins the
  folded tree and imports the folded presets plugin (26 ids, no ENOENT), and
  `verify-publish.mjs` asserts the packed meta tarball contains
  `lib/rows/presets/cordis.patch.yml` and `lib/rows/presets/locale/en.json`.

### Changed

- **A prerelease `latest` now advances with the beta.** `latest` was still
  beta.13, so a plain `dsh plugin add @patwoodman/dsh-sdlc-flow` (the Desktop
  Add-plugin field, which omits a tag) resolved to an older, broken beta. When
  the current `latest` is itself a prerelease, the Release moves it to the new
  build; a stable `latest` is never moved backwards. `beta` still tracks the
  newest prerelease.
- `0.4.0-beta.18` was tagged but cancelled before publishing; this build
  supersedes it with the actual fix.

## [0.4.0-beta.17] — publish safety: a broken tree can no longer reach npm

### Added

- **CI `install-smoke` job: the two real install paths, from scratch.**
  Builds the no-clone tarball and (1) installs it via `./install.sh` into a
  fresh `DSH_HOME` and runs `doctor`, then (2) `npm pack`s every member and
  asserts the packed shape — no `src/` in any tarball, every loader entry
  (`lib/index.js`, `plugin.js`, `roles.js`, `cli.mjs`, `client.js`) provided
  by its owning package. Would have caught the beta.10 prepack-ENOENT class
  and the unfolded-fold class before any tag.
- **`scripts/verify-publish.mjs`: pre-publish proof on the ship artifact.**
  Packs every member with `--ignore-scripts` (exactly what Release
  publishes), asserts packed shape, installs the tarballs with
  `dsh plugin add file:<tgz>` (registry-shape, no `link:`) into scratch
  profiles, and boots the packed probe via `SDLC_SELFTEST` (7 tools,
  20 commands, 9 services, 26 presets). Runs in Release between the gates
  and the publish; any failure refuses to publish.
- **Release waits for CI green on the tagged commit.** A `wait for CI green`
  step polls the CI workflow's conclusion for `GITHUB_SHA` (up to 40 min)
  and fails closed on any non-success — a tag pushed on a red tree waits
  instead of publishing.
- **npm provenance + post-publish verification.** Publishes with
  `--provenance` (sigstore-tied to this repo + workflow) and re-reads every
  published version from the registry after the loop; a half-published
  version fails loudly instead of stranding users.

### Fixed

- **Tarball installs failed with `failed to import` (no workspace links).**
  Member `lib/` files import each other through bare specifiers, which
  resolve via the workspace `node_modules` links — but a no-clone tarball
  ships no `node_modules`, and nothing created the links. The build
  pipeline now starts with `link-workspace.mjs`. Caught by the new
  `install-smoke` job before any user hit it.
- **Smoke `doctor` failed on sandbox absences, not product regressions.**
  A clean runner has no provider credentials and the unpack dir is not a
  git repo — `doctor` now takes `--allow-no-credentials` / `--allow-no-repo`
  (demote exactly those two environment checks to warnings), and the smoke
  asserts the M0 gate directly.
- **Smoke pack-shape check died on SIGPIPE.** `tar tzf | grep -q` lets grep
  exit on first match, killing tar under `pipefail`. Each tarball is now
  listed to a file before grepping.

## [0.4.0-beta.15] — rebuilds preserve the fold; M0-11 reports instead of crashing

### Fixed

- **The installer built twice and the second build deleted the fold.**
  `install-local.mjs` ran the full pipeline (build → fold → gen) and then
  a *second* bare `build.mjs` + `build-ui.mjs` after it. `build.mjs` wipes
  `lib/` wholesale, so the second pass deleted the just-folded `lib/rows/`
  tree while the patch still named the folded aliases — M0-11 failed with
  `services` / `tools-plugin` / `presets-plugin` / `ui` unresolvable on any
  machine that built from scratch (including every fresh `install-local`
  run). Collapsed to a single ordered pipeline: build once, fold once,
  generate last.
- **`build.mjs` now preserves `lib/rows/` across bare rebuilds.** The
  meta-bundle's folded member tree is backed up before the `lib/` wipe and
  restored after the `src/` mirror (package name manifest-derived, so
  renames cannot desynchronise the rule). Any bare rebuild — CI, a second
  install run, `npm run build` — keeps the fold intact.
- **M0-11 crashed instead of reporting.** `validateProfileStatic` returns
  `{ ok, problems, composition }` with no `profile` field, so the failure
  path died with `Cannot read properties of undefined (reading 'name')`
  and hid the unresolvable rows. It now labels via
  `composition.profile ?? profile.name`.

## [0.4.0-beta.13] — CI green for the first time since the fold

### Fixed

- **Every `dsh plugin add` failed on CI with `ERR_PNPM_ADDING_TO_ROOT`.**
  Root cause, finally nailed with a real pnpm 9.12.0 (not the shim that
  silently redirects to v12): pnpm 9 refuses *any* add whose cwd is a
  workspace root, with no multi-pattern exception — and DSH writes a
  single-pattern workspace (`packages: ['.']`) into every profile, so the
  profile *is* its own workspace root. pnpm 10+ only refuses multi-pattern
  roots, which is why every local machine (pnp shim → v12 binary) passed
  while CI (pinned pnpm 9.12.0 via `packageManager`) failed all 38 runs
  since the beta.9 fold. The installer now forwards
  `--ignore-workspace-root-check` to the profile-local pnpm (a no-op on
  pnpm 10+). All five CI jobs pass: unit, gate-platform, gate-m0, gates
  (M1–M8), e2e.
- **CI `gate-m0` never linked the workspace before installing.** The
  `gate-m0`, `gates`, and `e2e` jobs missed the `link-workspace.mjs` step
  the `unit` job had since beta.6, so `lib/` bare cross-package imports
  had no `node_modules` entries and the live boot probe failed its member
  imports (M0-03/M0-04/M0-12). All three jobs now link first.

## [0.4.0-beta.12] — CI installs from a clean tree; npm first-publish diagnosis

### Fixed

- **CI `gate-m0` failed on every fresh checkout while passing locally.** The
  `gate-m0` (and `gates`, `e2e`) jobs never ran `node
  scripts/link-workspace.mjs`, so `lib/`'s bare cross-package imports
  (`@patwoodman/dsh-sdlc-flow-guard` from core, `…-core` from tools) had no
  `node_modules` entries. The linked member deps then failed their imports in
  the live boot probe (`M0-03` tools, `M0-04` commands, `M0-12` selftest),
  even though every offline test passed — the `unit` job already had the
  link step since beta.6. All three jobs now link the workspace before
  building, matching the Release workflow.

## [0.4.0-beta.11] — renamed to `dsh-sdlc-flow`

### Changed

- **The suite is no longer "orchestrator".** Every package moved from
  `@patwoodman/orchestrator*` to `@patwoodman/dsh-sdlc-flow*` — the lead is now
  `@patwoodman/dsh-sdlc-flow`, with `-core`, `-tools`, `-presets`, `-ui`,
  `-guard`, and `-cli` members. Display titles in the Plugin Manager read
  "DSH SDLC Flow" / "SDLC Dashboard" instead of the generic "SDLC Orchestrator".
  The old `@patwoodman/orchestrator*` names stay on npm at `0.4.0-beta.9` and
  below; `beta.11` is the first release under the new names, so there is no
  upgrade path to migrate — install the new spec:
  `dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow`.
- **Name-derived script constants are manifest-derived.** `doctor`,
  `validate-m0`, and the composition helpers used to append hardcoded
  `orchestrator*` suffixes to the scope prefix; they now read member basenames
  from the workspace manifests, so the next rename cannot desynchronise them
  the way the bulk rename initially did (caught before commit: E6 worker-guard
  check, M0 self-package list, doctor's required-bundle list).

### Fixed

- **`publish-shape` test contradicted the beta.10 publish fix.** It still
  asserted every package ships `prepack`/`prepare` rebuild hooks — the exact
  hooks beta.10 removed because npm's pack stages only `files` and the rebuild
  died with `ENOENT`, leaving `core`, `guard`, and `ui` unpublished. The test
  now pins the absence of lifecycle rebuilds, so a reintroduced hook fails
  loudly instead of silently stranding worker-profile packages on an old beta.

## [0.4.0-beta.10] — the worker packages actually publish

### Fixed

- **`npm publish` of `core`, `guard`, and `ui` died inside `prepack`.** Every
  member's `prepack`/`prepare` ran `node ./build.cjs`, which rebuilds `lib/`
  from `src/`. npm's pack only stages the `files` list (`lib/`, not `src/` or
  `build.cjs`), so the lifecycle script exited `ENOENT` and those three
  packages never reached the registry — the `0.4.0-beta.9` release published
  the lead, tools, presets, and cli, and silently left the worker profile's
  packages on `0.4.0-beta.7`. Lifecycle rebuild scripts are gone (the
  workspace `build` script already produces `lib/` before publish) and the
  Release workflow publishes with `--ignore-scripts`.

## [0.4.0-beta.9] — the sidebar tab actually mounts

> `0.4.0-beta.8` never reached npm. The Release workflow failed its unit job
> (the Cordis activation test required a vendored runtime that exists only on
> this machine), so the `beta` dist-tag stayed on `0.4.0-beta.7`. This release
> includes everything from beta.8 plus the client-tab fix below.

### Fixed

- **The SDLC sidebar tab never mounted.** The browser loader runs a client
  factory's return value through the same Cordis `unwrapExports` the host uses
  (`exports.default ?? exports`, and again when the winner is an ESM
  namespace). `scripts/build-ui.mjs` assigned `exports.apply` and
  `exports.inject` and never set `exports.default`, so the moment the loader
  preferred `.default` the plugin became `undefined` (or, with a bare-function
  default, lost `inject`). Either way the tab waits forever for
  `slots` / `locale` / `sidebarRight` and the panel never appears — the
  failure mode of every published build through beta.7. The factory now sets
  `exports.default` to `{ apply, inject }`, so both branches of
  `unwrapExports` keep the service list. `tests/unit/ui-bundle.test.mjs` and
  the client half of `plugin-entry-contract.test.mjs` evaluate the shipped
  bundle and assert the unwrapped plugin still carries `inject`.

## [0.4.0-beta.8] — the UI row activates, and one package means one uninstall

> Published `0.4.0-beta.7` was tagged before these fixes landed — the npm tarball
> still fails to activate the `sdlc-ui` row. These fixes first ship in
> `0.4.0-beta.8` (dist-tag `beta`).

### Added

- **The lead installs and uninstalls as ONE package (`@patwoodman/dsh-sdlc-flow`).**
  Previously the profile carried the meta-bundle plus four member dependencies, so a
  plugin-manager uninstall left four ghost `@patwoodman/*` entries behind and removing a
  member first was refused ("still required by @patwoodman/dsh-sdlc-flow") — the uninstall
  reports from beta testers. The whole dependency closure (core→guard, tools→core,
  ui→cli — six packages) is now folded into the meta-bundle under `lib/rows/`: every
  patch row resolves through the meta's own exports (`@patwoodman/dsh-sdlc-flow/services`,
  `…/tools-plugin`, `…/presets-plugin`, `…/ui`), cross-member imports inside the folded
  code are rewritten to relative paths, the browser bundle travels with its `dsh.client`
  manifest under `./client` with its module id rewritten to the serving package, and the
  meta declares **no member dependencies**. One install, one remove button, nothing left
  behind. `install-local.mjs` drops the member ghosts from older profiles on upgrade and
  pins the one-package property as a verify step. The worker/probe profiles keep mounting
  guard/tools/core as separate bundles (E6) — those packages stay published for CLI
  profiles; they are simply no longer pulled into the lead.

### Fixed

- **The `sdlc-ui` row failed to activate with `cannot get property "connection" without inject`.**
  The host plugin read `ctx.connection` inside `registerRoutes` without declaring the service, so
  the Cordis context proxy refused the read at activation (a service-injection issue, not an
  import one — the other 12 rows activated and the selftest counts were complete). The plugin now
  declares `inject = ['connection']` (the deliverables-plugin pattern the row already claimed to
  follow) and the entry re-exports it: the loader reads `plugin.inject` from the entry namespace
  when it activates the row, holds the fiber until the connection service exists, and puts the
  implementation in the fiber's store. `scripts/build-ui.mjs` emits the re-export into the
  generated `lib/index.js` the loader imports.

  A named `inject` export is not sufficient while the module also `export default apply`s.
  `Loader.unwrapExports` prefers `.default`, and a function has no `.inject`, so the fiber still
  starts with an empty dependency map and dies at the same line in `registerRoutes`. Every
  loader-facing entry now exports `apply` (and `inject`, where it reads a host service) as named
  bindings only. Verified against the real Cordis runtime: the bare function fails with exactly
  the reported error (fiber state 3); the namespace plugin activates and all seven routes register.
  `tests/unit/plugin-entry-contract.test.mjs` boots that runtime, so a default export or a dropped
  `inject` fails the suite instead of shipping.

- **Route registration is now effect-scoped (`ctx.effect`).** The connection refuses a second
  registration of the same exact path (`exact Fetch route … is already registered`), so the bare
  registrations would have leaked across a bundle/config restart and — through the warn-only
  fallback — silently dropped every route after the first reload. Registrations now ride the
  fiber's effects (the session-controller pattern), so a restart disposes the routes before
  `apply` runs again. Plain contexts (unit tests, import-without-host) still register directly.

- **The UI's selftest contribution was dead code.** `require('@patwoodman/dsh-sdlc-flow-core/selftest.js')`
  used a `.js`-suffixed subpath, but core's exports map (`"./*": "./lib/*.js"`) resolves that to
  `lib/selftest.js.js`, so the require never resolved and the catch hid it — no `sdlc_ui_routes`
  contribution and no version metadata ever reached the boot-hook report, in any environment. The
  stem form (`/selftest`) resolves; and when `SDLC_SELFTEST` is set while the helper still fails
  to load, the UI now warns through `ctx.logger` instead of failing invisibly (the never-fabricate
  rule cuts both ways).

- **Every loader-facing `apply()` now returns nothing.** Verified against the real Cordis runtime:
  the runner interprets a plugin's return value as an effect — a plain object is fatal for a
  non-constructible apply (`TypeError: Invalid effect`, the row never activates), and for the
  regular-function applies this suite ships, both object returns and disposer returns are silently
  swallowed by the construct-as-class path. All seven bundle entries return void; the registration
  reports the tests consume come from the named helpers (`registerRoutes`,
  `registerTools`/`registerCommands`, `declaredPresetIds`, `getRuntime`, `installGuard`), and
  `tests/unit/plugin-entry-contract.test.mjs` pins the contract for every composed row so a
  refactor cannot turn it back into a dead row.

- **The shipped client bundle had an unbound `api` reference.** The closure-factory bundler strips
  import lines, but `client/index.js` used a DEFAULT import (`import api from './api.js'`) and
  api.js declared its face as `export default {…}` — both stripped, leaving `api` undeclared, so
  the client `apply` crashed with `ReferenceError: api is not defined` the moment the web loader
  activated the tab. api.js now exports the face as `export const api` (resolved lexically in the
  concatenated scope), and the bundler fails the build on default imports instead of shipping an
  unbound reference. The entry contract test drives the shipped bundle's `apply` end-to-end, and
  `ui-bundle.test.mjs` evaluates the factory the way the web module table does.

## [0.4.0-beta.6] — published packages actually import

**Install:** `dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow` —
now resolves and boots. Or the tarball path (unchanged).

### Fixed

- **Published packages could not be imported.** Seven cross-package imports in
  `src/` pointed at sibling source files (`../../sdlc-guard/src/index.js`,
  `../../../sdlc-core/src/config.js` …). That worked inside the monorepo (where
  the packages sit next to each other) and in a `link:` install, but a package
  installed from npm has no `../sdlc-*/src/` directory — every row except the
  presets failed with `ERR_MODULE_NOT_FOUND`, so the lead composed 223 rows and
  12 of 13 plugins refused to activate. `build.mjs` and `build-ui.mjs` now rewrite
  cross-package relative imports to bare npm specifiers (`@patwoodman/dsh-sdlc-flow-guard`,
  `@patwoodman/dsh-sdlc-flow-core/config`, …) when building `lib/`. The `src/`
  tree keeps relative imports so tests see one module instance and `instanceof`
  works across packages. A contract test asserts every built `lib/` file has no
  remaining cross-package relative imports.

- **The `0.0.0-stage` artifact.** npm's new staged-publish flow (npm 12 / the
  registry's 202-accept pipeline) creates a placeholder version the first time
  a scope publishes. It is invisible to `latest`/`beta` dist-tags and installs
  resolve to `0.4.0-beta.6` as expected, but it clutters the version list. The
  placeholder cannot be removed (npm does not allow version deletion).

## [0.4.0-beta.3] — first public release (2026-10-11)

The first tag that actually publishes. Everything below the fold was written
before the tree had ever been pushed, so the release path itself had never run.

**Install (no clone, no build):**

```sh
curl -fsSLO https://github.com/pwoodman/dsh-sdlc/releases/latest/download/dsh-sdlc-beta.tgz
tar xzf dsh-sdlc-beta.tgz && cd dsh-sdlc-*/ && ./install.sh
```

### Fixed (release path — found by running it for real)

- **The GitHub Release was marked `prerelease: true`, which made the documented
  install URL 404.** `releases/latest` skips prereleases, so
  `/releases/latest/download/dsh-sdlc-beta.tgz` answered 404 while
  `/releases/download/v0.4.0-beta.2/...` answered 200 — every tester following
  the README would have hit the 404. The stable alias URL is the whole point of
  the artifact, so the Release is published with `prerelease: false`; the version
  string already says `beta`, and npm keeps its own `beta` dist-tag.
- **`pnpm/action-setup@v4` aborted before any build step.** Supplying both
  `version: 9` and `package.json`'s `packageManager: pnpm@9.12.0` makes the action
  fail with "Multiple versions of pnpm specified"; the input is gone from both
  workflows and the pinned `packageManager` wins.
- **Gate M8-05 read `fail=?` from a green 553-test suite and blocked the
  release.** The gate matched only Node's `ℹ pass 553` reporter shape; the GitHub
  runner prints the plain `# pass 553` form, so no count matched and the gate
  declared failure. `summaryOf()` in `scripts/lib/harness.mjs` accepts both shapes
  (and ANSI colour), returns `null` — never zeros — when a run printed no summary,
  and is now used by M8 (01 and 05) and the coverage gate.
  `tests/unit/runner-summary.test.mjs` pins it. Both M8 sub-checks also write
  their full output to `.validation/` and name the failing test, instead of the
  truncated excerpt that made the first two failures undiagnosable from CI.
- **`npm test` failed on the release runner's Node 22.** A zstd unit test
  asserted that a whole-buffer `zstdDecompressSync` returns only the first frame;
  that is Node 22/24 behaviour, while Node 26 keeps decoding. The test now pins
  what is guaranteed (a whole-buffer decode is not a concatenation-safe reader;
  `splitZstdFrames` reconstructs the log) and passes on both.
- **The installer accepted a `dsh` that cannot work.** A wrapper that answers
  `dsh --version` — the common `npx @deepseek-ai/dsh` shim, a shell function, a
  hand-written script — has no package directory, so `PLAT-08` failed *after* the
  bundles were installed with a message about shutdown templates that named no
  cause. A preflight step now resolves `dsh` to an installed
  `@deepseek-ai/dsh` package and fails up front with the fix
  (`npm install -g @deepseek-ai/dsh@0.2.0-rc.2`).
- **The npm publish step would have moved `latest` onto a beta.** It published
  with the default dist-tag; a prerelease version now publishes under `beta` and
  only a stable version moves `latest`.


- `scripts/set-repository.mjs` (`npm run set-repository`): fills
  `repository.url`/`homepage`/`bugs` in every manifest — they carried `type: git`
  and a directory but no URL, which npm publishes as-is — and `--check` guards
  drift in `gen:check` and CI.
- **A live, verified install path.** `v0.4.0-beta.2` publishes the tarball on
  GitHub Releases and is rehearsed end to end from the public URL: download →
  `install.sh` → `dsh --profile sdlc-probe` reports 7 tools, 20 commands, 9
  services and 26 presets.
- **A re-install over an older scope composed every row twice.** The installer
  recognised its own entries in `dsh.profile.bundles` and `dependencies` by a
  literal `@patwoodman/` prefix. `scripts/set-scope.mjs` renames the whole suite
  in one pass, so a tree re-scoped from `@sdlc` still had the old scope selected
  in the profiles the previous install created: the loader mounted both layers,
  M0-02 failed with 39 duplicate row ids, and `dsh plugin add` failed outright
  because pnpm was asked to resolve a dead `@old-scope`/`link:` dependency. Both
  checks now derive ownership from the workspace manifests
  (`ownScope`/`ownBundlePrefix`/`isOwnBundleName` in `scripts/lib/composition.mjs`,
  covered by `tests/unit/composition-ownership.test.mjs`), so no rename can
  desynchronise them, and a **repair** step ahead of the preflight drops
  own-suite dependencies that no longer resolve (a missing link target, or a
  scope the tree no longer publishes) before pnpm ever sees them.
- **A moved checkout failed every install with `ERR_PNPM_UNEXPECTED_STORE`.**
  `node_modules/.modules.yaml` records the absolute pnpm store a profile was
  linked from; when that path no longer exists (the checkout moved, or a
  different `XDG_DATA_HOME`), pnpm aborts before installing anything and never
  repairs itself. The repair step now removes such a `node_modules` so the
  profile is re-linked from the current store — the same remedy `pnpm install`
  would demand, applied automatically.
- **The installer's step log truncated pnpm output mid-word** (`…ependencies
  from the target node_modules.`) because it sliced the last 200 characters of
  multi-line stdout. It now prints the last complete line.
- **The release tarball could ship any untracked directory in the tree.** The
  exclusions were a hand-kept list, so a new scratch `$DSH_HOME` doubled the
  artifact (0.7 → 1.4 MiB, 484 → 1034 entries) and would have travelled to every
  tester. `build-release.mjs` now takes its exclusions from `.gitignore` itself
  (`git status --ignored=matching`), keeping only the build output the artifact
  exists to carry (`packages/*/lib`, `lib`) — the list is a documented fallback
  for hosts without git.

### Fixed (source checkout — the beta.2 body of work)

**Install:** `npm run install:local` (one command, idempotent), or the registry
form `dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow` once published.
- **A fresh clone could not run anything.** `.gitignore` had a bare `lib/`
  pattern, which (in gitignore syntax) matches a directory named `lib` **at any
  depth**. It therefore excluded `scripts/lib/`, `tests/lib/` and `eval/lib/` —
  16 *source* files imported by every script and every test — so they were never
  committed. A clone had no `scripts/lib/harness.mjs`, and `install-local.mjs`,
  `doctor.mjs`, the gates and the whole test suite died with
  `ERR_MODULE_NOT_FOUND`. The patterns are now scoped to the package build
  directories (`/lib/`, `packages/*/lib/`, `/dist/`, `packages/*/dist/`) and the
  16 files are tracked.
- **`npm run build` failed on a clean checkout.** `scripts/build.mjs` wrote its
  `.validation/.build-stamp` without creating `.validation/` — which is
  gitignored and therefore absent in a fresh clone — and exited `ENOENT`. It now
  creates the directory first.
- **The documented one-spec lead install composed nothing.** The DSH loader
  mounts only the bundles listed in `dsh.profile.bundles` and loads each one's
  **own** `dsh.bundle.patch`; it never descends into a bundle's `dependencies`.
  `@patwoodman/dsh-sdlc-flow`'s patch declared only its own row, so
  `dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow` produced a single
  `sdlc-orchestrator` row and no services, tools, presets or UI. Its patch is now
  **generated** as the union of its four members'
  (`scripts/gen-bundle-patch.mjs`, checked in and verified by
  `gen:bundle-patch:check` in CI) and the members are installed into the lead as
  plain module dependencies, never as bundles. One spec now composes the full
  lead: 26 presets, the nine host services, the tools row and the UI row.
- **The static composition checks disagreed with the loader.** Both
  `scripts/lib/composition.mjs` and `tests/contract/cordis-patches.test.mjs`
  recursed into a meta-bundle's `dependencies`, so they reported a complete lead
  for a recipe that composed nothing live — a false *pass* on the gate whose job
  is to catch exactly that. They now model the loader: only listed bundles
  contribute rows.
- **`install-local.mjs` installed the wrong thing in two places.** The worker
  step passed bare paths where every other step used `link:` specs, and the probe
  step installed the UI into a headless `sdk` profile the recipe does not list.
  Both now install exactly the bundles `profiles/<recipe>/profile.json` declares
  (which also becomes the single source of truth for the profile templates), and
  the lead's verify step fails loudly if more than one sdlc bundle is selected,
  if a core row is missing, or if the preset count is not 26.
- A beta.1 lead profile selected the meta-bundle **and** its four members. That
  was harmless while the meta-bundle's patch held one row; now that the patch is
  the union of the members' rows it would compose every row twice. The installer
  re-selects only the recipe's bundles (keeping the members installed as
  dependencies) and `doctor` reports extra `@patwoodman/*` bundles as an error with the
  remedy.
- **The eval `collectAudit` unit test assumed npm exists.** It asserted the
  zero-vuln value unconditionally, so it failed on any host without npm (the
  Flatpak Desktop runtime ships pnpm and no npm) — even though `collectAudit`
  itself correctly fails closed with `npm is not installed`. The test now
  asserts which one applies, and `hasCommand` is exported from
  `eval/collect-artifacts.mjs` so the branch is explicit rather than assumed.
- **`npm test` / `npm run test:*` failed on Node 24.** Every test script passed a
  directory to `node --test`, which Node 24 resolves as a *script* and dies with
  `Cannot find module '<dir>'` (the beta.1 evidence was collected on Node 26,
  where directories do work). The scripts, `gate:M8`, the coverage collector and
  the demo gate now pass `'<layer>/**/*.test.mjs'` globs, which every supported
  engine accepts — `scripts/lib/harness.mjs` exports `testGlobs()` so the
  pattern lives in one place.
- **A re-install over an older scope composed every row twice.** The installer
  recognised its own entries in `dsh.profile.bundles` and `dependencies` by a
  literal `@patwoodman/` prefix. `scripts/set-scope.mjs` renames the whole suite
  in one pass, so a tree re-scoped from `@sdlc` still had the old scope selected
  in the profiles the previous install created: the loader mounted both layers,
  M0-02 failed with 39 duplicate row ids, and `dsh plugin add` failed outright
  because pnpm was asked to resolve a dead `@old-scope`/`link:` dependency. Both
  checks now derive ownership from the workspace manifests
  (`ownScope`/`ownBundlePrefix`/`isOwnBundleName` in `scripts/lib/composition.mjs`,
  covered by `tests/unit/composition-ownership.test.mjs`), so no rename can
  desynchronise them, and a **repair** step ahead of the preflight drops
  own-suite dependencies that no longer resolve (a missing link target, or a
  scope the tree no longer publishes) before pnpm ever sees them.
- **A moved checkout failed every install with `ERR_PNPM_UNEXPECTED_STORE`.**
  `node_modules/.modules.yaml` records the absolute pnpm store a profile was
  linked from; when that path no longer exists (the checkout moved, or a
  different `XDG_DATA_HOME`), pnpm aborts before installing anything and never
  repairs itself. The repair step now removes such a `node_modules` so the
  profile is re-linked from the current store — the same remedy `pnpm install`
  would demand, applied automatically.
- **The installer's step log truncated pnpm output mid-word** (`…ependencies
  from the target node_modules.`) because it sliced the last 200 characters of
  multi-line stdout. It now prints the last complete line.
- **The release tarball could ship any untracked directory in the tree.** The
  exclusions were a hand-kept list, so a new scratch `$DSH_HOME` doubled the
  artifact (0.7 → 1.4 MiB, 484 → 1034 entries) and would have travelled to every
  tester. `build-release.mjs` now takes its exclusions from `.gitignore` itself
  (`git status --ignored=matching`), keeping only the build output the artifact
  exists to carry (`packages/*/lib`, `lib`) — the list is a documented fallback
  for hosts without git.
- **The npm repository metadata was empty.** Every manifest carried
  `"repository": { "type": "git", "directory": … }` with no `url`, which npm
  publishes as-is: the registry page, `npm repo` and the provenance link all go
  nowhere. `scripts/set-repository.mjs` fills `repository.url`, `homepage` and
  `bugs` in one pass, `--check` guards drift in CI, and the value is the same for
  every package.

### Added

**Install:** `npm run install:local` (one command, idempotent), or the registry
form `dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow` once published.

- **A no-clone beta install.** `node scripts/build-release.mjs` produces
  `dist/dsh-sdlc-<version>.tgz` (+ a stable `dsh-sdlc-beta.tgz` alias): the whole
  tree with prebuilt `lib/`, the generated patches and an `install.sh` that copies
  itself to `$DSH_HOME/dsh-sdlc/<version>/` and runs the installer. A tester needs
  only `dsh`, `pnpm` and Node — no clone, no build, no npm account. The profiles
  link into that copy, which is also why the unpublished members resolve: pnpm
  does not resolve a linked package's dependencies.
- **A Release workflow** (`.github/workflows/release.yml`): on a `v*` tag it
  checks the tag against `package.json`, builds the tarball, runs the suite and
  every gate, publishes the GitHub Release with the tarball and install notes, and
  publishes the packages to npm when the `PUBLISH_NPM` variable is `true` and an
  `NPM_TOKEN` secret exists (dependency order, skipping versions already there).
- **`scripts/set-scope.mjs`** — one idempotent pass that re-scopes the suite
  (`@patwoodman/*` → `@your-username/*`) across package manifests, every
  `cordis.patch.yml` row, the profile recipes, the tests and the docs, with
  `--check` and `--restore`. Needed because a scope your npm account does not own
  makes `npm publish` answer 403 and `dsh plugin add @scope/…` unresolvable.
- `scripts/build-ui.mjs` now derives the browser factory id from the client
  package's manifest instead of repeating the string — DSH keys its client module
  table by that id, so a rename can no longer desynchronise them.
- `npm run release:build` and `npm run set-scope` shortcuts.
- `scripts/gen-bundle-patch.mjs` (+ `gen:bundle-patch`, `gen:check`) generating
  the meta-bundle's patch layer from its members, with `--check` for CI.
- Publish shape per the DSH cookbook (`cordis-plugin-development` →
  `references/host-plugin.md`): package-root `icon.svg` plus a `./icon` export, a
  per-package `README.md`, `./cordis.patch.yml` exports, `engines.node`,
  `publishConfig.access: "public"` (npm refuses to publish a scoped package
  without it), and a `prepare` script so git/GitHub and `file:` installs build
  `lib/` on the consumer's machine (`prepack` only covers `npm pack`/`publish`).
- Contract tests pinning the one-spec lead invariant, the generator/committed
  patch sync, the icon and README shape, and public access.

### Changed
- `README.md` install section now mirrors the reference plugins: a no-clone beta
  install from the release tarball, the npm scope setup, one spec from the
  registry (or the **Add plugin** wizard), the deliberately unpacked worker
  profile (E6), and the update command.
- `install-local.mjs` runs its generators by absolute path without `cwd`, so it
  also works when the checkout lives where `node` cannot `getcwd()` (containers,
  portal mounts) — which is how the release tarball is exercised.
- Two tests that quoted the package scope literally (one via a regex-escaped
  `@patwoodman\/`) now derive the name from the manifest, so a scope rename cannot
  leave them behind.
- `profiles/README.md` documents the real partition and the link-vs-bundle rule.
- Every package's `version` tracks the root (`0.4.0-beta.2`); the DSH peer is a
  bounded range, `>=0.2.0-rc.2 <0.3.0-0`, which DSH evaluates with
  `includePrerelease` — so `0.2.1-alpha.2` is admitted while the whole `0.3` line
  is excluded.

### Verification (this machine)
- **11/11 gates pass** (`P`, `M0`–`M8` live-boot, `Q` coverage) after a from-scratch
  install, including `gate:M8`'s full-suite and `gate:Q`'s coverage run.
- **684 tests: 683 pass, 0 fail, 1 skipped** (the by-design opt-in live test)
  across `unit`, `contract`, `integration`, `fault`, `adversarial`, `e2e`.
- One command on a pristine checkout (no `lib/`, no `.validation/`):
  profiles created, one lead bundle installed,
  `222 unique ids incl. 26 presets`, `M0 green`, exit 0.
- Live single-spec composition on `dsh 0.2.0-rc.2` from the `web` template:
  39 sdlc rows, `sdlc-ui` and `sdlc-tasks` present, only the loader-accepted
  `agent-preset-registry` x2.
- `doctor`: PASS (0 errors) on a configured host; its Profiles section reports
  `sdlc-web — 3 bundles` and `sdlc-worker — 4 bundles`.
- Environment note: the Flatpak Desktop runtime ships **pnpm but no npm** and
  Node 24.21; the harness therefore never shells out to npm and always passes
  globs rather than directories to `node --test`.

## [0.4.0-beta.1] — first beta

**Install:** `node scripts/install-local.mjs` from a source checkout into
`sdlc-web` (lead + UI), `sdlc-worker` (headless), `sdlc-probe` (boot probe).
Requires Node ≥ 22.5, `dsh` 0.2.0-rc.2, pnpm, and a POSIX host with git.

### Added
- `sdlc-client-ui` (`@patwoodman/dsh-sdlc-flow-ui`, `sdlc-web` only): SDLC
  right-sidebar tab with Status, Board, validated Config editor (8 fields),
  and side-by-side Review (time/tokens/tracepaths). Host routes
  (`/api/sdlc.status`, `/api/sdlc.board`, `/api/sdlc.task`,
  `/api/sdlc.compare`, `/api/sdlc.config` GET+POST, `/api/sdlc.metrics`)
  read the live `sdlc.db`; the browser bundle builds offline with zero
  dependencies (`node scripts/build-ui.mjs`, wired into `npm run build`).
- `@patwoodman/dsh-sdlc-flow` meta-bundle: the full lead (core+tools+presets+ui) in
  ONE install spec — `dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow`.
  `node scripts/install-local.mjs` is now a single command (profiles +
  bundles + M0 verify). Worker installs stay unpacked (guard+tools, E6).
- Publish-ready packages: MIT license, `locale/en.json`+`locale/zh.json`
  display metadata, per-package `build`/`prepack`, exact member pins in the
  meta-bundle. (`sdlc-mock-llm` stays private — test-only, never published.)
- `sdlc debug compare|trace`: side-by-side run anatomy (wall-clock, tokens,
  cost estimate, gates, state-machine trace path) as markdown + JSON
  (`SIDEBYSIDE.md`), available in every mode including headless.
- `observability.metricsExport`: renders `.sdlc/metrics.prom` in Prometheus
  exposition format (`sdlc status --metrics`, `Runtime.exportMetrics()`).
- `demo/`: zero-dependency fullstack task-tracker (API + frontend) proving
  the plan → execute → verify → review loop end-to-end offline
  (`node scripts/demo-run.mjs`: first attempt fails `unit`, retry passes and
  is ACCEPTED, then renders the side-by-side review).

### Fixed
- Live M0 composition findings: presets `apply()` never ran at boot (added
  the `sdlc-presets` self-report row — probe now reports 26/26 presets);
  `agent-preset-registry` duplication on the web template is loader-accepted
  and pinned by M0-02 instead of banned.
- `SERVICE_METHODS` single-source facade table (was declared twice).
- `dump-config`-only runs no longer trigger the boot-hook report path.

### Verification (this machine)
- 11/11 gates pass (P, M0–M8 live-boot, Q coverage).
- 662/662 unit+contract+integration+fault+adversarial; 9/10 e2e (1 skip by
  design); 86/86 eval harness; 6/6 demo.
- `doctor`: PASS (0 errors, 0 warnings).

### Known beta limitations
- No confirmatory A/B evidence yet: the eval harness is implemented and
  tested offline, but the live study (n=5–10, placebo arm, pinned toolchain,
  blinded jury) has not run. No "plugin beats plain DSH" claim is supported.
- Playwright browser execution is unexercised here; the no-browser-stack
  BLOCK policy is asserted instead (L.5).
- Windows is excluded through M8 (POSIX signals, `O_EXCL`, worktree paths).
- Cost is always an estimate (no provider currency metadata exists, E9).
- The guard is policy, not a security boundary (adversarial suite asserts
  the documented misses and the diff-based backstop).
- Packages are `private: true` — install is from source only in beta.1.
