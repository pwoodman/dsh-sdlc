# @patwoodman/dsh-sdlc-flow-ui — the SDLC web panel

The browser half of the orchestrator: an **SDLC** tab in the web app's right
sidebar, plus the host routes that feed it.

| Panel | What it shows |
|---|---|
| Status | live project, task and spend summary from `sdlc.db` |
| Board | tasks grouped by state-machine state |
| Config | a validated editor for `.sdlc/config.yml` (writes are rejected when validation fails) |
| Review | side-by-side time/tokens/tracepaths for two runs of one task |

Host routes: `/api/sdlc.status`, `/api/sdlc.board`, `/api/sdlc.task`,
`/api/sdlc.compare`, `/api/sdlc.config` (GET + validated POST),
`/api/sdlc.metrics`.

`lib/client.js` is a prebuilt closure-factory bundle that registers into the
right-sidebar slot system; it needs no build step on the consumer's machine.

## Install

Installed into the interactive lead only — a `web`-platform profile. It is a
member of [`@patwoodman/dsh-sdlc-flow`](https://www.npmjs.com/package/@patwoodman/dsh-sdlc-flow):

```sh
dsh plugin --profile sdlc-web add @patwoodman/dsh-sdlc-flow
```

It must never be mounted in the headless worker profile (E6).

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.5
- a profile whose client platform is `web`

## License

MIT
