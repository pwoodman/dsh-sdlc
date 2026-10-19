# @patwoodman/dsh-sdlc-flow-presets — the 26 SDLC role presets

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

A member of [`@patwoodman/dsh-sdlc-flow`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow)
(lead) and of the boot-probe composition; it can also be mounted directly:

```sh
dsh plugin --profile <profile> add @patwoodman/dsh-sdlc-flow-presets
```

The patch also inserts the `agent-preset-registry` row first, so the presets
reach templates that ship no registry (e.g. the `headless` and `sdk`
templates).

This member bundle declares all 26 role compositions. The lead meta-bundle
(`@patwoodman/dsh-sdlc-flow`) filters the generated patch down to the public
roles (currently the Lead Orchestrator), so a DSH user does not see every
internal role in the Settings page or the new-session preset picker.

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.13

## License

MIT
