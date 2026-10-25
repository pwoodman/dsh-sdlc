/**
 * packages/sdlc-core/src/runtime.js — the orchestrator runtime (spec v3 C.2, C.5, B.2/B.3).
 *
 * The runtime is the single writer to `sdlc.db` (P23). It composes the pure
 * modules from this package behind one object so integration tests, the CLI and
 * the DSH services all exercise the SAME code path.
 *
 * Platform isolation note (Part E risk 1): the DSH API touchpoints live in
 * services.js / index.js; this file has no DSH dependency at all.
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { openDatabase, migrate, quickCheck } from './schema.js';
import { TaskStateService } from './state-machine.js';
import { ModelRouter } from './router.js';
import { planStep, effectiveParallelism } from './scheduler.js';
import { providerLimitFromRegistry } from './worker-mgr.js';
import { budgetsForRisk, normalizeTaskBudget, PROJECT_BUDGET_DEFAULTS, checkDispatch, checkProjectBudget, evaluateRun } from './budget.js';
import { riskClass } from './risk.js';
import { InstanceLock, InstanceLockedError } from './instance-lock.js';
import { deriveWorkerResult, scopeVerdict, resolveClaims } from './worker-result.js';
import { exportMetrics } from './metrics.js';
import { GuardPlugin } from '../../sdlc-guard/src/index.js';
import { applyResolution } from './escalation.js';

export class RuntimeLockedError extends Error {
  constructor(holder) {
    super(`INSTANCE_LOCKED: .sdlc/ is held by pid ${holder?.pid} on ${holder?.host}`);
    this.code = 'INSTANCE_LOCKED';
    this.holder = holder;
  }
}

export class Runtime {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {object} opts.config
   * @param {boolean} [opts.useLock]
   * @param {string} [opts.dbPath]
   */
  constructor({ projectRoot = process.cwd(), config = {}, useLock = true, dbPath = null, now = () => new Date().toISOString() } = {}) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.now = now;
    this.dbPath = dbPath ?? join(projectRoot, config.storage?.dbPath ?? '.sdlc/sdlc.db');
    this.lockPath = join(projectRoot, '.sdlc', 'sdlc.lock');
    this.useLock = useLock && (config.safety?.instanceLock ?? true);
    this.lock = null;
    this.db = null;
    this.state = null;
    this.router = null;
  }

  /** Open the DB (creating it if needed) and take the instance lock. */
  open() {
    const sdlcDir = join(this.projectRoot, '.sdlc');
    if (!existsSync(sdlcDir)) mkdirSync(sdlcDir, { recursive: true });
    const dbDir = dirname(this.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    if (this.useLock) {
      this.lock = new InstanceLock(this.lockPath);
      try {
        this.lock.acquire();
      } catch (err) {
        if (err instanceof InstanceLockedError) throw new RuntimeLockedError(err.holder);
        throw err;
      }
    }
    this.db = null;
    try {
      this.db = openDatabase(this.dbPath, {
        requireQuickCheck: this.config.storage?.requireQuickCheckOnOpen ?? true,
      });
    } catch (err) {
      // The lock was acquired before the DB opened: a failed open must not
      // leak a held lock, or every later `open()` in this process (and a
      // stale lock file for other processes) blocks forever. Roll back the
      // half-open state before rethrowing.
      this.db = null;
      if (this.lock) { try { this.lock.release(); } catch { /* already released */ } this.lock = null; }
      throw err;
    }
    this.state = new TaskStateService(this.db, { now: this.now });
    this.router = this.buildRouter();
    return this;
  }

  close({ releaseLock = true } = {}) {
    if (this.db) { this.db.close(); this.db = null; this.state = null; }
    if (releaseLock && this.lock) { this.lock.release(); this.lock = null; }
  }

  buildRouter() {
    const cfg = this.config;
    try {
      const history = {};
      for (const row of this.db.prepare('SELECT model_id, task_type, outcome FROM model_runs').all()) {
        const key = `${row.model_id}:${row.task_type}`;
        history[key] ??= { successes: 0, failures: 0 };
        if (row.outcome === 'success') history[key].successes += 1;
        else history[key].failures += 1;
      }
      return new ModelRouter({
        tiers: cfg.tiers ?? {},
        capabilities: cfg.capabilities ?? {},
        pricing: cfg.pricing ?? {},
        history,
        registry: cfg.registry ?? [],
        config: cfg.router ?? {},
      });
    } catch (err) {
      // (i): a router that cannot read its history must not take the whole
      // boot down — but it must not fail silently either. Warn with the
      // cause, keep the return shape (an empty router) compatible.
      console.warn(`runtime: router unavailable, continuing with empty history: ${err?.message ?? err}`);
      return new ModelRouter({});
    }
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject({ id = randomUUID(), name, repoPath = this.projectRoot, state = 'DISCOVERY', complexity = null, budget = null } = {}) {
    const ts = this.now();
    this.db.prepare(
      `INSERT INTO projects(id, name, repo_path, state, complexity_json, budget_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name ?? id, repoPath, state, complexity ? JSON.stringify(complexity) : null, budget ? JSON.stringify(budget) : null, ts, ts);
    this.state.record({ projectId: id, actor: 'planner', action: 'project-created', payload: { name: name ?? id } });
    return this.getProject(id);
  }

  getProject(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) ?? null;
  }

  setProjectState(id, state, { blockedState = null } = {}) {
    this.db.prepare('UPDATE projects SET state = ?, blocked_state = ?, updated_at = ? WHERE id = ?')
      .run(state, blockedState, this.now(), id);
    this.state.record({ projectId: id, actor: 'runtime', action: `project:${state}` });
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  addTask(task) {
    const ts = this.now();
    const score = task.complexity ?? null;
    const risk = task.risk_class ?? (score == null ? 'R2' : riskClass({ sec: task.sec, ui: task.ui, score, resources: task.resources }));
    const { budget, unknownKeys } = normalizeTaskBudget(task.budgets, risk, this.config.budgets?.perTask);
    if (unknownKeys.length) {
      throw new Error(`task ${task.id}: unknown budget key(s) ${unknownKeys.join(', ')} — the contract uses max_attempts/max_duration_ms/max_cost_usd/max_tokens (B.3.1)`);
    }
    this.db.prepare(
      `INSERT INTO tasks(id, project_id, title, objective, role, state, attempt, retry_budget,
        risk_class, task_class, complexity, model_tier, acceptance_criteria_json, allowed_paths_json,
        forbidden_paths_json, verification_json, estimate_json, plan_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'BACKLOG', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id, task.project_id ?? null, task.title ?? task.id, task.objective ?? '', task.role ?? null,
      task.attempt ?? 0, budget.maxAttempts, risk, task.task_class ?? null, score, task.model_tier ?? null,
      JSON.stringify(task.acceptance_criteria ?? []), JSON.stringify(task.allowed_paths ?? []),
      JSON.stringify(task.forbidden_paths ?? []), JSON.stringify(task.verification ?? []),
      JSON.stringify(task.estimate ?? {}), task.plan_hash ?? null, ts, ts,
    );
    for (const dep of task.depends_on ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO task_dependencies(task_id, depends_on) VALUES (?, ?)').run(task.id, dep);
    }
    for (const res of task.resources ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO task_resources(task_id, resource) VALUES (?, ?)').run(task.id, res);
    }
    this.state.record({
      taskId: task.id, actor: 'planner', action: 'task-created',
      payload: { risk_class: risk, retry_budget: budget.maxAttempts },
    });
    return this.getTask(task.id);
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      acceptance_criteria: safeJson(row.acceptance_criteria_json, [], 'tasks.acceptance_criteria_json'),
      allowed_paths: safeJson(row.allowed_paths_json, [], 'tasks.allowed_paths_json'),
      forbidden_paths: safeJson(row.forbidden_paths_json, [], 'tasks.forbidden_paths_json'),
      verification: safeJson(row.verification_json, [], 'tasks.verification_json'),
      estimate: safeJson(row.estimate_json, {}, 'tasks.estimate_json'),
      depends_on: this.db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?').all(id).map((r) => r.depends_on),
      resources: this.db.prepare('SELECT resource FROM task_resources WHERE task_id = ?').all(id).map((r) => r.resource),
    };
  }

  listTasks({ state = null, projectId = null } = {}) {
    const clauses = [];
    const args = [];
    if (state) { clauses.push('state = ?'); args.push(state); }
    if (projectId) { clauses.push('project_id = ?'); args.push(projectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT id FROM tasks ${where} ORDER BY id`).all(...args).map((r) => this.getTask(r.id));
  }

  projectTasks(projectId) {
    return this.listTasks({ projectId }).map((t) => ({
      id: t.id,
      state: t.state,
      allowed_paths: t.allowed_paths,
      resources: t.resources,
      depends_on: t.depends_on,
      risk_class: t.risk_class,
    }));
  }

  // ── transitions ──────────────────────────────────────────────────────────

  // (iii): the single-writer queue lives in the service (B.2.3). The
  // synchronous core stays available for tests and single-threaded callers;
  // concurrent callers (workers, recovery) use transitionQueued.
  transition(taskId, to, actor, ctx = {}) {
    return this.state.transition(taskId, to, actor, ctx);
  }

  transitionQueued(taskId, to, actor, ctx = {}) {
    return this.state.transitionQueued(taskId, to, actor, ctx);
  }

  /** Illegal proposals return INVALID_TRANSITION with the current row (L.1). */
  proposeTransition(taskId, to, actor, ctx = {}) {
    const before = this.state.getTask(taskId);
    const result = this.state.transition(taskId, to, actor, ctx);
    if (!result.ok) return { ...result, row: before };
    return result;
  }

  // ── lead proposals (D22 phase 1) ─────────────────────────────────────────
  // Model tools are propose-only (L.1 rule 4): they enqueue a durable row
  // here; the transition service (or the drain below) applies it. Nothing
  // in this path grants authority — `approve` from a model actor is
  // rejected at enqueue time, executably, not by comment.

  static LEAD_PROPOSAL_KINDS = ['dispatch', 'approve', 'decision', 'plan-delta', 'run'];

  queueLeadProposal({ kind, task_id = null, taskId = null, payload = {}, actor = 'lead', decidedBy = null } = {}) {
    const id = `prop-${randomUUID().slice(0, 8)}`;
    const ts = this.now();
    if (!Runtime.LEAD_PROPOSAL_KINDS.includes(kind)) {
      return { ok: false, error: `UNKNOWN_KIND: ${kind}` };
    }
    // L.1 rule 4 (executable): a model approve never enqueues. Either the
    // top-level decidedBy or payload.decidedBy must attest human authority —
    // the human command path (slice 3) executes directly, never via drain.
    const body = payload ?? {};
    const by = decidedBy ?? body.decidedBy ?? null;
    if (kind === 'approve' && by !== 'human') {
      return { ok: false, error: 'AUTHORITY_DENIED: approvals are user-only (L.1 rule 4)', id };
    }
    this.db.prepare(
      `INSERT INTO proposals(id, kind, task_id, payload_json, actor, decided_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(id, kind, task_id ?? taskId, JSON.stringify(body), actor, by, ts);
    this.state.record({ taskId: task_id ?? taskId, actor, action: 'proposal-queued', payload: { kind, proposal: id } });
    return { ok: true, proposal: { id, kind, status: 'queued' } };
  }

  listProposals({ status = null } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at').all(status)
      : this.db.prepare('SELECT * FROM proposals ORDER BY created_at').all();
    return rows.map((r) => ({ ...r, payload: safeJson(r.payload_json, {}) }));
  }

  decideProposal(id, status, reason = null) {
    const ts = this.now();
    const res = this.db.prepare(
      "UPDATE proposals SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'queued'",
    ).run(status, reason, ts, id);
    return res.changes > 0;
  }

  /**
   * Drain every queued proposal in FIFO order. Pure single-writer path:
   * dispatch/approve never transition here (scheduler/human own those);
   * decision writes the ADR row; plan-delta adds tasks; run boots the flow.
   */
  drainLeadProposals({ actor = 'scheduler' } = {}) {
    const applied = [];
    const rejected = [];
    for (const row of this.listProposals({ status: 'queued' })) {
      const payload = safeJson(row.payload_json, {});
      try {
        if (row.kind === 'decision') {
          this.recordDecision({
            id: payload.id ?? `adr-${randomUUID().slice(0, 8)}`,
            project_id: payload.project_id ?? null,
            question: payload.question ?? '', decision: payload.decision ?? '',
            reason: payload.reason ?? '', alternatives: payload.alternatives ?? [],
            consequences: payload.consequences ?? [], tags: payload.tags ?? [],
          });
          this.decideProposal(row.id, 'applied', null);
          applied.push({ id: row.id, kind: row.kind });
        } else if (row.kind === 'plan-delta' || row.kind === 'run') {
          // Per-task errors must not poison the batch: collect the ones that
          // land, and mark the row applied ONLY when every task succeeds.
          const created = [];
          const failures = [];
          for (const t of payload.tasks ?? []) {
            try {
              const added = this.addTask({ ...t, project_id: payload.project_id ?? t.project_id ?? null });
              created.push(added.id);
            } catch (err) {
              failures.push({ task: t?.id ?? null, error: err?.message ?? String(err) });
            }
          }
          if (failures.length) {
            const first = failures[0];
            const reason = `plan-delta failed for ${first.task ?? 'task'}: ${first.error}`;
            this.decideProposal(row.id, 'rejected', reason);
            rejected.push({ id: row.id, kind: row.kind, error: reason, tasks: created, failures });
          } else {
            this.decideProposal(row.id, 'applied', null);
            applied.push({ id: row.id, kind: row.kind, tasks: created });
          }
        } else if (row.kind === 'dispatch') {
          // Scheduler-owned: applying means marking valid-for-dispatch.
          // The next planStep picks the task up; nothing transitions here.
          // Caller context is surfaced on the return so the scheduler can act.
          this.decideProposal(row.id, 'applied', 'scheduler owns dispatch');
          applied.push({ id: row.id, kind: row.kind, task_id: row.task_id, note: 'scheduler owns dispatch' });
        } else if (row.kind === 'approve') {
          // A queued approve never executes via drain: only the human command
          // path (slice 3) performs transitions (L.1 rule 4). Anything that
          // reaches the drain queued is rejected fail-closed.
          this.decideProposal(row.id, 'rejected', 'AUTHORITY_DENIED: approvals are user-only (L.1 rule 4)');
          rejected.push({ id: row.id, kind: row.kind, error: 'AUTHORITY_DENIED: approvals are user-only (L.1 rule 4)' });
        } else {
          this.decideProposal(row.id, 'rejected', `no drain path for kind ${row.kind}`);
          rejected.push({ id: row.id, kind: row.kind, error: `no drain path for kind ${row.kind}` });
        }
      } catch (err) {
        this.decideProposal(row.id, 'rejected', err?.message ?? String(err));
        rejected.push({ id: row.id, kind: row.kind, error: err?.message ?? String(err) });
      }
    }
    void actor;
    return { applied, rejected };
  }

  // ── worker runs ──────────────────────────────────────────────────────────

  startWorkerRun({ taskId, attempt, sessionId = null, pid = null, model = null, worktreePath = null, contextManifest = null, nonce = null, id = null }) {
    const runId = id ?? `${taskId}-a${attempt}-${randomUUID().slice(0, 8)}`;
    this.db.prepare(
      `INSERT INTO worker_runs(id, task_id, attempt, session_id, pid, model_provider, model_id,
        status, started_at, worktree_path, context_manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(
      runId, taskId, attempt, sessionId, pid, model?.provider ?? null, model?.id ?? null, this.now(), worktreePath,
      contextManifest || nonce ? JSON.stringify({ ...(contextManifest ?? {}), ...(nonce ? { nonce } : {}) }) : null,
    );
    return runId;
  }

  finishWorkerRun(runId, { exitCode = null, status, result = null, durationMs = 0, tokens = null, costUsd = 0 } = {}) {
    this.db.prepare(
      `UPDATE worker_runs SET status = ?, exit_code = ?, finished_at = ?, duration_ms = ?,
        tokens_in = ?, tokens_out = ?, cost_usd = ?, result_json = ? WHERE id = ?`,
    ).run(
      status ?? 'unknown', exitCode, this.now(), durationMs,
      tokens?.in ?? null, tokens?.out ?? null, costUsd,
      result ? JSON.stringify(result) : null, runId,
    );
  }

  getWorkerRun(runId) {
    const row = this.db.prepare('SELECT * FROM worker_runs WHERE id = ?').get(runId);
    return row ? { ...row, result: safeJson(row.result_json, null, 'worker_runs.result_json'), context_manifest: safeJson(row.context_manifest_json, null, 'worker_runs.context_manifest_json') } : null;
  }

  listWorkerRuns({ taskId = null } = {}) {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM worker_runs WHERE task_id = ? ORDER BY started_at').all(taskId)
      : this.db.prepare('SELECT * FROM worker_runs ORDER BY started_at').all();
    return rows;
  }

  /**
   * Ingest a worker result: derive the authoritative record from the diff,
   * resolve the result channel, and persist. Never trusts the worker (L.1.2).
   */
  ingestResult({ runId, filesChanged, contract = {}, outboxRaw = null, finalText = null, runMeta = {}, runtime = {} }) {
    // Derive the run identity (and the nonce, when the dispatcher stored one)
    // from the worker_runs row; caller-supplied fields still win.
    const storedRun = this.getWorkerRun(runId);
    const effectiveMeta = {
      runId: storedRun?.id,
      taskId: storedRun?.task_id,
      attempt: storedRun?.attempt,
      nonce: storedRun?.context_manifest?.nonce,
      ...runMeta,
    };
    const claims = resolveClaims({ outboxRaw, finalText, runMeta: effectiveMeta });
    const result = deriveWorkerResult({ filesChanged, contract, claims: claims.claims, runtime });
    const scope = scopeVerdict(result);
    const taskRow = this.db.prepare('SELECT id, state, attempt, risk_class FROM tasks WHERE id = (SELECT task_id FROM worker_runs WHERE id = ?)').get(runId);
    const spendBefore = taskRow ? this.spentForTask(taskRow.id) : { costUsd: 0, durationMs: 0, tokens: 0 };
    const projectBefore = this.spentTotals();
    const costKnown = typeof runtime.costUsd === 'number';
    const tokensKnown = runtime.tokens != null && typeof runtime.tokens === 'object';
    const tokensTotal = tokensKnown ? (runtime.tokens.in ?? 0) + (runtime.tokens.out ?? 0) : null;

    this.finishWorkerRun(runId, {
      status: result.status,
      exitCode: runtime.exitCode ?? null,
      durationMs: runtime.durationMs ?? 0,
      tokens: runtime.tokens,
      costUsd: runtime.costUsd ?? 0,
      result: { ...result, claims_source: claims.source, scope },
    });

    // Post-run budget accounting. The old path recorded any cost and still let
    // the result proceed to VERIFYING/ACCEPTED; a per-attempt overrun or project
    // breach is now evidence (FAILED) before acceptance can happen. Missing
    // cost/tokens is UNKNOWN, never zero.
    let budget = { action: 'unknown', available: false, reason: 'COST_UNKNOWN' };
    if (taskRow && costKnown && tokensKnown) {
      budget = {
        available: true,
        ...evaluateRun({
          attempt: taskRow.attempt ?? 0,
          run: { costUsd: runtime.costUsd ?? 0, tokens: tokensTotal, durationMs: runtime.durationMs ?? 0 },
          taskBudget: budgetsForRisk(taskRow.risk_class, this.config.budgets?.perTask),
          taskSpend: { costUsd: spendBefore.costUsd },
          projectBudget: this.config.budgets?.perProject ?? PROJECT_BUDGET_DEFAULTS,
          projectSpend: projectBefore,
        }),
      };
      const breach = budget.action === 'block' || budget.perAttemptOver === true;
      if (breach && taskRow.state === 'IN_PROGRESS') {
        this.state.transition(taskRow.id, 'FAILED', 'worker-mgr', {
          hardFailure: true,
          payload: { code: budget.reason ?? 'BUDGET_EXHAUSTED', budget_action: budget.action },
        });
      }
    }
    return { result, scope, claimsSource: claims.source, budget };
  }

  // ── routing, budgets, model runs ─────────────────────────────────────────

  route(task) {
    return this.router.route(task);
  }

  recordModelRun(run) {
    this.db.prepare(
      `INSERT INTO model_runs(id, model_id, task_id, task_type, complexity, duration_ms, tokens,
        cost_usd, attempts, outcome, escalated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id ?? randomUUID(), run.model_id, run.task_id ?? null, run.task_type ?? null,
      run.complexity ?? null, run.duration_ms ?? 0, run.tokens ?? 0, run.cost_usd ?? 0,
      run.attempts ?? 1, run.outcome ?? null, run.escalated ?? 0,
    );
    if (run.model_id && run.task_type) {
      this.router.recordOutcome(run.model_id, run.task_type, run.outcome === 'success' ? 'success' : 'failure', {
        escalated: Boolean(run.escalated),
      });
    }
  }

  spentTotals() {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(duration_ms),0) AS duration, COALESCE(SUM(tokens_in+tokens_out),0) AS tokens FROM worker_runs').get();
    return { costUsd: row.cost ?? 0, durationMs: row.duration ?? 0, tokens: row.tokens ?? 0 };
  }

  /**
   * Spend attributed to ONE task. B.7's cumulative limits are PER TASK
   * (`attempts × per-attempt`), so they must be compared against this task's
   * own worker_runs — never the project-wide total, which would let a busy
   * sibling task falsely exhaust an untouched task's budget.
   */
  spentForTask(taskId) {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(duration_ms),0) AS duration, COALESCE(SUM(tokens_in+tokens_out),0) AS tokens FROM worker_runs WHERE task_id = ?')
      .get(taskId);
    return { costUsd: row.cost ?? 0, durationMs: row.duration ?? 0, tokens: row.tokens ?? 0 };
  }

  canDispatch(task) {
    const projectSpend = this.spentTotals();
    const project = checkProjectBudget({ spentCostUsd: projectSpend.costUsd, spentDurationMs: projectSpend.durationMs }, this.config.budgets?.perProject ?? PROJECT_BUDGET_DEFAULTS);
    if (!project.ok) return project;
    const taskSpend = this.spentForTask(task.id);
    return checkDispatch(
      {
        attempt: task.attempt ?? 0,
        spentCostUsd: taskSpend.costUsd,
        spentTokens: taskSpend.tokens,
        spentDurationMs: taskSpend.durationMs,
      },
      budgetsForRisk(task.risk_class, this.config.budgets?.perTask),
    );
  }

  guardFor(task) {
    return new GuardPlugin({
      allowed_paths: task.allowed_paths,
      forbidden_paths: task.forbidden_paths,
      // GuardPlugin reads `policy.mode`. Passing `guardMode` here silently fell
      // back to the fail-closed 'deny', so a `safety.guardMode: warn` deployment
      // never actually warned.
      mode: this.config.safety?.guardMode,
      forbidden_patterns: this.config.safety?.guardForbiddenPatterns,
      orchestratorPaths: this.config.safety?.orchestratorPaths,
    });
  }

  /**
   * Effective dispatch parallelism (TRACK B, B15 — the product throughput fix).
   *
   * Wires the pure helpers, never reimplements them: `effectiveParallelism`
   * (scheduler.js: min(cores/2, ram/2, provider_limit, configured)) over the
   * configured `execution.maxParallelWorkers`, the project-level
   * `budgets.perProject.maxParallelWorkers` cap, and the provider's
   * `providerLimitFromRegistry` (worker-mgr.js). Dynamic host facts (cpu/ram)
   * are injectable so unit tests stay deterministic and offline.
   *
   * BOUNDARY (Tier D stays out of scope): this computes the CAP and applies
   * the fanned-out batch. Real worker subprocess spawn (`ctx.subprocess`)
   * remains Tier D — dispatchBatch transitions tasks to ASSIGNED (locks
   * respected via planStep); launching the process for each ASSIGNED task is
   * the caller's Tier D step, not this method's.
   */
  async dispatchParallelism({ cpus = null, ramGb = null } = {}) {
    // node:os is host-only; tests inject cpus/ramGb explicitly. Dynamic import
    // keeps the module ESM-pure (no require() in this codebase).
    const os = await import('node:os');
    const configured = this.config.execution?.maxParallelWorkers ?? 'auto';
    const projectRaw = this.config.budgets?.perProject?.maxParallelWorkers ?? 'auto';
    const projectCap = projectRaw === 'auto' ? Infinity : Number(projectRaw);
    const registry = this.config.registry ?? this.router?.registry ?? [];
    const provider = this.config.execution?.provider ?? null;
    return effectiveParallelism({
      maxParallelWorkers: configured,
      cpus: cpus ?? os.cpus().length,
      ramGb: ramGb ?? os.totalmem() / (1024 ** 3),
      providerLimit: provider ? providerLimitFromRegistry(registry, provider) : Infinity,
      configured: Number.isFinite(projectCap) ? projectCap : Infinity,
    });
  }

  /**
   * Compute the capped ASSIGNED batch and apply it concurrently (B15).
   *
   * Each READY task whose locks grant is applied as READY→ASSIGNED via the
   * runtime's own transition path (single-writer invariant preserved: the
   * state machine serializes the writes; the concurrency here is over the
   * bounded batch of transition APPLICATIONS, not over unsynchronized DB
   * access). Returns the applied transitions in stable task-id order.
   *
   * @param {object} opts
   * @param {Array} [opts.tasks] snapshot rows (defaults to projectTasks)
   * @param {number} [opts.cap] explicit cap (defaults to dispatchParallelism())
   * @param {object} [opts.scheduleOpts] forwarded to planStep
   */
  async dispatchBatch({ tasks = null, cap = null, scheduleOpts = {}, projectId = null } = {}) {
    const rows = tasks ?? (projectId ? this.projectTasks(projectId) : this.listTasks());
    const limit = cap ?? (await this.dispatchParallelism());
    const step = planStep(
      { tasks: rows.map((t) => ({ id: t.id, state: t.state, allowed_paths: t.allowed_paths ?? [], resources: t.resources ?? [], depends_on: t.depends_on ?? [] })) },
      { maxParallelWorkers: limit, maxSharedResourceTasks: this.config.scheduling?.maxSharedResourceTasks ?? 1, ...scheduleOpts },
    );
    const batch = step.filter((t) => t.to === 'ASSIGNED');
    // B15: the FIRST sanctioned Promise.all in the production dispatch path
    // (validate-gates.mjs holds the other sanctioned one, for gate processes).
    // Bounded by the cap: at most `limit` ASSIGNED transitions are even
    // proposed, and planStep already serialized lock acquisition in stable id
    // order, so the concurrent application cannot double-grant a lock.
    const applied = await Promise.all(batch.map(async (t) => {
      const res = this.state.transition(t.taskId, 'ASSIGNED', 'scheduler', { locks: t.ctx?.locks ?? [], available: true });
      if (!res.ok) throw new Error(`dispatchBatch: ASSIGNED rejected for ${t.taskId}: ${res.reason}`);
      return { taskId: t.taskId, to: 'ASSIGNED', actor: 'scheduler' };
    }));
    return applied.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  }

  // ── decisions / requirements ─────────────────────────────────────────────

  recordDecision(decision) {
    this.db.prepare(
      `INSERT INTO decisions(id, project_id, question, decision, reason, alternatives_json,
        consequences_json, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.id ?? randomUUID(), decision.project_id ?? null, decision.question ?? '', decision.decision ?? '',
      decision.reason ?? null, JSON.stringify(decision.alternatives ?? []), JSON.stringify(decision.consequences ?? []),
      JSON.stringify(decision.tags ?? []), this.now(),
    );
  }

  listDecisions(projectId = null) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at').all(projectId)
      : this.db.prepare('SELECT * FROM decisions ORDER BY created_at').all();
    return rows.map((r) => ({
      ...r,
      alternatives: safeJson(r.alternatives_json, [], 'decisions.alternatives_json'),
      consequences: safeJson(r.consequences_json, [], 'decisions.consequences_json'),
      tags: safeJson(r.tags_json, [], 'decisions.tags_json'),
    }));
  }

  addRequirement(req) {
    this.db.prepare(
      `INSERT INTO requirements(id, project_id, statement, source, acceptance_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.id ?? randomUUID(), req.project_id ?? null, req.statement ?? '', req.source ?? 'user',
      JSON.stringify(req.acceptance ?? []), req.status ?? 'open', this.now(),
    );
  }

  listRequirements(projectId = null) {
    return projectId
      ? this.db.prepare('SELECT * FROM requirements WHERE project_id = ? ORDER BY created_at').all(projectId)
      : this.db.prepare('SELECT * FROM requirements ORDER BY created_at').all();
  }

  // ── escalations (decision authority stays human/lead) ───────────────────

  /** Persist an escalation decision packet before it is put to the user. */
  recordEscalation({ id, taskId = null, attempt = null, level = null, packet = null } = {}) {
    if (typeof id !== 'string' || id === '') throw new Error('recordEscalation: id is required');
    this.db.prepare(
      `INSERT INTO escalations(id, task_id, attempt, level, packet_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, taskId, attempt, level, JSON.stringify(packet ?? {}), this.now());
    this.state.record({
      taskId, actor: 'escalation-mgr', action: 'escalation-recorded',
      payload: { escalation_id: id, level },
    });
    return this.getEscalation(id);
  }

  getEscalation(id) {
    const row = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, packet: safeJson(row.packet_json, {}, 'escalations.packet_json') };
  }

  getEscalations({ taskId = null } = {}) {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM escalations WHERE task_id = ? ORDER BY created_at').all(taskId)
      : this.db.prepare('SELECT * FROM escalations ORDER BY created_at').all();
    return rows.map((row) => ({ ...row, packet: safeJson(row.packet_json, {}, 'escalations.packet_json') }));
  }

  /**
   * Apply a recorded decision. Approval without an explicit corrective plan
   * leaves the task ESCALATED (the state guard requires the plan); rejection
   * blocks it. Returns the resolution context actually applied.
   */
  resolveEscalation(id, { resolution, decidedBy = null, optionId = null, correctivePlan = null } = {}) {
    const row = this.getEscalation(id);
    if (!row) throw new Error(`resolveEscalation: unknown escalation ${id}`);
    const ctx = applyResolution({ resolution, optionId, decidedBy, correctivePlan });
    this.db.prepare(
      'UPDATE escalations SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?',
    ).run(ctx.resolution, decidedBy, this.now(), id);
    this.state.record({
      taskId: row.task_id ?? null, actor: 'escalation-mgr', action: 'escalation-resolved',
      payload: { escalation_id: id, resolution: ctx.resolution, decided_by: decidedBy, option_id: optionId },
    });
    const task = row.task_id ? this.getTask(row.task_id) : null;
    let transition = null;
    if (task && task.state === 'ESCALATED' && ctx.taskTo !== 'ESCALATED') {
      transition = this.state.transition(row.task_id, ctx.taskTo, 'escalation-mgr', {
        ...ctx,
        correctivePlanApproved: ctx.correctivePlanApproved,
        userDecisionRequired: ctx.resolution !== 'approved',
        payload: { escalation_id: id, resolution: ctx.resolution },
      });
    }
    return { ...ctx, transition };
  }

  // ── evidence ─────────────────────────────────────────────────────────────

  recordTestResults(taskId, runId, gateResults) {
    for (const [gate, r] of Object.entries(gateResults ?? {})) {
      this.db.prepare(
        `INSERT INTO test_results(id, task_id, run_id, gate, status, started_at, finished_at, log_path, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), taskId, runId, gate, String(r.status ?? 'unknown'), this.now(), this.now(), r.logPath ?? null, r.signature ?? null);
    }
  }

  getEvents({ taskId = null, projectId = null, limit = 1000 } = {}) {
    if (taskId) return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id LIMIT ?').all(taskId, limit);
    if (projectId) return this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id LIMIT ?').all(projectId, limit);
    return this.db.prepare('SELECT * FROM events ORDER BY id LIMIT ?').all(limit);
  }

  assertIntegrity() {
    migrate(this.db);
    return quickCheck(this.db);
  }

  /**
   * Prometheus exposition export of the spend + task-state snapshot
   * (observability.metricsExport). Disabled by default — see metrics.js.
   */
  exportMetrics({ outPath = null } = {}) {
    return exportMetrics(this, { projectRoot: this.projectRoot, outPath });
  }
}

function safeJson(text, fallback, context = '') {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    // (i): the old silent swallow hid which row/column failed to parse.
    // Warn with the key context, keep the return shape (fallback) compatible.
    console.warn(`runtime: safeJson parse failed${context ? ` (${context})` : ''}: ${err?.message ?? err}`);
    return fallback;
  }
}

export default { Runtime, RuntimeLockedError };
