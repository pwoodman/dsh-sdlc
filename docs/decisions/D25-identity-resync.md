# D25 — Identity resync: spec claims vs true values + validation-report staleness

**Status:** scoped; doc-only fixes applied this track, proposals recorded ·
**Spec:** J.1 (names), J.2 (peer pin/version), C.8.1 (M0 count), D.0 (gate list)

## Context

The suite was renamed (`@patwoodman/orchestrator-*` →
`@patwoodman/dsh-sdlc-flow-*`), the M0 suite grew 11→13 checks (M0-11
patch-integrity, M0-12 selftest-contract), and `gate:Q` (coverage) joined the
gate list — but the spec markdown, and both validation reports, still cite the
old values. Verified against `packages/*/package.json`, `scripts/validate-*.mjs`
ids, and `.validation/gate-*.json` evidence.

## Claim table (file:line → true value → fix)

| # | Claim | Location | True value | Fix |
|---|---|---|---|---|
| 1 | Six J.1 npm names (`@patwoodman/orchestrator-core/-guard/-tools/-presets`, `@patwoodman/orchestrator`, `@patwoodman/orchestrator-ui`) | spec v3:1915–1920 | `@patwoodman/dsh-sdlc-flow-core/-guard/-tools/-presets/-cli/-ui` (per `packages/*/package.json`; README:249,277 confirms) | **FIXED this track** (1:1 swap) |
| 2 | J.1: core "ships (2 patch files)" | spec v3:1915 | 1 file (`sdlc-core/cordis.patch.yml`; M0-11 counts 7 patch files repo-wide, cli has none) | **FIXED** |
| 3 | J.1 table omits `sdlc-orchestrator` | spec v3:1911–1921 | 8th package `@patwoodman/dsh-sdlc-flow` (lead meta-bundle; README:249 installs it into `sdlc-web`, M0-01 accepts meta-or-unpacked) | **FIXED** (row added; worker column keeps guard+tools per errata E6) |
| 4 | J.3 upgrade `add @patwoodman/orchestrator-*` | spec v3:1946–1948 | new names, same shape | **FIXED** (1:1 swap) |
| 5 | C.8.1/D.0/K.1 "11 checks" | spec v3:847,923,939,2057 | **13** (`M0-00…M0-12`; `validate-m0.mjs:206–495`, evidence `gate-M0.json` ran:13) | **FIXED** (incl. M0-06 title "26 unique preset rows" → uses `PUBLIC_PRESET_COUNT`/`ROLE_COUNT` wording: 1 selectable + 26 compositions) |
| 6 | D.0 gate list ends at M8 | spec v3:921–933 | 11 gates P,M0–M8 **+Q** (`validate-coverage.mjs`, `package.json:45`, `validate-gates.mjs:37`) | **FIXED** (Q row added) |
| 7 | J.2/C.8/H.2/K.9 "exact pin `0.2.0-rc.2`" (spec prose + G.6/H.3 checklists) | spec v3:670,835,966,1603,1924,1932,2178 | **range** `>=0.2.0-rc.2 <0.3.0-0` is what the gates enforce (`semver-lite.mjs:88 DSH_PEER_RANGE`; `validate-platform.mjs:207–213`; `validate-coverage.mjs:215–216`); "exact" survives only as the *lower bound* + the M0-01 env failure shows why range-checking matters | **PROPOSAL** — prose-vs-enforcement decision: either rewrite the 7 sites to "peer range" (+ keep one exact-`--accept-risk` escape note) or re-pin enforcement to exact; touches gates, installer text, all package.jsons — needs authority sign-off |
| 7b | M0-06 table title "exactly 26 unique rows" | spec v3:863 | `PUBLIC_PRESET_COUNT` selectable + 26 shipped compositions (`validate-m0.mjs:355–403`) | **FIXED** (wording aligned to what the check asserts) |
| 8 | J.2 "ours `0.2.0-rc.2`" lockstep | spec v3:1932 | packages at `1.1.1` | **PROPOSAL** (release-policy decision) |
| 9 | F.1 `npx @patwoodman/orchestrator init/doctor` (2 table rows) | spec v3:985–986 | `npx @patwoodman/dsh-sdlc-flow …` (meta-package name, per `packages/sdlc-orchestrator/package.json`) | **FIXED** (1:1 swap; F.2 heading already used the meta name) |
| 10 | Reports: "402 tests / 52 checks", "M0 5p/6s", "v3 2,329 lines" | impl-report:6,23,50–58,143; spec-report:4,71 | current evidence: **906** tests (`gate-Q.json`), **82** gate checks (79+3 COV), M0=13 (12p/1f — M0-01 fails here: profiles uninstallable without pnpm, env-caused), spec v3=**2,346** lines | **PROPOSAL** — historical run records; fix = re-run gates on a pnpm host and regenerate (Track B/C); M0-01 env failure must go green there first |
| 11 | NOTES header "(2,336 lines)", "seven test layers" | `SDLC_IMPLEMENTATION_NOTES.md:3–5` | 2,346 lines; layers = L0–L8 (9) / 6 test dirs | **NOTED** — file is append-only; corrected totals recorded in the Tier-D appendix below |

## Recommendation

Accept the seven doc-only fixes (#1–6 + #9, applied); open one proposal each for the
peer-pin decision (#7, needs authority sign-off — it redefines P36
enforcement), the M0-06 wording (#7b, gate-visible), version policy (#8), and report
regeneration (#10, blocked on a pnpm host). No production code changed.

## First concrete step (done)

Applied #1–6 + #9 as literal markdown edits (J.1 table incl. the missing
`sdlc-orchestrator`/meta-bundle row, J.3 commands, F.1 table, F.2 heading, all
four "11 checks" sites, D.0 `gate:Q` row); verified no test reads the
spec/report markdown (`scripts/validate-platform.mjs` cites the report only in
a comment) and `tests/contract` + the D23 skeleton stay green.

## Cost

**S** — 1 attempt, doc-only + one skipped skeleton test.

## Acceptance

- [ ] D21–D25 exist in `docs/decisions/`; D23 skeleton is checked in skipped-with-reason and green.
- [ ] Every #1–6 edit cites the true value's source (package.json / script id / evidence JSON).
- [ ] #7–10 recorded as proposals with owners (peer-pin → authority decision; regen → pnpm host run).
- [ ] NOTES Tier-D appendix appended (10 lines, below).
