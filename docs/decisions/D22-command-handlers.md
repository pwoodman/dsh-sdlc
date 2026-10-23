# D22 — `/sdlc` command handlers + lead-tool proposal-enqueue path

**Status:** scoped, no decision yet · **Spec:** C.4 (tool & command surface),
L.1 (authority model, rule 4) · **Track:** D (Tier D, large spec gap)

## Context

Two halves of the authority surface are stubbed today:

1. **All `/sdlc` command handlers return `{deferred: true}`** without executing
   anything (`packages/sdlc-tools/src/plugin.js:78`). That includes the
   authority-granting commands `approve / reject / stop / retry / elevate`
   (`AUTHORITY_COMMANDS`, `packages/sdlc-tools/src/index.js:46`), which per C.4
   are *"user-only: authority-granting actions execute directly against the
   runtime service"* — currently asserted only by the table, not by code.
2. **The four lead tools are stubs** (`index.js:206–218`): `sdlc_dispatch_task`
   and `sdlc_approve_transition` return denial errors, `sdlc_record_decision`
   and `sdlc_plan_delta` return in-memory `{proposal}` objects with no
   persistence, no queue, and no path to the transition service. L.1 rule 4
   ("model tools submit proposals; only host services perform transitions") is
   therefore enforced only by *comments* (`authority: 'propose'` in `TOOL_DEFS`)
   plus the outbox write path for worker tools — there is no lead-side
   proposal-enqueue channel at all.

The worker half is done (outbox proposals → `runtime.proposeTransition`,
`runtime.js:222`). The lead half has no equivalent.

## Options

**(a) Phased: enqueue-only first, authority handlers second (recommended).**
Phase 1 gives every lead tool a durable proposal row (e.g. a `proposals` table
or a `.sdlc/proposals/*.json` outbox the transition service drains), turning
the current in-memory `{proposal}` returns into persisted, auditable,
`INVALID_TRANSITION`-checked intents — *without* granting any authority. Phase 2
wires the five `AUTHORITY_COMMANDS` handlers in `registerCommands` to execute
directly against `getRuntime().transition(…)` (human path, L.1 rule 4),
including the required `ctx.approval.request()` gate for production-impacting
actions. Each phase is independently testable; phase 1 is safe to land without
any authority change.

**(b) Direct-execution handlers now, proposals later.** Implement the five
command handlers against the runtime service immediately (closing the `deferred`
gap), leaving lead tools as pure denials/proposals-in-memory. Fixes the user
surface fastest but leaves the L.1 rule-4 gap open: lead tools still have no
enqueue path, so any future agentic plan-delta flow must invent one under
pressure.

**(c) Unified proposal queue for tools AND commands.** Route even human commands
through the same proposal table, with a `decidedBy: human` fast-path. Elegant
single channel, but it reinterprets C.4 ("commands execute directly") and adds a
queue-drain latency to interactive `stop` — exactly the command that must be
immediate (kill switch, B.7). Not recommended.

## Recommendation

Option (a), in the phased order stated. Phase 1 is a pure persistence addition
(proposal rows + drain in the transition service) with no authority semantics;
phase 2 is the authority change and gets its own review. Map each command to
its handler behaviour now so phase 2 is mechanical:

| Command | Real handler behaviour (phase 2) |
|---|---|
| `approve` | `transition(task, to, 'human', {planApproved:true})` after `ctx.approval.request()` allows-once (L.1 r4) |
| `reject` | `transition(task, FAILED, 'human', …)` with reason → replan evidence |
| `stop` | kill-switch: signal workers, `CANCELLED` from any non-terminal state (matrix already has the rows) |
| `retry` | `FAILED→READY` via `retryBudgetRemaining`, else `ESCALATED` (matrix rows exist) |
| `elevate` | route to next tier / `ESCALATED→READY` with corrective plan (escalation-mgr) |

Lead-tool → proposal mapping (phase 1): `sdlc_dispatch_task` → `{kind:'dispatch',
task_id}` drained by the scheduler; `sdlc_approve_transition` → **rejected at
enqueue** unless `decidedBy: human` (the L.1 r4 executable form of today's
comment); `sdlc_record_decision` → ADR row; `sdlc_plan_delta` → planner path
(spec §36).

## First concrete step

Phase 1: add `queueLeadProposal({kind, …})` to `packages/sdlc-core/src/runtime.js`
(next to `proposeTransition` at :222), persisted to a new `proposals` table, and
change `createHandlers` (`packages/sdlc-tools/src/index.js:179`) so
`sdlc_record_decision` / `sdlc_plan_delta` enqueue instead of returning
in-memory objects. Failing-first test:
`tests/contract/lead-proposals.test.mjs` asserting enqueue → drain →
`INVALID_TRANSITION` for an illegal approve-proposal.

## Cost / attempt estimate

**M** split as **S + M**: phase 1 (S, 1–2 attempts, one table + drain, no
authority change); phase 2 (M, 2–3 attempts, five handlers + approval gating +
`stop` kill-switch wiring, needs human-review sign-off per L.1).

## Acceptance

- [ ] Phase 1: every lead-tool call persists a proposal row; drain applies legal
      ones and returns `INVALID_TRANSITION` + current row for illegal ones.
- [ ] Phase 1: `sdlc_approve_transition` from a model tool is *always* rejected
      at enqueue (executable L.1 rule 4, covered by an adversarial test).
- [ ] Phase 2: each `AUTHORITY_COMMANDS` entry executes against the runtime
      service; no handler returns bare `{deferred:true}` for an authority action.
- [ ] Phase 2: `stop` interrupts a running worker within the kill-switch budget
      (extends `M4-04`); production-impacting `approve` requires
      `ctx.approval.request()` allow-once, fail-closed otherwise.
