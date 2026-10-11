# @patwoodman/orchestrator-presets — the 26 SDLC role presets

One `@deepseek-ai/dsh-agent-preset` row per SDLC role (lead, planner, architect,
implementer, tester, verifier, reviewer, integrator, …). A preset's `plugins`
list *is* the agent composition: persona rows compose the prompt, mounted tool
rows are the allowlist by omission, and the `sdlc_report_result` row is the
propose-only result channel.

Permissions and model are deliberately absent from the presets: permission comes
from the profile's permission row, and the model from the tier overlay.

`cordis.patch.yml` is a **generated** file — its source of truth is
`src/roles.js` (`node scripts/gen-presets.mjs` in the source repo).

## Install

A member of [`@patwoodman/orchestrator`](https://www.npmjs.com/package/@patwoodman/orchestrator)
(lead) and of the boot-probe composition; it can also be mounted directly:

```sh
dsh plugin --profile <profile> add @patwoodman/orchestrator-presets
```

The patch also inserts the `agent-preset-registry` row first, so the presets
reach templates that ship no registry (e.g. the `headless` and `sdk`
templates).

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.5

## License

MIT
