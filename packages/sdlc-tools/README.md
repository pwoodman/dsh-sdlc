# @patwoodman/orchestrator-tools — model tools and the `/sdlc` command surface

The propose-only tool surface, installed in **both** the lead and worker
profiles: workers need `sdlc_report_result`, `sdlc_claim_check` and
`sdlc_request_decision` to write their outbox proposal; the lead additionally
gets the delegation and planning tools. The `/sdlc` command surface
(`run`, `status`, `stop`, `resume`, `doctor`, `config`, `verify`, `explain`,
`debug`) is registered in interactive profiles.

None of these tools may grant authority — that is the lead's human-only
privilege (spec L.1 rule 4).

## Install

```sh
dsh plugin --profile sdlc-worker add @patwoodman/orchestrator-guard @patwoodman/orchestrator-tools
```

It is also a member of [`@patwoodman/orchestrator`](https://www.npmjs.com/package/@patwoodman/orchestrator),
so a lead install brings it in without a second spec.

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.5

## License

MIT
