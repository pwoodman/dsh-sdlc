# @patwoodman/dsh-sdlc-flow-mock-llm — deterministic test provider

**Test-only, never published** (`"private": true`). Registers a deterministic
`ctx.llm` provider so every offline test and CI acceptance run is free,
networkless and reproducible.

Fault modes and injections are selected through the model string:

```
mock/<scenario>?fail=429:2                  # fail the first two calls
mock/<scenario>?inject=escape|falsefile|injection
```

Installed into the `sdlc-test` and `sdlc-probe` profiles only.

## License

MIT
