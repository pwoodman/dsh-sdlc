# @patwoodman/orchestrator-guard — worker-side enforcement

The policy half of the worker sandbox: a `tools/pre-execute` waterfall and the
`fs/*` write deciders. It denies writes outside the task contract's allowed
paths, protects the orchestrator's own files (`.sdlc/sdlc.db`, locks, the task
contract) and rejects forbidden command patterns (`git push --force*`,
`rm -rf /`, `git clean -fdx*`, `git reset --hard*`, …).

It has no host service and no database access. The guard is *policy*, not a
security boundary — the real controls are the sandbox root and the post-hoc
`git diff` check.

Installed into worker profiles beside
[`@patwoodman/orchestrator-tools`](https://www.npmjs.com/package/@patwoodman/orchestrator-tools),
and into the boot probe for symmetry.

## Install

```sh
dsh plugin --profile sdlc-worker add @patwoodman/orchestrator-guard @patwoodman/orchestrator-tools
```

## Configuration

The patch declares the defaults (`guardMode: deny`, `orchestratorPaths`,
`protectedOrchestratorPaths`, `guardForbiddenPatterns`). A profile-level
id-targeted override replaces the row's whole `config`.

## Requirements

- `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`
- Node.js ≥ 22.5

## License

MIT
