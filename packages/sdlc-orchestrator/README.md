# @patwoodman/dsh-sdlc-flow — the lead bundle

The **one** spec an interactive SDLC lead installs. Its patch layer is generated
as the union of its four members' rows (`scripts/gen-bundle-patch.mjs` in the
source repo), because the DSH loader mounts only the bundles a profile lists and
never descends into a bundle's `dependencies`.

Contains, in a single install:

| Member | What it contributes |
|---|---|
| [`@patwoodman/dsh-sdlc-flow-core`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow-core) | the nine host services (tasks, scheduler, router, verifier, integration, evidence, escalation, worker-mgr, recovery) |
| [`@patwoodman/dsh-sdlc-flow-tools`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow-tools) | the propose-only model tools and the `/sdlc` command surface |
| [`@patwoodman/dsh-sdlc-flow-presets`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow-presets) | 26 role compositions; the lead publishes only the Lead Orchestrator as a selectable preset |
| [`@patwoodman/dsh-sdlc-flow-ui`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow-ui) | the SDLC right-sidebar web UI and its host routes |

## Install

```sh
# create the profile from the shipped `web` template first
dsh --profile sdlc-web --from-default-profile web --dump-config

# then the single spec
dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow

dsh --profile sdlc-web
```

No build step and no profile edits: the package ships prebuilt `lib/` plus its
own `dsh.bundle.patch`, so the loader mounts it automatically.

From a source checkout the members are unpublished, so the installer links them
as ordinary module dependencies instead (see `scripts/install-local.mjs` in the
source repo) — they must **not** be added as bundles there, or every row would
compose twice.

## Update, auto-update, uninstall

```sh
# upgrade in place (also prunes members left by older releases)
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --only all

# report only
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --check --json

# remove the package and its bundle selection
npx -y @patwoodman/dsh-sdlc-flow@latest dsh-sdlc-install --uninstall --only all
```

On startup the lead checks the registry at most once per 24 hours. Stable builds
install a newer version through DSH's plugin manager; prerelease builds only
report availability by default (`SDLC_AUTO_UPDATE=install` opts in,
`SDLC_AUTO_UPDATE=off` disables the check). The running process keeps the old
code until it is restarted; the result is reported as `restart-required`.
Failed installs retry after a short backoff, the version on disk is verified, and
a major release requires explicit consent. Link/file/git installs are never
replaced automatically.

The lead installs exactly one own-scope package, so the GUI **Remove** action
also uninstalls everything without ghost member entries.

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0` (declared as a `peerDependency`; DSH
  enforces this range at install and at load)
- Node.js ≥ 22.13 (`node:sqlite`)

## License

MIT
