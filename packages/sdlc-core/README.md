# @sdlc/orchestrator-core — host services

The runtime authority of the orchestrator: task engine and state machine,
scheduler, router, verifier, integration manager, evidence log, escalation
ledger, worker manager and recovery. It owns the SQLite state in `.sdlc/`.

**Never install this into a worker profile.** Mounting it there would start a
second scheduler and a second writer against `sdlc.db` (errata E6 in the spec).
Worker profiles mount [`@sdlc/orchestrator-guard`](https://www.npmjs.com/package/@sdlc/orchestrator-guard)
and [`@sdlc/orchestrator-tools`](https://www.npmjs.com/package/@sdlc/orchestrator-tools)
only.

## Install

Installed as a bundle by the worker-free profiles (`sdlc-probe`) and as a module
dependency of [`@sdlc/orchestrator`](https://www.npmjs.com/package/@sdlc/orchestrator):

```sh
dsh plugin --profile <profile> add @sdlc/orchestrator-core
```

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.5 (`node:sqlite`)

## License

MIT
