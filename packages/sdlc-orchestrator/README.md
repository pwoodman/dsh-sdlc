# @patwoodman/orchestrator — the lead bundle

The **one** spec an interactive SDLC lead installs. Its patch layer is generated
as the union of its four members' rows (`scripts/gen-bundle-patch.mjs` in the
source repo), because the DSH loader mounts only the bundles a profile lists and
never descends into a bundle's `dependencies`.

Contains, in a single install:

| Member | What it contributes |
|---|---|
| [`@patwoodman/orchestrator-core`](https://www.npmjs.com/package/@patwoodman/orchestrator-core) | the nine host services (tasks, scheduler, router, verifier, integration, evidence, escalation, worker-mgr, recovery) |
| [`@patwoodman/orchestrator-tools`](https://www.npmjs.com/package/@patwoodman/orchestrator-tools) | the propose-only model tools and the `/sdlc` command surface |
| [`@patwoodman/orchestrator-presets`](https://www.npmjs.com/package/@patwoodman/orchestrator-presets) | 26 role presets (one per SDLC role) |
| [`@patwoodman/orchestrator-ui`](https://www.npmjs.com/package/@patwoodman/orchestrator-ui) | the SDLC right-sidebar web UI and its host routes |

## Install

```sh
# create the profile from the shipped `web` template first
dsh --profile sdlc-web --from-default-profile web --dump-config

# then the single spec
dsh plugin --profile sdlc-web add @patwoodman/orchestrator

dsh --profile sdlc-web
```

No build step and no profile edits: the package ships prebuilt `lib/` plus its
own `dsh.bundle.patch`, so the loader mounts it automatically.

From a source checkout the members are unpublished, so the installer links them
as ordinary module dependencies instead (see `scripts/install-local.mjs` in the
source repo) — they must **not** be added as bundles there, or every row would
compose twice.

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0` (declared as a `peerDependency`; DSH
  enforces this range at install and at load)
- Node.js ≥ 22.5 (`node:sqlite`)

## License

MIT
