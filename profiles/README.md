# Profile recipes (spec v3 C.1, E2)

These are **installer recipes**, not DSH profile templates. DSH's
`--from-default-profile` accepts a closed set — `{acp, web, headless, sdk,
sdk-minimal}` — and an out-of-tree plugin *cannot* ship one (errata E2). The
installer therefore creates each profile from the template its recipe names and
then installs the recipe's bundles:

```sh
# each profile is created once, from the template listed in profile.json
dsh --profile sdlc-web    --from-default-profile web      --dump-config
dsh --profile sdlc-worker --from-default-profile headless --dump-config
dsh --profile sdlc-probe  --from-default-profile sdk      --dump-config

# registry form (once published)
dsh plugin --profile sdlc-web    add @patwoodman/dsh-sdlc-flow
dsh plugin --profile sdlc-worker add @patwoodman/dsh-sdlc-flow-guard @patwoodman/dsh-sdlc-flow-tools
dsh plugin --profile sdlc-probe  add @patwoodman/dsh-sdlc-flow-core @patwoodman/dsh-sdlc-flow-tools \
                                     @patwoodman/dsh-sdlc-flow-presets @patwoodman/dsh-sdlc-flow-guard
```

From a source checkout, `node scripts/install-local.mjs` does all of it in one
command. The lead's four members are unpublished in beta, so the installer links
them as **plain module dependencies** (`pnpm add link:…`) rather than bundles:
the meta-bundle's generated patch already declares their rows, and selecting them
as bundles as well would compose every row twice.

`profile.json` in each directory is the machine-readable form of the same recipe;
`scripts/install-local.mjs`, `scripts/doctor.mjs` and `scripts/validate-m0.mjs`
read it (or the profile's own `package.json`) to assert the **package partition**
that closes E6:

| Profile | Template | Bundles | Property |
|---|---|---|---|
| `sdlc-web` | `web` | `@patwoodman/dsh-sdlc-flow` (the generated meta-bundle layer: core + tools + presets + ui rows) | interactive lead; holds the instance lock; slash commands and approvals work |
| `sdlc-worker` | `headless` | guard + tools | **never** core — mounting core in a worker would start a second scheduler and a second DB writer |
| `sdlc-probe` | `sdk` | core + tools + presets + guard | deterministic boot probe; boots the full composition with no UI, no prompt and no model call |
