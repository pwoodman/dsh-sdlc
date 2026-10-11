# `eval/` — the A/B evaluation harness

It measures **DSH + SDLC plugin** against **DSH alone** on the same model, so the
plugin's value is demonstrated rather than asserted. The design lives in
[EVAL_PROTOCOL.md](../EVAL_PROTOCOL.md); this file is how to run it.

## Quick start (offline, free)

```sh
node eval/run.mjs --executor simulate --repeats 3
node eval/report.mjs --allow-simulate
npm run eval:test        # offline tests pinning the harness
```

> **`simulate` is a placebo.** Both arms receive the identical fixture and no
> model runs, so a correct pipeline reports a *null* effect. It validates the
> plumbing and the statistics. It is **not** evidence about DSH, the records say
> so in-band, and `report.mjs` refuses them unless `--allow-simulate` is passed.

## Layout

```
eval/
  run.mjs              arm runner → append-only records.jsonl
  report.mjs           paired statistics → markdown + JSON
  merge.mjs            merge --shard-* outputs into one reportable dir
  collect-artifacts.mjs  pinned-toolchain artifacts (coverage/audit/load)
  lib/stats.mjs        bootstrap CI, Wilcoxon (exact + approx), dz, power, Holm
  lib/manifest.mjs     task-manifest schema + validator
  lib/metrics.mjs      objective collectors (never fabricates an unmeasurable number)
  lib/records.mjs      run-record schema, validity rule, JSONL I/O
  lib/usage.mjs        token extraction from the NDJSON stream and session logs
  lib/session.mjs      locate a run's session log; read the model that actually ran
  lib/zstd-frames.mjs  split DSH's concatenated-frame session logs (see below)
  lib/env.mjs          node/dsh/git/host identity stamped into every record
  lib/model-patch.mjs  the `--patch` overlay that pins the model for both arms
  tasks/*.json         the pre-registered task suite (incl. one negative control)
  rubric/*.json        blinded jury rubrics for the UI tasks
```

A live `session.jsonl.zstd` is **not one zstd stream**: DSH appends one frame per
event, so a real log is thousands of back-to-back frames. `zlib`'s decoder reads
only the first frame, so `lib/zstd-frames.mjs` splits the file explicitly — a log
that decodes partially reports `truncated:true` and its token total is treated as
unreadable rather than silently under-counted.

## Running the real experiment

The `dsh` executor refuses to start without `--live`, because it spends money.

```sh
# 1. both arms must be real, HEADLESS profiles that differ only by the plugin
dsh --profile eval-control   --from-default-profile headless --dump-config
dsh --profile eval-treatment --from-default-profile headless --dump-config
dsh plugin --profile eval-treatment add packages/sdlc-core packages/sdlc-tools packages/sdlc-presets

# 2. pilot first — 1 repeat, 1 task, confirms the budget before committing
node eval/run.mjs --executor dsh --live --repeats 1 --task ui-dashboard \
  --provider devpass --model deepseek-v4.1-flash \
  --baseline-profile eval-control --treatment-profile eval-treatment --out .eval-out

node eval/report.mjs --records .eval-out/records.jsonl --out eval-report.md
```

Why the invocation looks like that:

- **`dsh` has no `--model` flag.** The model is composed config, so `--provider`
  and `--model` here are written to a patch overlay (`model-patch.yml`) and passed
  to *both* arms with `--patch`. The model actually observed in each run's session
  log is what gets recorded.
- **The arms must be `headless`-template profiles.** `--json` is a headless-app
  flag; an interactive profile (e.g. `sdlc-web`) cannot serve a one-shot run.
  `preflightProfiles()` refuses to start otherwise, and also refuses a treatment
  with no `@sdlc/*` bundle or a control that already composes one.
- **A failed run is `status:"invalid"`.** It carries no metrics, the live study
  aborts at the first one, and `report.mjs` refuses the records unless
  `--allow-invalid` is passed. A run that never happened is not a data point.
- `--dsh-home <dir>` points the run at a different DSH home (useful to keep a
  study's session state isolated, or to run inside a sandbox that cannot write
  `~/.dsh`). `--seed` prints the study seed, which also fixes the randomised arm
  order. `--continue-on-error` overrides the abort.
- **Output is fresh by default.** Re-running into an occupied `--out` dir is
  refused (it once doubled the placebo n to 84 duplicate `runId`s while
  `study.json` described only half). Pass `--append` to mix studies or
  `--resume` to skip already-`ok` runIds and continue an aborted study under
  its original seed. The report likewise refuses mixed-seed or duplicate-runId
  files unless `--allow-mixed-seeds` / `--allow-duplicates` is passed.
- **Transient provider failures are retried** (up to `--max-retries 2` with
  exponential `--retry-base-ms` backoff): `PI_AI_ERROR`, 429/5xx, timeouts and
  connection resets. Retries are disclosed in the record's `notes` + `attempts`.
- **Sharding a 70-run study:** `run.mjs` is single-process; for wall-clock
  parallelism pass the same `--seed` to N processes with `--shard-index k
  --shard-count N --out .eval-out-shard<k>`, then `node eval/merge.mjs --out
  <merged> <shard dirs…>` (refuses mixed seeds and duplicate runIds) and report
  on the merged dir. Workspaces are already isolated per (task, arm, repeat).
- **Dark endpoints:** `coverage`, `dependency-audit`, `latency-p95` and
  `error-rate` need artifacts; produce them with `node
  eval/collect-artifacts.mjs --dir <workspace> [--coverage] [--audit] [--load
  <url>]` (best-effort: a missing tool is reported, never zeroed).

Requirements for a confirmatory run:

- `dsh` and both arm profiles installed (`SDLC_BASELINE_PROFILE`,
  `SDLC_TREATMENT_PROFILE`; default `eval-control` and `eval-treatment`);
- the pinned analysis toolchain from the protocol shipped as JSON artifacts
  (`coverage`, `load`, `audit`, `mutation`) so the artifact-backed metrics become
  available rather than `unavailable`;
- a pinned model recorded in every record (resolved from the run's session log).

## Adding a task

1. Copy an existing manifest in `eval/tasks/`.
2. Keep the requirement text exactly what both arms will receive.
3. Put the acceptance checks in the manifest — **never** in the requirement.
4. Run `node --test tests/unit/eval-manifest.test.mjs`; the suite validates every
   manifest in the directory.

## What the harness will not do

- It will not invent a metric it cannot measure: unmeasurable metrics report
  `available:false` with a reason, and the report shows the gap — including a
  per-endpoint coverage table naming the endpoints that were never measured.
- It will not summarise a placebo run as evidence.
- It will not analyse a run whose executor failed: such a record is `invalid`,
  contributes no metrics, aborts a live study, and makes the report refuse.
- It will not call a noisy positive mean a win: "favouring" requires the 95 % CI
  to exclude zero.
