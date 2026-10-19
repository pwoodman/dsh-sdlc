# @patwoodman/dsh-sdlc-flow-cli — the `sdlc` executable

A deterministic control plane over `.sdlc/` that makes **no model calls**:
`init`, `status`, `tasks`, `claim`, `report`, `verify`, `decide`, `debug`
(including `debug compare` / `debug trace`) and `doctor`.

Useful on its own for inspecting and driving an orchestrated project from a
terminal or CI, and it is the surface `npm run doctor` reports on.

## Install

```sh
npm install -g @patwoodman/dsh-sdlc-flow-cli
sdlc status
```

The package ships its `src/` as-is (plain ESM, zero dependencies) — `bin/sdlc.mjs`
is the entry point and `main` points at `src/cli.mjs`. There is no build step.

## Requirements

- Node.js ≥ 22.13 (`node:sqlite`)
- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0` for the profiles it drives

## License

MIT
