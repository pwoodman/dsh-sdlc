# Pre-npm test review — 0.4.0-beta.23 tree (next release: beta.24)

**Status:** review snapshot. No source, test or manifest was changed by the
original review.
**Date:** 2026-10-18. **HEAD:** `21d7f7a` (one commit after tag `v0.4.0-beta.23`)
plus the uncommitted beta.24 work (installer upgrade, `update.js`, one-preset lead).

> **Update:** the release/install/update fixes and their regression tests have
> since been implemented and executed; see [`PROOF_REPORT.md`](PROOF_REPORT.md)
> for the measured results. This document remains the original review snapshot,
> so its "fails today" column describes the tree **before** those fixes.

**Bottom line:** the offline suite is genuinely strong (756/756 green, 95.1 %
line coverage), but the release path and the code a new user meets first are the
weakest parts of the tree. Two defects would make the next publish a silent
no-op or ship an 11 MiB artifact containing a pnpm store; three more can leave an
installer user with a profile that cannot boot. None of these are behavioural
regressions of the orchestrator itself — they are exactly the class of defect
that a "consumer-shaped" test layer catches and unit tests cannot.

---

## 1. Evidence collected

### 1.1 Test and coverage baseline

| Layer | Result |
|---|---|
| `unit` (includes 83 of the 86 eval-harness tests) | 560 pass, 0 fail |
| `contract` | 103 pass, 0 fail |
| `integration` | 47 pass, 0 fail |
| `fault` | 23 pass, 0 fail |
| `adversarial` | 23 pass, 0 fail |
| `e2e` | 9 pass, 1 skipped (live, opt-in) |
| **Total offline** | **765 pass, 0 fail, 1 skipped** |

Coverage (`node --test --experimental-test-coverage`, all five offline layers):

```
all files            95.11 | 82.72 | 95.67   (lines | branches | functions)
packages/sdlc-core/src
  state-machine.js   94.84 | 82.11 | 94.83
  runtime.js         98.79 | 87.13 | 97.50
packages/sdlc-orchestrator/src
  install.mjs        71.43 | 38.71 | 86.49   ← shipped bin, lowest covered file
  update.js          71.83 | 67.03 | 68.75   ← new auto-updater
```

The least-tested file is the one every npm user runs first. The best-tested
files are the orchestrator core.

### 1.2 Registry and release state

```
@patwoodman/dsh-sdlc-flow
  dist-tags: { "latest": "0.4.0-beta.23", "beta": "0.4.0-beta.23" }
  versions: 0.0.0-stage … 0.4.0-beta.21, .22, .23
  latest meta tarball: 96 files, dependencies {} , peer @deepseek-ai/dsh optional
```

- `v0.4.0-beta.23` is tagged at `0464217`; the working tree is **ahead of the
  registry at the same version**.
- The published meta tarball does **not** contain `lib/update.js`, and its
  `lib/install.mjs` does not contain `--uninstall`/`--check` upgrade work.
- [`README.md`](README.md#L3) still says beta.23 is "not yet published";
  [`CHANGELOG.md`](CHANGELOG.md#L5) calls it "candidate, not yet published"
  while describing features that only exist in the uncommitted tree.
- The no-clone artifact `dist/dsh-sdlc-beta.tgz` is **11 MiB** and contains
  **2,314** entries under `.pnpm-store/`, including a pnpm distribution and the
  pnpm store entry for a prior `dist/patwoodman-dsh-sdlc-flow-0.4.0-beta.23.tgz`.

### 1.3 What the release path verifies today

Strong pieces already exist: build + `npm test`, gates P→M8→Q,
`verify-tool-runtime.mjs` on the real host, CI-green polling, packed-tarball
shape, install/boot/uninstall of the packed meta, and provenance.

The gaps are at the registry boundary:

- nothing compares the tree's version to what is already published;
- nothing compares the packed content to the published content;
- the publish loop skips already-published versions and still exits 0;
- worker/probe members are installed from `link:`, never from the registry;
- `verify-publish.mjs` runs the **source** installer, not the shipped
  `lib/install.mjs`, and forces `SDLC_AUTO_UPDATE=off`.

---

## 2. What is already strong (do not regress)

These are not accidents and the new tests should pin them, not replace them:

- **Deterministic, zero-dependency test stack.** 756 tests with no network and
  no model; the mock-LLM provider makes M1–M8 reproducible. The only skipped
  test is the explicitly opt-in live E2E.
- **Worker claims are never trusted.** `files_changed` is derived from the git
  diff, scope violations auto-fail, and the outbox has a nonce/provenance
  channel — even though P1-4 shows the provenance check is optional at one
  entry point.
- **Real packed-artifact verification.** `verify-publish.mjs` boots the packed
  lead on a real DSH host and creates a real `sdlc-lead` session — the beta.19
  class of failure cannot pass it.
- **Crash/recovery and concurrency tests exist** (`tests/fault/*`), even though
  the null-pid path and the merge slot are not yet covered.
- **The evaluation harness refuses to fabricate.** Unmeasurable metrics are
  `available:false`; invalid executor runs are excluded; the placebo is labelled
  in-band and refused by the report unless explicitly allowed.

The problem is not the quality of the existing layers; it is that the layers
stop at the repository boundary. The next section is about the boundary.

---

## 3. Release blockers (P0)

| ID | Finding | Evidence | Why it blocks a publish | Required fix | Test that catches it |
|---|---|---|---|---|---|
| **P0-1** | **Publishing this tree publishes nothing, silently.** Version is still `0.4.0-beta.23`, which is already on the registry. The publish loop skips every member (`npm view name@version` succeeds) and the readback passes. | [`release.yml`](.github/workflows/release.yml#L211); registry query above | A green release with zero new code. Users on beta.23 never receive the installer/auto-update fixes. | Bump to a new version **before tagging**; fail when *all* selected packages already exist, allow only a partial-publish resume. | `tests/contract/release-version-ahead.test.mjs` (offline: version > highest `v*` tag) and `release-publish-loop.test.mjs` (mocked npm: 0 publishes ⇒ exit 1) |
| **P0-2** | **The no-clone tarball leaks `.pnpm-store`** (11 MiB, 2,314 files). Root cause: `git status --porcelain --ignored=matching` emits `!! path`, but the parser requires `entry[1] === ' '` (the `! ` form), so `IGNORED` is always empty; the hard-coded `EXCLUDE` list has no `.pnpm-store`. | [`build-release.mjs:88`](scripts/build-release.mjs#L88); `tar tzf dist/dsh-sdlc-beta.tgz \| grep -c pnpm-store` = 2314 | Testers download a package-manager store, including a previous release tarball. A future ignored scratch dir leaks the same way. | Accept `!!`/`??` correctly (or parse with `git check-ignore`); add `.pnpm-store` to the fallback; add a size ceiling. | `tests/integration/build-release-exclusions.test.mjs` — build to a temp out dir, assert no `.pnpm-store`, `.git`, `node_modules`, `.sdlc`, `.eval-*`; assert tarball < 2 MiB |
| **P0-3** | **A failed install leaves a profile that cannot boot.** `syncBundles()` runs *before* `dsh plugin add`; when the add fails, the manifest selects `@patwoodman/dsh-sdlc-flow` while `node_modules` has nothing. | [`install.mjs:433-446`](packages/sdlc-orchestrator/src/install.mjs#L433); reproduced below | The user's next `dsh --profile sdlc-web` fails to mount the bundle. No backup, no rollback, no repair command. | Snapshot `package.json` + `pnpm-workspace.yaml`; mutate only after a successful add, or restore on failure; run a post-install `--dump-config` health check. | `tests/integration/installer-transaction.test.mjs` — fake `dsh` exits 1 on `plugin`; assert exit 1 **and** the manifest is byte-identical |
| **P0-4** | **`--version` accepts anything and swallows flags.** `--version --dry-run` sets version `"--dry-run"`; `--version latest` pins the literal tag, reinstating the release-age bug the installer exists to fix. | [`install.mjs:66`](packages/sdlc-orchestrator/src/install.mjs#L66); reproduced below | Writes invalid `minimumReleaseAgeExclude` entries and passes `pkg@latest` to pnpm. | Validate `/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/`; reject missing values with exit 2. | `tests/integration/installer-args.test.mjs` |
| **P0-5** | **`minimumReleaseAgeExclude: []` produces a duplicate YAML key.** The regex only recognises the empty-value form, so a second block is appended. | [`install-lib.mjs:25`](packages/sdlc-orchestrator/src/install-lib.mjs#L25); reproduced below | Ambiguous/invalid profile config; pnpm's parser may ignore the exemption and silently resolve the previous beta. | Match `minimumReleaseAgeExclude:` followed by `[]`, flow lists, or block lists; always emit one key. | Extend `tests/unit/install-lib.test.mjs` with `[]`, flow list, comment, CRLF, and reparse assertion |
| **P0-6** | **Auto-update retries are suppressed after a failure, and major upgrades are automatic.** The 24 h marker is written before `installBundle`; a failed install is cached and skipped for a day. `0.4.0 → 1.0.0` is treated as a normal update. | [`update.js:215`](packages/sdlc-orchestrator/src/update.js#L215); reproduced below | A transient pnpm/network failure disables the updater for 24 h; a future major release installs itself without consent. | Write the interval only after a verified install; record failures with a short retry; require same-major or explicit opt-in for majors; read back the installed version. | `tests/unit/update-safety.test.mjs` — failed install then retry in 1 s succeeds; `1.0.0` not auto-installed; `result.version` absent ⇒ not reported as installed |
| **P0-7** | **The published CLI package is uninstallable standalone.** `packages/sdlc-cli/lib/cli.mjs` imports eight `@patwoodman/dsh-sdlc-flow-core/*` subpaths; its manifest has **no `dependencies`**. | [`cli/package.json`](packages/sdlc-cli/package.json); `lib/cli.mjs:18-25`; `ERR_MODULE_NOT_FOUND` when run standalone | Seven packages are published; one of them is broken for anyone who installs it directly (and for any future profile that uses it alone). | Add `"@patwoodman/dsh-sdlc-flow-core": "<exact>"` (and guard transitively), or mark the CLI private / fold-only. | `tests/contract/packed-deps-resolve.test.mjs` — every bare `@patwoodman/*` import in `lib/` must be a declared dependency |
| **P0-8** | **The UI package points at files that do not exist.** `types`, both `types` export conditions, and `./src/*` target `lib/types/**` / `src/**`, which are neither built nor in `files[]`. | [`ui/package.json`](packages/sdlc-client-ui/package.json) lines 7-17; `lib/types` absent | TypeScript/`exports` resolution fails for consumers; the package advertises a source surface it does not ship. | Remove the types entries and `./src/*`, or generate and ship them. | `tests/contract/packed-exports.test.mjs` — resolve `main`, `types`, every `exports` target, `bin`, patch, icon; assert exists and is covered by `files[]` |
| **P0-9** | **Published content and documentation disagree.** The live beta.23 lacks the auto-updater and installer upgrade, but CHANGELOG says they shipped in beta.23; README says beta.23 is unpublished. | Published tarball: 96 files, no `lib/update.js`; repo: 97 files | A user cannot tell which build they have; release notes are wrong at the moment of publishing. | Bump version, move the new bullets to the new section, correct README status, and add a pack/CHANGELOG parity check. | `tests/contract/changelog-pack-parity.test.mjs` — features claimed in the current section exist in the packed tarball |
| **P0-10** | **The registry install path is never exercised after publishing.** Pre-publish installs members with `link:`; post-publish the workflow only runs `npm view` for existence. | [`release.yml`](.github/workflows/release.yml#L235); [`verify-publish.mjs`](scripts/verify-publish.mjs#L134) | `--only all` resolves member tarballs and their intra-suite dependencies from the registry for the first time in front of users. | Add a post-publish job: fresh `DSH_HOME`, `npx -y …@<version> dsh-sdlc-install --only all --version <version>`, `--check`, probe selftest, uninstall. | `install-smoke` extended with a `registry` step that runs after publish (or a `workflow_run` job) |

### 3.1 Reproductions

**P0-3 — failed install leaves an uninstallable selection**

```
before: {"dependencies":{},"dsh":{"profile":{"bundles":[]}}}
$ dsh-sdlc-install --only lead --version 0.4.0-beta.23 --dsh-home $H
  error: install into sdlc-web: `dsh plugin ... add ...@0.4.0-beta.23` exited 1
after:  {"dependencies":{},"dsh":{"profile":{"bundles":["@patwoodman/dsh-sdlc-flow"]}}}
$ ls $H/profiles/sdlc-web/node_modules/@patwoodman
ls: cannot access ...: No such file or directory
```

**P0-4 — argument parsing**

```
--version --dry-run   → version "--dry-run", add @patwoodman/dsh-sdlc-flow@--dry-run
--version latest      → version "latest",    add @patwoodman/dsh-sdlc-flow@latest
```

**P0-5 — duplicate YAML key**

```
input:  minimumReleaseAgeExclude: []
output: minimumReleaseAgeExclude: []
        minimumReleaseAgeExclude:
          - '@patwoodman/dsh-sdlc-flow@0.4.0-beta.23'
key count: 2
```

**P0-6 — auto-update cache and major upgrades**

```
first failed install: error boom
cache after failure: { "checkedAt": 1000, "latest": "0.4.0-beta.23", ... }
retry 1s later: skipped interval, registry fetched: 0
updateDecision(0.4.0 → 1.0.0): { "action": "update", "version": "1.0.0" }
```

**P0-2 — tarball content**

```
$ tar tzf dist/dsh-sdlc-beta.tgz | grep -c '^dsh-sdlc-0.4.0-beta.23/.pnpm-store/'
2314
$ tar tzf dist/dsh-sdlc-beta.tgz | grep 'patwoodman-dsh-sdlc-flow-0.4.0-beta.23.tgz'
.../.pnpm-store/v11/file+..+..+..+..+dist+patwoodman-dsh-sdlc-flow-0.4.0-beta.23.tgz/...
```

---

## 4. High-priority findings (P1)

These are not necessarily release blockers, but they are the next layer of
consumer and correctness risk. Several are *covered lines whose failure mode is
never asserted* — 95 % line coverage is not buying protection where acceptance
guards default to "pass".

| ID | Finding | Evidence | Consequence |
|---|---|---|---|
| P1-1 | **Gate evidence is fail-open.** `gatesPass` is `ctx.gatesPass !== false`; `decideAcceptance` only rejects when *no* gate evidence exists. R4 with only `syntax: pass` — or with `unit`/`e2e` marked `skipped:*` — is ACCEPTED. | [`state-machine.js:41`](packages/sdlc-core/src/state-machine.js#L41), [`verifier.js:72-79`](packages/sdlc-core/src/verifier.js#L72); reproduced below | A required gate can be skipped or absent and the task still merges. This defeats the product's core promise. |
| P1-2 | **Merge single-writer is caller-asserted.** `ACCEPTED→MERGING` succeeds with `{}`; `mergeSlotFree()` has no production caller. | [`state-machine.js:43`](packages/sdlc-core/src/state-machine.js#L43), [`integration.js:76`](packages/sdlc-core/src/integration.js#L76) | Two tasks can enter MERGING unless every caller remembers to pass the flag. |
| P1-3 | **`postMergeOutcome` defaults a missing merge commit to `HEAD`.** | [`integration.js:69`](packages/sdlc-core/src/integration.js#L69) | A revert could target an unrelated merge instead of failing closed. |
| P1-4 | **Outbox provenance is optional.** Mismatch checks run only for non-null `runMeta` fields; `Runtime.ingestResult` defaults `runMeta={}`. | [`worker-result.js:191`](packages/sdlc-core/src/worker-result.js#L191), [`runtime.js:253`](packages/sdlc-core/src/runtime.js#L253) | A forged/replayed outbox is accepted as non-suspect when the caller omits provenance. |
| P1-5 | **Recovery ignores null-pid runs.** `reconcile` only treats a run as dead when `pid != null`; `startWorkerRun` defaults `pid:null`. `findOrphans` *does* handle no-pid, so the two reconcilers disagree. | [`recovery.js:81`](packages/sdlc-core/src/recovery.js#L81), [`runtime.js:216`](packages/sdlc-core/src/runtime.js#L216) | A crashed in-process run strands its task IN_PROGRESS forever. |
| P1-6 | **Budgets are enforced only before dispatch.** `ingestResult` stores caller-supplied cost/tokens and never checks the per-attempt/cumulative ceiling. | [`runtime.js:262`](packages/sdlc-core/src/runtime.js#L262), `budget.js:85` | An overrunning run is recorded as completed; the task keeps its state. |
| P1-7 | **`planStep` mutates the caller's task objects.** `projected` aliases the input when no BACKLOG change is needed. | [`scheduler.js:162-185`](packages/sdlc-core/src/scheduler.js#L162) | A second plan on the same snapshot can make different decisions than the database would allow. |
| P1-8 | **Schema version is never checked.** `migrate()` returns the stored version; a DB with `schema_version=999` opens silently. Migration runs before `quick_check`. | [`schema.js:217-231`](packages/sdlc-core/src/schema.js#L217) | A future/unknown DB can be mutated in place with no backup. |
| P1-9 | **Escalation decisions are not persisted/composable.** The `escalations` table is never written; `applyResolution` does not set `correctivePlanApproved`, which the `ESCALATED→READY` guard requires. | `schema.js:161-171`, `escalation.js:105-116` | The documented resolution path cannot drive the state machine end-to-end. |
| P1-10 | **`dsh` compatibility is not checked.** Any exit-0 `dsh --version` is accepted, including 0.1.x; the error text cites `0.2.1-alpha.2` while the peer range starts at `0.2.0-rc.2`. | [`install.mjs`](packages/sdlc-orchestrator/src/install.mjs) dsh probe | The installer proceeds against an incompatible host and fails later or mounts nothing. |
| P1-11 | **Corrupt profile JSON produces a raw parse error** and no repair path. | reproduced: `Unexpected end of JSON input` | `--check` cannot diagnose a damaged profile; the user has no next step. |
| P1-12 | **Profile writes are not atomic and there is no install lock.** `writeFileSync` can tear; concurrent install/auto-update can lose a `minimumReleaseAgeExclude` entry. | `writeProfilePackage`, `ensureReleaseAgeExcludes` | Interrupted or concurrent runs can corrupt config. |
| P1-13 | **`./install` executes on import.** `main()` is unconditional. | reproduced below | Tooling/tests importing the installer trigger a registry lookup and a real install attempt. |
| P1-14 | **`verify-publish`'s core assertions are partly vacuous.** With zero tarballs it still prints `[ok] no packed tarball contains src/` (the script fails overall, but that check cannot); failure reasons are empty for spawn ENOENT; it runs `src/install.mjs`, not the packed `lib/install.mjs`; it forces auto-update off. | [`verify-publish.mjs:99-102`](scripts/verify-publish.mjs#L99), `:232`, `:223`; reproduced below | A broken pack or a boot-time network failure is not observed by the gate named "verify publish". |
| P1-15 | **`workflow_dispatch` can publish without a tag.** Only the tag⇄version step is tag-gated; the publish step is gated on vars/token alone. | [`release.yml:190-191`](.github/workflows/release.yml#L190) | A manual run with `PUBLISH_NPM=true` can publish an uncommitted/manual ref. |
| P1-16 | **Publish order is not topological.** core is published before its dependency guard; ui before its dependency cli; meta last. | [`release.yml:209`](.github/workflows/release.yml#L209); manifests | A partial failure leaves a window where an exact-version install cannot resolve. |
| P1-17 | **`engines.node >=22.5.0` understates the `node:sqlite` requirement.** Node's own docs say SQLite stayed behind `--experimental-sqlite` until **v22.13.0**. CI only tests 22.18; local tests run on 24. | `schema.js:13`, `state-machine.js:13`; <https://nodejs.org/docs/latest-v22.x/api/sqlite.html> (History) | Users on 22.5–22.12 install successfully and crash at first boot. Raise `engines` to `>=22.13.0` (or the tested floor) and add a matrix. |
| P1-18 | **Windows is untested.** `spawnSync('dsh', …)` without `shell` cannot run `dsh.cmd`; the release target claims Windows support. | `install.mjs` `run()`; CI is ubuntu-only | Windows install/update fails at the first subprocess. |
| P1-19 | **Desktop profile is unmanaged.** `PLANS` has no desktop entry and no discovery, while Desktop is a documented install path. | `install.mjs` `PLANS`; README | Desktop users are sent to the manual Add-plugin path and cannot use `--check`/`--uninstall`. |

**P1-1 reproduction**

```
decideAcceptance(R4, review=accept, gateResults={syntax:pass})       → ACCEPTED
decideAcceptance(R4, review=accept, gateResults={syntax:pass,
                                                   unit:'skipped:policy',
                                                   e2e:'skipped:no-browser-stack'}) → ACCEPTED
decideAcceptance(R4, review=accept, gateResults={})                  → FAILED (no evidence)
```

**P1-14 reproduction**

```
$ node scripts/verify-publish.mjs          # npm and dsh absent
[FAIL]    npm pack @patwoodman/dsh-sdlc-flow-cli:        ← blank reason
[ok]      no packed tarball contains src/ (lib/ only, as installed)  ← vacuous
...
verify-publish: 14 failure(s) — refusing to publish
```

**P1-13 reproduction**

```
$ node --input-type=module -e 'await import("./packages/sdlc-orchestrator/lib/install.mjs")'
DSH SDLC Flow — registry install
...
dsh-sdlc-install: cannot reach the npm registry ... (exit 1)
```

---

## 5. Improved test suite

### 5.1 What to add, in priority order

Each row is a deterministic offline test unless marked *network*. "Fails today"
means the assertion describes behaviour the current tree does not have; those
tests are expected to be red until the corresponding fix lands.

| # | Layer / file | Scenario | Core assertion | Fails today? |
|---|---|---|---|---|
| T1 | `contract/release-version-ahead.test.mjs` | Compare `package.json` version to the highest `v*` git tag | `compare(version, maxTag) > 0`; every manifest equal | **Yes** (equal) |
| T2 | `contract/release-publish-loop.test.mjs` | Extract the publish loop from `release.yml`; mock `npm view`/`npm publish` | A run that publishes 0 packages exits 1; a partial resume only skips packages whose published shasum matches | **Yes** (exit 0) |
| T3 | `integration/build-release-exclusions.test.mjs` | Run `build-release.mjs --skip-build --out <tmp>`; inspect the tarball | No `.pnpm-store`, `.git`, `node_modules`, `.sdlc`, `.validation`, `.eval-*`; size < 2 MiB; `install.sh` executable; required entries present | **Yes** (11 MiB) |
| T4 | `integration/installer-transaction.test.mjs` | Fake `dsh` (bash) fails `plugin add`; fresh profile | Exit 1 and profile `package.json` + `pnpm-workspace.yaml` byte-identical to before | **Yes** (bundle selected) |
| T5 | `integration/installer-args.test.mjs` | `--version --dry-run`, `--version latest`, `--dsh-home` with no value | Exit 2, `--version requires an exact semver`, no `add` step | **Yes** |
| T6 | `unit/install-lib.test.mjs` (extend) | `minimumReleaseAgeExclude: []`, flow list, comment, CRLF, duplicate | Exactly one key; output reparses; comments preserved | **Yes** (duplicate key) |
| T7 | `unit/update-safety.test.mjs` | Failed install then retry; manager omits `version`; `1.0.0`; concurrent checks | Retry not suppressed; unverified install not "installed"; major not auto-installed; one manager call | **Yes** |
| T8 | `contract/packed-deps-resolve.test.mjs` | Static-scan every `lib/**` bare `@patwoodman/*` import | Each is a declared dependency at root version (self allowed) | **Yes** (cli) |
| T9 | `contract/packed-exports.test.mjs` | Resolve `main`, `types`, `exports`, `bin`, patch, icon in the packed dir | Every target exists and is covered by `files[]` | **Yes** (ui types) |
| T10 | `contract/changelog-pack-parity.test.mjs` | For the current version section, grep claimed features | `lib/update.js`, `--check`, `--uninstall` exist in the packed tarball | **Yes** (published beta.23) |
| T11 | `contract/engines-builtins.test.mjs` | If `lib/**` imports `node:sqlite`, parse `engines.node` | Floor is ≥ the unflagged version (or a matrix run proves 22.5 works) | **Yes** (22.5) |
| T12 | `contract/install-export-side-effects.test.mjs` | Import the packed `lib/install.mjs` with an unreachable registry | Exit 0, no stdout, no files written | **Yes** |
| T13 | `integration/registry-install-smoke.test.mjs` *(network; post-publish)* | Fresh `DSH_HOME`; `npx -y …@<version> dsh-sdlc-install --only all`; `--check`; probe; uninstall | All three profiles at the version; probe report complete; uninstall clean | **Yes** (never run) |
| T14 | `adversarial/gate-fail-open.test.mjs` | R2–R4 tasks with missing/skipped required gates; random subsets | Never ACCEPTED unless every `requiredGates()` entry is present **and** `pass` | **Yes** |
| T15 | `adversarial/outbox-provenance.test.mjs` | Replay R1's outbox into R2 with `runMeta={}` / partial metadata | `suspect:true` or `RESULT_MALFORMED`; only a full tuple matches | **Yes** |
| T16 | `integration/resume-null-pid.test.mjs` | Task IN_PROGRESS, run `pid:null`, reopen DB | Exactly one transition; idempotent second reconcile; no duplicate events | **Yes** |
| T17 | `fault/merge-slot.test.mjs` | Two ACCEPTED tasks; missing `mergeCommit`; real modify/delete merge-tree | Second MERGING rejected without an explicit free slot; revert refuses missing commit; parsed paths equal real paths | **Yes** |
| T18 | `integration/budget-ingest.test.mjs` | Cost above per-attempt/cumulative cap; NaN/missing cost | Overrun produced FAILED/escalation evidence; no ACCEPTED path; missing cost is not 0 | **Yes** |
| T19 | `unit/scheduler-purity.test.mjs` | Deep-frozen input snapshot; two plans from the same snapshot | Input unchanged; one resource never granted twice | **Yes** |
| T20 | `fault/schema-version.test.mjs` | DB with `schema_version=999`; corrupt page after header | Open refuses/backs up before DDL; `quick_check` precedes writes | **Yes** |
| T21 | `integration/escalation-authority.test.mjs` | Headless → plan → resolution → transition | Escalation persisted; blocked stays blocked; approved context satisfies the guard | **Yes** |
| T22 | `eval-integrity.test.mjs` | Cross-arm model mismatch; duplicate `(task,arm,repeat)`; differential metric attrition; missing arm C | Report refuses/declares censored; `verdict()` requires arm C | **Yes** (see `DEVELOPER_VALUE_VERIFICATION.md`) |

### 5.2 Test-harness / CI changes

| Change | Why |
|---|---|
| Keep the eval tests in the unit/integration layers (they already run in `npm test`) and make `eval:test` an alias | There should be one source of truth; the separate script is redundant and easy to forget. |
| Add `npm run test:e2e` to the required `npm test` chain | It is 2.3 s, deterministic, and tests the composed pipeline. |
| Matrix `node-version: [22.13, 22.18, 24]` on ubuntu | The engine floor is 22.5 but only 22.18 is tested; local is 24. |
| Add `windows-latest` for `unit`, `contract`, `installer --dry-run` | The product claims Windows support; `spawnSync('dsh')` is a known Windows failure. |
| Add a `mutation` script (zero dependencies) | 95 % line coverage with fail-open guards is false confidence. Mutate `!== false`→`=== false`, `>=`→`>`, `??`→`||`, actor arrays, guard calls in `state-machine`, `verifier`, `worker-result`, `budget`, `scheduler`; report killed/survived. |
| Add the three property tests from §5.3 | Trace closure, scheduler safety/purity, budget/provenance monotonicity. |
| Make `verify-publish` fail on zero packs and use the packed installer | Today it can print `[ok] no packed tarball contains src/` when nothing was packed. |
| Add a post-publish registry smoke job | The only path that resolves member tarballs and exact intra-suite versions from npm. |

### 5.3 Exemplar tests (ready to adapt)

**T1 — version must be ahead of every tag (offline, no network)**

```js
// tests/contract/release-version-ahead.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../lib/helpers.mjs';
import { compare } from '../../scripts/lib/semver-lite.mjs';

test('the release version is ahead of every existing tag', () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const tags = spawnSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' }).stdout
    .split('\n').map((t) => t.trim().replace(/^v/, '')).filter(Boolean);
  for (const tag of tags) assert.ok(compare(version, tag) > 0, `${version} must be newer than tag ${tag}`);
});
```

**T2 — a zero-publish release must fail (no npm needed)**

```js
// tests/contract/release-publish-loop.test.mjs
// Extract .github/workflows/release.yml lines from `for dir in sdlc-core` to the
// end of the publish loop, run it under bash with a mocked `npm` that prints the
// requested version for `view` and appends to a counter for `publish`.
// Assert: exit 1 when counter === 0, message names "already published".
```

**T4 — failed install must roll back**

```js
// tests/integration/installer-transaction.test.mjs
const bin = join(home, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'dsh'), `#!/bin/sh
case "$1" in
  --version) echo 0.2.0-rc.2; exit 0;;
  plugin) echo "simulated add failure" >&2; exit 1;;
esac
exit 0
`, { mode: 0o755 });
const manifestPath = join(home, 'profiles/sdlc-web/package.json');
const before = readFileSync(manifestPath, 'utf8');
const r = spawnSync(process.execPath, [INSTALLER, '--only', 'lead', '--version', '0.4.0-beta.24', '--json', '--dsh-home', home], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
});
assert.notEqual(r.status, 0);
assert.equal(readFileSync(manifestPath, 'utf8'), before, 'a failed install must not select an uninstalled bundle');
```

**T7 — a failed update is retried, and majors are not automatic**

```js
// tests/unit/update-safety.test.mjs
const first = await checkForUpdate({ /* manager throws */ now: 1000, intervalMs: 86400000, ... });
assert.equal(first.status, 'error');
const second = await checkForUpdate({ /* manager succeeds */ now: 2000, intervalMs: 86400000, ... });
assert.equal(second.status, 'installed', 'a failure must not suppress the retry for 24h');
assert.equal(updateDecision({ currentVersion: '0.4.0', latestVersion: '1.0.0', source: '0.4.0' }).action,
  'skip', 'a major upgrade must require an explicit decision');
```

**T14 — no acceptance without the required gates**

```js
// tests/adversarial/gate-fail-open.test.mjs
const required = requiredGates('R4', { domains: ['api', 'ui'] }); // e.g. syntax, unit, integration, api, e2e, visual
for (const subset of subsets(required)) {
  const result = decideAcceptance({ riskClass: 'R4', review: { verdict: 'accept' },
    gateResults: Object.fromEntries(subset.map((g) => [g, { status: 'pass' }])) });
  if (subset.length !== required.length) assert.notEqual(result.status, 'ACCEPTED', subset.join(','));
}
const skipped = Object.fromEntries(required.map((g) => [g, { status: g === 'unit' ? 'skipped:policy' : 'pass' }]));
assert.notEqual(decideAcceptance({ riskClass: 'R4', review: { verdict: 'accept' }, gateResults: skipped }).status, 'ACCEPTED');
```

### 5.4 What *not* to add

- Do not add network calls to the default `npm test`; registry checks belong in
  the release workflow or an explicitly labelled `network` job.
- Do not assert on generated `lib/` contents that are not rebuilt first; the
  existing `build:check`/CI order already covers drift.
- Do not paper over P1-1 by asserting the current fail-open behaviour. If the
  spec genuinely allows a skipped gate for R1, encode that exception
  explicitly, not as a truthy default.

---

## 6. Release checklist (go/no-go)

### Before committing the beta.24 tree

1. **Bump the version** (root + all manifests) and open a new CHANGELOG section;
   remove "not yet published" from README or replace it with the real status.
2. **Fix P0-1…P0-6** (release loop, tarball exclusions, installer transaction,
   version validation, YAML key, updater retry/major policy).
3. **Fix or withdraw P0-7/P0-8** (CLI dependencies, UI export metadata).
4. Run and keep output of:
   ```sh
   node scripts/build.mjs --check
   node scripts/gen-presets.mjs --check && node scripts/gen-bundle-patch.mjs --check
   node scripts/bump-version.mjs --check && node scripts/set-repository.mjs --check
   npm test                       # unit + contract + integration + fault + adversarial
   npm run test:e2e
   node scripts/validate-gates.mjs
   node scripts/build-release.mjs
   tar tzf dist/dsh-sdlc-beta.tgz | grep -c pnpm-store   # must be 0
   ls -lh dist/dsh-sdlc-beta.tgz                          # expect < 2 MiB
   node scripts/verify-publish.mjs                        # needs dsh + pnpm
   ```
5. **Commit, tag `v<version>`, push the tag.** The tag must match the manifest;
   CI must be green for that exact SHA before the Release job proceeds.

### After the publish step

6. Run the registry smoke from a clean machine or container:
   ```sh
   DSH_HOME=$(mktemp -d) npx -y @patwoodman/dsh-sdlc-flow@<version> \
     dsh-sdlc-install --only all --version <version>
   DSH_HOME=... npx -y @patwoodman/dsh-sdlc-flow@<version> dsh-sdlc-install --check --json
   DSH_HOME=... SDLC_SELFTEST=/tmp/selftest.json dsh --profile sdlc-probe
   DSH_HOME=... npx -y @patwoodman/dsh-sdlc-flow@<version> dsh-sdlc-install --uninstall --only all
   ```
7. Confirm the release notes, README status, and registry tarball agree
   (`npm view … dist.shasum`, and the unpacked `files` list).
8. If any step fails after npm has accepted a publish, publish a fix version —
   never move `latest` backwards or re-tag the same version.

---

## 7. Decisions needed before beta.24

These are product/policy decisions, not test defects; each changes what the
tests should assert.

1. **Auto-update default for prereleases.** `install` on every boot is a large
   trust and supply-chain surface. Recommendation: `check` by default for
   prereleases, `install` only for stable, with a visible notice.
2. **Major/minor upgrades.** Recommendation: never auto-install a major; surface
   it in `--check` and let the user run the installer. If auto-install stays,
   pin the channel to the installed major.
3. **Rollback.** The updater has no last-known-good. Either implement a versioned
   install + pointer switch (restart activates) or make the installer's
   `--rollback` restore the previous manifest/tree.
4. **Desktop.** Either support the `desktop` profile explicitly (the plugin
   manager can) or state in the README that Desktop users get no auto-update and
   no `--check`/`--uninstall`.
5. **CLI package.** Publish it with dependencies, or make it private/fold-only.
   Publishing a known-broken package is worse than not publishing it.
6. **Claim wording until evidence exists.** README currently avoids the
   "beats plain DSH" claim, which is correct. Keep it that way until §5 of
   [`DEVELOPER_VALUE_VERIFICATION.md`](DEVELOPER_VALUE_VERIFICATION.md) is met.

---

## 8. Appendix — commands used

```sh
node --test 'tests/unit/**/*.test.mjs'
node --test 'tests/contract/**/*.test.mjs'
node --test 'tests/integration/**/*.test.mjs'
node --test 'tests/fault/**/*.test.mjs'
node --test 'tests/adversarial/**/*.test.mjs'
node --test 'tests/e2e/**/*.test.mjs'
node --test --experimental-test-coverage --test-coverage-include='packages/*/src/**' \
  'tests/unit/**/*.test.mjs' 'tests/contract/**/*.test.mjs' 'tests/integration/**/*.test.mjs' \
  'tests/fault/**/*.test.mjs' 'tests/adversarial/**/*.test.mjs'
node eval/run.mjs --executor simulate --repeats 3 --out "$TMP"
node eval/report.mjs --allow-simulate --records "$TMP/records.jsonl"
```

Registry reads were unauthenticated `GET` requests to
`https://registry.npmjs.org/@patwoodman%2Fdsh-sdlc-flow`; no package was
published, installed from the registry, or modified during this review.
