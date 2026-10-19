# dsh-sdlc-flow — DSH SDLC Flow (DeepSeek Harness plugin suite)

> **Current beta: 0.4.0-beta.25.** Install from this checkout
> (`npm run install:local`), or the registry form
> (`npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install`) — see
> [Install](#install). See [CHANGELOG.md](CHANGELOG.md) for scope and known
> limitations and [PROOF_REPORT.md](PROOF_REPORT.md) for measured evidence. No
> confirmatory developer-productivity claim is supported yet.

A DeepSeek Harness plugin suite that turns a requirement into a verified,
merged change: it plans a task DAG, dispatches role-preset workers into isolated
git worktrees, verifies against risk-appropriate gates, and integrates.

**Implemented from** [`universal_sdlc_orchestrator_dsh_spec_v3.md`](universal_sdlc_orchestrator_dsh_spec_v3.md).

| Document | What it is |
|---|---|
| [universal_sdlc_orchestrator_dsh_spec_v3.md](universal_sdlc_orchestrator_dsh_spec_v3.md) | the normative specification |
| [SDLC_V3_IMPLEMENTATION_VALIDATION_REPORT.md](SDLC_V3_IMPLEMENTATION_VALIDATION_REPORT.md) | gate results, test pyramid, defects found |
| [SDLC_IMPLEMENTATION_NOTES.md](SDLC_IMPLEMENTATION_NOTES.md) | deviations D0–D7, fixes, what is not implemented |
| [EVAL_PROTOCOL.md](EVAL_PROTOCOL.md) | pre-registered A/B design proving the plugin beats plain DSH |
| [IMPROVEMENT_AUDIT.md](IMPROVEMENT_AUDIT.md) | honest audit: what was fixed, measured, or deliberately left |

## Tool startup troubleshooting

The source checkout contains unreleased tool-lifecycle repairs; reinstalling
`@latest` does not fetch these changes until a new release is published. Desktop
users can install the rebuilt `packages/sdlc-orchestrator` directory through
**Plugins → Add plugin** using its absolute path, then quit Harness completely
and reopen it. Do not edit the Desktop profile by hand. Once this build is
installed, later registry releases are checked on startup: stable builds install
automatically, prerelease builds report availability (`SDLC_AUTO_UPDATE=install`
opts in; `off` disables). Restart to load the new code.

For an offline runtime check (no model and no second web server):

```sh
node scripts/verify-tool-runtime.mjs /path/to/unpacked/dsh-runtime
```

It mounts all 26 role compositions and checks tool visibility, real pipeline
execution/rendering, invalid arguments, and worker denial of lead capabilities.
It also asserts that the shipped lead exposes one selectable preset (the Lead
Orchestrator), not the whole role roster. OS/delegation boundaries are stubbed:
this does not test running workers or the Desktop session-creation UI. An
optional second argument points to an unpacked plugin tarball.
A `never started` diagnostic means the loader did not create a plugin fiber;
look for the **earlier loader import error** in the application log. A missing
service instead reports `waiting for tools`. If the former persists after a
clean restart/install, include that earlier error and the installed version.

## Quick start

```sh
npm run build                     # artifacts (zero dependencies, offline; incl. UI bundle)
node scripts/validate-gates.mjs   # gate:P → gate:Q  (no model, no network)
npm run test:unit                 # L2 — pure modules + property tests
```

Every `test:*` script passes explicit globs rather than a directory: Node 24
resolves a bare directory positional as a *script* and fails with
`Cannot find module '<dir>'`, while globs work on every supported engine.

The deterministic control plane needs no model at all:

```sh
node packages/sdlc-cli/bin/sdlc.mjs init        # .sdlc/, integration branch, detected gates
node packages/sdlc-cli/bin/sdlc.mjs status
node packages/sdlc-cli/bin/sdlc.mjs selftest --mock
```

## Flow visualizer (right sidebar)

While a session is open, the DSH right sidebar contains an **SDLC Flow** entry
(the guide's capsule, or auto-open on the first session that has an SDLC
project). It is a live, read-only view of the orchestrator:

- **DAG** — every task node with state, role, risk, routing tier/model, and
  dependency edges;
- **Subagents** — worker runs with role, model, status, pid, tokens and duration;
- **Routing** — tier, rule, provider/model and whether the decision was recorded
  or computed;
- **Gates** — pass/fail/skipped/unknown chips plus per-task detail;
- **Locks / escalations / events** — shared-resource holders, recorded and
  task-state escalations, and the latest 100 events.

It polls `/api/sdlc.flow` every 5 s; on a failed poll the last snapshot is shown
as *stale* rather than blanked. A 404 with no project is reported as such; a
bare 404 is reported as a host/client version mismatch with a restart and
reinstall hint (an in-place update does not replace loaded host code). Missing cost/tokens/duration stay `—` with a
reason, never `0`. Set `autoOpen: false` in the UI row config to stop the
automatic open. DSH's right sidebar has **no surface without a session**, so the
Start screen cannot show it — start a session first.

## Install

### One command — always the latest published version

```sh
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
```

This resolves `latest` from the npm registry itself, pins the **exact** version
in the `sdlc-web` profile, records the matching pnpm release-age exemption,
creates the profile when missing, prunes packages left by older releases,
installs, re-selects the bundle (a failed uninstall can leave the package
installed but disabled), and verifies the installed `package.json`. Re-running
it upgrades an existing install instead of requiring an uninstall first.

```sh
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all          # lead + worker + probe
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --tag beta          # newest prerelease
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --version 0.4.0-beta.25
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --check --json      # no changes
```

It is idempotent. Prerequisites: `dsh` and `pnpm` on `PATH`, Node ≥ 22.13.

> **Restart after installing.** A running lead keeps the old module tree in
> memory even after the package on disk changes (deep-imported preset rows are
> not hot-replaced). Quit DeepSeek Harness completely and reopen it; otherwise a
> new session can still report the previous version's `agent-preset/invalid`.
> The installer prints this reminder.

### Beta testers — no clone, no build

Download the release artifact and run its installer. Nothing is compiled on your
machine, and you do not need the source.

```sh
curl -fsSLO https://github.com/pwoodman/dsh-sdlc/releases/latest/download/dsh-sdlc-beta.tgz
tar xzf dsh-sdlc-beta.tgz && cd dsh-sdlc-*/
./install.sh
```

`install.sh` copies the plugin tree to `$DSH_HOME/dsh-sdlc/<version>/` (so you can
delete the download), then creates the `sdlc-web`, `sdlc-worker` and `sdlc-probe`
profiles, installs the bundles, verifies the composed lead and runs `gate:M0`. It
is idempotent — re-run it any time.

Prerequisites: `dsh` **installed as a package** (`npm install -g
@deepseek-ai/dsh@0.2.0-rc.2`), `pnpm` on `PATH`, Node ≥ 22.13. A wrapper that
merely answers `dsh --version` — an `npx @deepseek-ai/dsh` shim, a shell
function, a hand-written script — is not enough: the platform gate reads the
installed package's own files, and the installer now refuses that setup with
this reason instead of failing later inside `gate:M0`.

```sh
dsh --profile sdlc-web          # the interactive lead (web GUI)
```

### Uninstall — one click in the plugin manager

The lead installs exactly **one** package (`@patwoodman/dsh-sdlc-flow`; its
members are folded inside it), so removing that single entry in the plugin
manager removes everything — no ghost entries, nothing "still required". From
the CLI it is the same one spec:

```sh
dsh plugin --profile sdlc-web remove @patwoodman/dsh-sdlc-flow
```

A profile installed by a pre-fold release may still list the four members as
plain dependencies; re-run the installer (or this one command) to clear them:

```sh
pnpm remove --dir ~/.dsh/profiles/sdlc-web \
  @patwoodman/dsh-sdlc-flow-core @patwoodman/dsh-sdlc-flow-tools \
  @patwoodman/dsh-sdlc-flow-presets @patwoodman/dsh-sdlc-flow-ui
```

On Windows, close a running lead first (`sdlc.db` and the bundle files are held
open while it runs). A profile directory itself (`~/.dsh/profiles/sdlc-web`) is
disposable and can always be deleted outright. The `@deepseek-ai/…` bundles you
see running (for example `dsh-agent-preset-registry`) are DeepSeek Harness's
own — they ship with the profile template and are not part of this plugin.

### DeepSeek Harness Desktop — what works today

The Desktop app owns its `desktop` profile and the `dsh` CLI refuses to manage
it, so the CLI/tarball paths above do not target it. Desktop users install
through the sidebar **Plugins → Add plugin** dialog (paste a package name, a
tarball URL, or an absolute path).

Two honest limits on a Desktop-only machine:

- the lead dispatches workers by spawning `dsh --profile sdlc-worker`, so it
  needs a `dsh` CLI on `PATH` for real task execution — without one, the lead,
  the tools, the presets and the web panel all work, but dispatch does not;
- package installs into `desktop` are the app's own operation, so a plugin that
  needs the worker/probe profiles is better tested against CLI profiles.

### Registry / Add-plugin wizard — one spec for the lead

Once the packages are published under an npm scope you own, the lead is a single
spec (the same shape `dsh-context` and `dsh-proactive` use: prebuilt `lib/` + its
own `dsh.bundle.patch`, so the loader mounts it with no profile edits, no build
and no restart):

```sh
dsh --profile sdlc-web --from-default-profile web --dump-config   # create once
dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow              # core + tools + presets + ui
dsh --profile sdlc-web
```

Or fill `@patwoodman/dsh-sdlc-flow` into the **Add plugin** wizard on the Plugins page.

> **Fresh beta not installing?** pnpm 11 applies a 24-hour
> `minimumReleaseAge` to range and `latest` installs, so a beta published in the
> last day can resolve to the *previous* beta — this is how a known-broken
> beta.19 kept installing after beta.20 was already `latest`. Prefer the
> installer above; it pins the exact version and writes the exemption for you.
> For a manual install, pin it exactly
> (`@patwoodman/dsh-sdlc-flow@0.4.0-beta.25`) and add **one list item per
> pattern** to the profile's `pnpm-workspace.yaml`:
>
> ```yaml
> minimumReleaseAgeExclude:
>   - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.25'
> ```
>
> A combined value such as `pkg@a || pkg@b` is not a valid pnpm pattern (it is
> ignored, silently reintroducing the old resolution). The same applies to the
> worker members.

The worker profile is deliberately *unpacked*, because mounting the host services
there would start a second scheduler and a second writer against `sdlc.db`
(errata E6):

```sh
dsh plugin --profile sdlc-worker add @patwoodman/dsh-sdlc-flow-guard @patwoodman/dsh-sdlc-flow-tools
```

`@patwoodman/dsh-sdlc-flow`'s patch layer is generated from its four members
(`node scripts/gen-bundle-patch.mjs`) — the DSH loader mounts only the bundles a
profile lists and never descends into a bundle's `dependencies`. In the lead the
members are ordinary module dependencies; adding them as bundles *as well*
composes every row twice.

#### Publishing under your own npm scope

The packages ship as `@patwoodman/*`. If your npm account does not own that scope,
`npm publish` answers **403** and nobody can resolve `@patwoodman/dsh-sdlc-flow`. Fix it
in one command:

```sh
node scripts/set-scope.mjs @your-npm-username   # rewrites packages, patches, profiles, tests, docs
node scripts/set-scope.mjs @your-npm-username --check   # CI-safe drift check
```

An npm **user scope** (`@your-username`) is free and exists automatically once
you sign in to npm — `npm login` (GitHub OAuth works) or `npm adduser`. A free npm
**org** (`@acme-team`) works too: <https://www.npmjs.com/org/create>. Then:

```sh
git tag v0.4.0-beta.25 && git push origin v0.4.0-beta.25
```

The **Release** workflow verifies the tree, builds the tarball, publishes the
GitHub Release, and — when the repo has an `NPM_TOKEN` secret *and* the
`PUBLISH_NPM` variable is `true` — publishes the packages in dependency order.
Create the token at <https://www.npmjs.com/settings/~/tokens> (an *Automation*
token, so 2FA does not block CI) and add it as a repository secret.

### From a source checkout — one command

```sh
npm run install:local     # = node scripts/install-local.mjs
node scripts/doctor.mjs   # expect PASS
```

That single command generates the patches, builds the artifacts (zero
dependencies, offline), creates the three profiles from their shipped templates,
installs the bundles, verifies the composed lead and runs `gate:M0`. It is
idempotent and safe to re-run.

Prerequisites: `dsh` installed as a package (`npm install -g
@deepseek-ai/dsh@0.2.0-rc.2`), `pnpm` on `PATH`, Node ≥ 22.13, a POSIX host with
git.

### Building a release artifact

```sh
node scripts/build-release.mjs        # → dist/dsh-sdlc-<version>.tgz + dsh-sdlc-beta.tgz
```

### Update / upgrade

Re-running the installer is the upgrade path — it resolves the newest published
version, prunes packages left by older releases, and replaces the installed
meta-bundle:

```sh
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --check --json
```

The lead also checks the registry on startup (at most once per 24 hours).
Stable builds install a newer version through DSH's plugin manager; prerelease
builds only report availability by default (`SDLC_AUTO_UPDATE=install` opts in).
The running process keeps the old code until it is restarted; the update reports
`restart-required`. A failed install is retried after a short backoff, the
installed version is verified on disk, and a major release requires explicit
consent. Disable the check with `SDLC_AUTO_UPDATE=off`. Link, file, git and
source-checkout installs are never replaced automatically.

### Uninstall

Remove the package and its bundle selection from every managed profile:

```sh
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --uninstall --only all
```

The GUI path is unchanged: the lead profile contains exactly one own-scope
package, so **Plugins → Remove** removes everything. Profile directories are
left in place; delete them only if you also want to discard their config.

## Layout

```
packages/sdlc-core/      host services + pure domain modules (never in a worker)
packages/sdlc-guard/     worker-side policy (tools/pre-execute, fs deciders)
packages/sdlc-tools/     propose-only model tools + the /sdlc command surface
packages/sdlc-presets/   26 dsh-agent-preset rows (generated from roles.js)
packages/sdlc-cli/       the `sdlc` executable
packages/sdlc-mock-llm/  deterministic ctx.llm provider (test-only)
packages/sdlc-client-ui/ web UI: config editor, task board, side-by-side review (sdlc-web only)
profiles/                installer recipes: sdlc-web, sdlc-worker, sdlc-probe
scripts/                 gates (P, M0–M8, Q), build, installer, doctor, harness
tests/                   unit · contract · integration · fault · adversarial · e2e
demo/                    zero-dependency fullstack task-tracker proving the loop end-to-end
```

## Modes (spec C.2)

| Mode | Command | Slash commands | Approvals | Instance lock |
|---|---|---|---|---|
| Interactive lead | `dsh --profile sdlc-web` | yes | yes | yes |
| Headless one-shot | `dsh --profile sdlc-worker "<task>"` | no | no (fail-closed) | no |
| Deterministic CLI | `sdlc status/tasks/…` | n/a | read/ops only | briefly |
| Boot probe | `dsh --profile sdlc-probe` | no | no | briefly |

Only the interactive lead can grant authority. A headless deployment is a guest
of the state machine: it can run work but cannot unblock itself.

## Web UI

`dsh --profile sdlc-web` mounts the **SDLC** right-sidebar tab (package
`sdlc-client-ui`, `sdlc-web` only):

| Panel | What it does |
|---|---|
| Status | live project + task + spend summary from `sdlc.db` |
| Board | tasks grouped by state machine state |
| Config | validated editor for `.sdlc/config.yml` (tiers, budgets, gates — writes rejected when validation fails) |
| Review | side-by-side time/tokens/tracepaths for two runs of one task |

Host routes (`/api/sdlc.status`, `/api/sdlc.board`, `/api/sdlc.task`,
`/api/sdlc.compare`, `/api/sdlc.config`, `/api/sdlc.metrics`) read the live
DB; the one POST validates through the same `validateConfig` the CLI uses.
The browser bundle is built offline by `node scripts/build-ui.mjs` (part of
`npm run build`) with zero dependencies.

## Status

`gate:P` and `gate:M0`…`gate:M8` plus `gate:Q` pass (11/11); 662 offline tests
pass across unit/contract/integration/fault/adversarial, 9/10 e2e (1 skipped
by design), 86/86 eval harness, 6/6 demo. `doctor` passes with 0 errors and
0 warnings on a configured host. See the validation report §1 for the two
environment-dependent skips (pnpm-present vs absent, Playwright stack).
