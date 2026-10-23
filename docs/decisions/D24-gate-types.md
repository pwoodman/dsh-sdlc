# D24 — Missing F.5 gate types (types/api/security/perf) + Playwright driver for B.5/K.2 L7

**Status:** scoped, no decision yet · **Spec:** F.5 (gate detection), B.5
(visual QA), B.4 (risk→gate mapping), K.2 L7 (e2e layer), D.0 (`gate:M3`) ·
**Track:** D

## Context

`GATE_ORDER` already names all eleven gates
(`packages/sdlc-core/src/risk.js:9`), and `requiredGates` (`risk.js:73`) already
*routes* to them (`api` on api-domain R2–R4, `security` on R4, `perf` on
`perfTrigger`, `e2e`/`visual` on UI change). But F.5 *detection* only emits
commands for six gates — `detectGateCommands` (`gates.js:80`) writes
`syntax/lint/unit/integration/build` (+ `types` for pnpm only) and `e2e/visual`
only when Playwright is present. Four gaps remain:

1. **`types`** — detected only for the pnpm stack (`STACKS.pnpm.commands.types`).
   npm/python/go/cargo stacks never get a `types` gate; plain `tsc` detection
   (tsconfig presence) is unscoped.
2. **`api`** — routed by `requiredGates` but *never detected*: no stack entry
   writes an `api` command, so `runVerification` records `skipped:not-configured`
   for every API task (M3-01 only exercises syntax/lint/unit/integration/api
   with a hand-built `FULL_GATES` fixture).
3. **`security` / `perf`** — same: routed, never detected. F.5 names
   `pnpm audit` (security) and `pnpm run bench` (perf) shapes, but neither is in
   `STACKS`.
4. **Playwright driver** — `visual: {kind:'playwright'}` is a *kind tag*, not a
   runner: `runVerification` treats any gate without `.command` as
   `skipped:no-command`, and no code spawns Playwright, applies the viewport
   matrix (`visual.js:38`), parses the rubric (`visual.js:45`), or enforces the
   2-failure `ESCALATED` rule (`visual.js:89`). M6-01…M6-05 test the pure
   helpers; M6-06 asserts the no-browser-stack BLOCK policy and skips the
   browser run (correct per L.5, but the driver itself is unscoped).

## Options

**(a) Detection entries + command gates first, Playwright driver second (recommended).**
Step 1 extends `STACKS`/`detectGateCommands` with the four missing commands
(`types` via tsconfig scan for every stack; `api` via OpenAPI/supertest marker
or explicit config; `security` via `pnpm/npm audit`; `perf` gated on
`perfTrigger` + `bench` script presence) so `sdlc init` writes runnable argv and
`skipped:not-configured` becomes the exception, not the rule. Step 2 adds a
`runPlaywrightGate({cwd, config, viewports})` driver behind the existing kind
tag, reusing `viewportMatrix`/`parseVisualRubric`/`visualFailureEscalates`, and
extends `gate:M6` with a mock-browser test. Each step is independently landable;
step 1 is pure config-shape work (S), step 2 needs a browser harness (M).

**(b) Playwright driver first.** Unblocks B.5/K.2 L7 fastest for UI work, but
leaves `api/security/perf` silently skipped — the larger correctness hole
(security gates on R4 tasks) stays open while browser plumbing is built.

**(c) Document all four as manual-only.** Declare `types/api/security/perf` and
visual as `verification.detection: manual` forever, requiring explicit authoring.
Zero code, but contradicts F.5's auto-mode contract and pushes the steepest
setup cost onto every new project. Not recommended.

## Recommendation

Option (a). Step 1 closes the silent-skip hole for the four command gates with
only detection-table edits; step 2 builds the one genuinely new runtime (the
Playwright driver) on top of already-tested pure helpers. Coordination with
Track B (coverage-once): M8-05 runs `tests/unit, tests/contract,
tests/integration, tests/fault, tests/adversarial` (`validate-m8.mjs:165`) and
M8-01 runs `tests/e2e` separately — **new tests slot into the existing layers,
never a new suite**: detection unit tests → `tests/unit/gates-*.test.mjs`;
driver contract (argv shape, artifact paths) → `tests/contract/`; mock-browser
end-to-end → `tests/integration/` or `tests/e2e/` behind the existing
no-browser-stack skip. No doubling, no new `test:*` script, no M8-05 edit.

| Gate | Command shape (auto) | Skip condition | Layer |
|---|---|---|---|
| `types` | `tsc --noEmit` (any stack w/ tsconfig) | `no-tsconfig` | unit + M3 ext |
| `api` | framework marker (supertest/openapi) else manual | `not-configured` | contract + M3 ext |
| `security` | `pnpm/npm audit --audit-level high` | `not-configured` | integration |
| `perf` | `bench` script, only on `perfTrigger` | `no-perf-trigger` | integration |
| `e2e`/`visual` | Playwright driver (`runPlaywrightGate`) | `no-browser-stack` (BLOCKS R3+ UI, L.5) | e2e (M6 ext) |

## First concrete step

Extend `STACKS` in `packages/sdlc-core/src/gates.js` with `security`/`perf`
commands and generalise `types` detection past pnpm (tsconfig scan in
`listRootFiles`), plus unit tests in `tests/unit/` asserting each new command's
argv and each new `skipIf`. Touch nothing in `runVerification` or M8-05.

## Cost / attempt estimate

**M** split as **S + M**: step 1 (S, 1–2 attempts, detection table + unit
tests); step 2 (M, 2–4 attempts, Playwright driver + mock-browser tests +
M6 extension; browser binary availability is an environment risk, mitigated by
the existing `M6-06` skip-with-policy pattern).

## Acceptance

- [ ] `sdlc init` on a pnpm+tsconfig+playwright fixture writes runnable
      `types/api/security/perf/e2e/visual` entries; no gate the risk class
      requires is `skipped:not-configured` by default.
- [ ] Each new gate runs through `runVerification` and writes a per-gate
      `<gate>.log` (extends the M3-01 pattern to all eleven gates).
- [ ] The Playwright driver executes the viewport matrix, stores
      screenshots + rubric JSON as `visual_results`, and two consecutive
      failures yield `ESCALATED` (executable form of `visualFailureEscalates`).
- [ ] New tests live in existing layers only; `M8-05` layer list and
      `test:*` scripts are unchanged (coverage-once holds).
