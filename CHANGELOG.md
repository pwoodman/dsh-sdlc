# Changelog — dsh-plugin-sdlc

All notable changes to the Universal SDLC Orchestrator plugin suite.

## [0.4.0-beta.2] — install works from a fresh clone, one spec for the lead

**Install:** `npm run install:local` (one command, idempotent), or the registry
form `dsh plugin --profile sdlc-web add @patwoodman/orchestrator` once published.

### Fixed
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
  `@patwoodman/orchestrator`'s patch declared only its own row, so
  `dsh plugin --profile sdlc-web add @patwoodman/orchestrator` produced a single
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
- `sdlc-client-ui` (`@patwoodman/orchestrator-ui`, `sdlc-web` only): SDLC
  right-sidebar tab with Status, Board, validated Config editor (8 fields),
  and side-by-side Review (time/tokens/tracepaths). Host routes
  (`/api/sdlc.status`, `/api/sdlc.board`, `/api/sdlc.task`,
  `/api/sdlc.compare`, `/api/sdlc.config` GET+POST, `/api/sdlc.metrics`)
  read the live `sdlc.db`; the browser bundle builds offline with zero
  dependencies (`node scripts/build-ui.mjs`, wired into `npm run build`).
- `@patwoodman/orchestrator` meta-bundle: the full lead (core+tools+presets+ui) in
  ONE install spec — `dsh plugin --profile sdlc-web add @patwoodman/orchestrator`.
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
