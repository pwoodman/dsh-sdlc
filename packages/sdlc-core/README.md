# @patwoodman/dsh-sdlc-flow-core — host services

The runtime authority of the orchestrator: task engine and state machine,
scheduler, router, verifier, integration manager, evidence log, escalation
ledger, worker manager and recovery. It owns the SQLite state in `.sdlc/`.

**Never install this into a worker profile.** Mounting it there would start a
second scheduler and a second writer against `sdlc.db` (errata E6 in the spec).
Worker profiles mount [`@patwoodman/dsh-sdlc-flow-guard`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow-guard)
and [`@patwoodman/dsh-sdlc-flow-tools`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow-tools)
only.

## Install

Installed as a bundle by the worker-free profiles (`sdlc-probe`) and as a module
dependency of [`@patwoodman/dsh-sdlc-flow`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow):

```sh
dsh plugin --profile <profile> add @patwoodman/dsh-sdlc-flow-core
```

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.13 (`node:sqlite`)

## License

MIT
