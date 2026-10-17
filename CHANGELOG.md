# Changelog — dsh-sdlc-flow

All notable changes to the DSH SDLC Flow plugin suite.

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
