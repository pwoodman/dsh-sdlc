# @patwoodman/dsh-sdlc-flow-ui — the SDLC web panel

The browser half of the orchestrator: an **SDLC** tab in the web app's right
sidebar, plus the host routes that feed it.

| Surface | What it shows |
|---|---|
| Flow | live animated DAG, attention queue, progress/state distribution, parallel-worker meter, gates/routing/activity, inline task detail |
| Tasks | searchable tasks grouped by lifecycle state, with Active/Blocked/Done filters and the same task detail |
| Review | select a task and two runs; signed deltas, changed gates, collapsed trace path |
| Settings (gear) | a validated `.sdlc/config.yml` editor grouped by section; only changed fields can be saved |

The **Live map** is a deterministic SVG derived in the browser from the flow
snapshot — no model call, no generated HTML. Stages are horizontal bands so
parallel work appears side by side; running nodes glow, active edges stream
dashed packets, completed paths stay lit, and blocked/failed paths turn red.
Hovering or selecting a task traces its upstream and downstream path. Reduced
motion drops the animation but keeps the state colours and labels; every node
is keyboard-focusable.

The old **Status** and **Board** tabs were removed: the flow snapshot already
carries project state, task totals, spend and every task, so those tabs were a
second render of the same data. Flow and Tasks share one snapshot. Polling is
2.5 s while a task or worker is in flight and 8 s when quiet; each poll sends
the newest event id as a cursor so only new events cross the wire and the client
merges them into a bounded window. Settings loads config only when opened. The
snapshot also carries the host-computed `totals.parallelism` (`configured`,
`effective`, `active`, `saturated`), so the meter shows real slots instead of a
guess from `auto`.

Host routes: `/api/sdlc.status`, `/api/sdlc.board`, `/api/sdlc.task`,
`/api/sdlc.compare`, `/api/sdlc.config` (GET + validated POST),
`/api/sdlc.metrics`, `/api/sdlc.flow` (bounded visualizer snapshot). The routes
remain part of the host contract; the sidebar itself now reads `flow`, `config`
and `compare`. Every row is scoped to the open session workspace: a project
row whose `repo_path` belongs to another checkout is ignored, and a workspace
with no project gets a 404 `NO_PROJECT` (the guided `sdlc init` state).

The tab is registered as a right-sidebar page with a guide entry, so a new
session can open it from the guide's **SDLC Flow** capsule. With
`autoOpen: true` (the shipped default) it also opens once for the first session
that has an SDLC project; the snapshot is kept as *stale* when a poll fails.

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
- Node.js ≥ 22.13
- a profile whose client platform is `web`

## License

MIT
