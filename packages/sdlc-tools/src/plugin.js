/**
 * packages/sdlc-tools/src/plugin.js — DSH registration for tools and commands.
 *
 * Model tools are propose-only; authority-granting actions are user-only
 * command handlers (C.4, authoring constraint 4). Registration is defensive so
 * the package imports cleanly without a DSH host.
 */

import { COMMANDS, TOOL_DEFS, WORKER_TOOLS, LEAD_TOOLS, ALL_TOOLS, DEBUG_COMMANDS, createHandlers, validateToolArgs } from './index.js';
import { readPackageVersion } from '../../sdlc-guard/src/package-version.js';
import { contributeSelftest, setSelftestMeta } from './selftest.js';

/**
 * Runtime access for command execution, resolved lazily per call (never at
 * import time, so the module keeps importing cleanly without a DSH host).
 *
 * Layering note (E6): this module must NOT statically import sdlc-core —
 * the worker profile mounts tools without core. The runtime (or a
 * getRuntime factory) arrives via the row `config`, exactly like
 * `worktreePath` already does; `executeCommand` threads it through.
 */
function commandRuntime(config = {}) {
  if (typeof config.runtime === 'object' && config.runtime !== null) return config.runtime;
  if (typeof config.getRuntime === 'function') {
    try {
      const runtime = config.getRuntime(config);
      if (runtime && typeof runtime.open === 'function' && !runtime.db) {
        try { runtime.open(); } catch { return null; }
      }
      return runtime ?? null;
    } catch { return null; }
  }
  return null;
}

/** Bind command execution to one row config (kept for the test seam). */
function createCommandExecutor(config = {}) {
  return (name, input) => executeCommand(name, input, config);
}

// Keep this metadata on every loader entry, including the preset slices.
export const inject = ['tools'];

function pkgVersion() {
  return readPackageVersion(import.meta.url, 2);
}

/**
 * Register tool definitions on a DSH context.
 *
 * `config.tools` narrows the set to those names (the preset slices); omitting
 * it registers the complete surface (the host `sdlc-tools` row).
 */
export function registerTools(ctx, config = {}) {
  const registered = [];
  const selected = Array.isArray(config.tools) ? new Set(config.tools) : null;
  const worktreePath = config.worktreePath ?? process.cwd();
  const handlers = createHandlers({ worktreePath, runMeta: config.runMeta ?? {} });

  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    if (selected !== null && !selected.has(name)) continue;
    const handler = handlers[name];
    if (!handler) continue;
    // Harness consumes raw JSON Schema + execute, not a handler callback.
    // Registration errors must reject activation rather than report ghost tools.
    ctx.tools.register({
      ...def,
      execute: (args) => {
        // Raw register() definitions do not get defineTool's argument wrapper.
        const validation = validateToolArgs(name, args);
        if (!validation.ok) throw new TypeError(`${name}: ${validation.error}`);
        return handler(args);
      },
      output: {
        // Proposals carry different JSON payloads; do not claim only { ok }.
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: def.output.render(value) }],
      },
    });
    registered.push(name);
  }
  return registered;
}

/** Register the `/sdlc` command surface (interactive profiles only — E3). */
export function registerCommands(ctx, config = {}) {
  const registered = [];
  // Headless/preset compositions need no command adapter. Cordis optional
  // services must be probed with get(), not undeclared ctx.commands access.
  const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : ctx?.commands;
  // The runtime execute path for commands that act (run boots slices of this
  // module's own surface; authority commands are user-only and execute
  // directly against the transition service). Resolved lazily so the module
  // still imports cleanly without a DSH host.
  const runtimeForCommands = () => {
    try {
      if (typeof config.runtime === 'object' && config.runtime !== null) return config.runtime;
      if (typeof config.getRuntime === 'function') return config.getRuntime(config) ?? null;
      return null;
    } catch { return null; }
  };
  for (const name of COMMANDS) {
    registered.push(name);
    try {
      if (typeof commands?.register === 'function') {
        commands.register({
          definitionId: `sdlc.${name}`,
          name: `sdlc ${name}`,
          description: `SDLC orchestrator: ${name}`,
          input: { type: 'string' },
          handler: (input) => {
            if (ctx?.logger?.debug) ctx.logger.debug('sdlc %s %s', name, input ?? '');
            try {
              return executeCommand(name, input, { ...config, ctx });
            } catch (err) {
              return { ok: false, command: name, input: input ?? null, error: err?.message ?? String(err) };
            }
          },
        });
      }
    } catch (err) {
      if (ctx?.logger?.warn) ctx.logger.warn('sdlc-tools: failed to register command %s: %s', name, err?.message ?? err);
    }
  }
  return registered;
}

/**
 * Execute the commands that act. Commands without a direct execution keep
 * the legacy `{deferred:true}` report. Everything here is fail-closed:
 * no runtime, no DB, no throw — the caller resolves to an error report,
 * never a rejection.
 */
export function executeCommand(name, input, config = {}) {
  if (name === 'run') return executeRun(input, config);
  if (name === 'stop') return executeStop(input, config);
  if (name === 'retry') return executeRetry(input, config);
  if (name === 'approve' || name === 'reject' || name === 'elevate') {
    return executeAuthority(name, input, config);
  }
  return { ok: true, command: name, input: input ?? null, deferred: true };
}

function ensureProjectForCommand(runtime, projectRoot) {
  if (!runtime || typeof runtime.listTasks !== 'function') return null;
  try {
    const projects = runtime.db.prepare('SELECT * FROM projects ORDER BY created_at').all();
    if (projects.length > 0) return projects[0];
  } catch { /* fall through to create */ }
  try {
    return runtime.createProject({ name: 'default', repoPath: projectRoot });
  } catch { return null; }
}

/**
 * `/sdlc run <goal>`: bootstrap the flow. Ensures a project exists, then
 * creates ONE task from the goal text and returns
 * `{ok:true, command:'run', taskId, projectId}`. Synchronous and direct
 * against the runtime: resolve projectRoot from `config.worktreePath ??
 * config.projectRoot ?? process.cwd()`, take the injected runtime (or
 * `openRuntime`/`getRuntime` factory the host row provides — fail-closed on
 * throw → `{ok:false}`), ensure a project row, then a single addTask with
 * state BACKLOG. All OTHER commands keep the deferred stub — slice 3 owns
 * them.
 */
export function executeRun(input, config = {}) {
  const goal = String(input ?? '').trim();
  if (!goal) {
    return { ok: false, command: 'run', error: 'USAGE: /sdlc run <goal> — describe what to build' };
  }
  const projectRoot = config.worktreePath ?? config.projectRoot ?? process.cwd();
  // An injected runtime (or factory) wins — tests and the host pass one in.
  // Otherwise resolve against the per-project-root singleton and open it.
  let runtime = null;
  try {
    runtime = commandRuntime({ ...config, projectRoot });
    if (!runtime) {
      if (typeof config.openRuntime === 'function') {
        runtime = config.openRuntime(projectRoot);
      } else {
        return { ok: false, command: 'run', error: 'NO_RUNTIME: the orchestrator service is not available in this profile' };
      }
      if (runtime && typeof runtime.open === 'function' && !runtime.db) {
        try { runtime.open(); } catch (err) {
          return { ok: false, command: 'run', error: err?.message ?? String(err) };
        }
      }
    }
    if (!runtime) {
      return { ok: false, command: 'run', error: 'NO_RUNTIME: the orchestrator service is not available in this profile' };
    }
  } catch (err) {
    return { ok: false, command: 'run', error: err?.message ?? String(err) };
  }
  try {
    const projects = runtime.db.prepare('SELECT * FROM projects ORDER BY created_at').all();
    let project = projects[0] ?? null;
    if (!project) {
      try {
        project = runtime.createProject({ name: 'default', repoPath: projectRoot });
      } catch (err) {
        return { ok: false, command: 'run', error: `NO_PROJECT: ${err?.message ?? String(err)}` };
      }
    }
    if (!project) {
      return { ok: false, command: 'run', error: 'NO_PROJECT: could not ensure a project row' };
    }
    const id = `T-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')}`;
    const title = goal.length > 80 ? `${goal.slice(0, 77)}...` : goal;
    const task = runtime.addTask({
      id, project_id: project.id, title, objective: goal, role: 'business-analyst',
      acceptance_criteria: [], allowed_paths: [], verification: [],
    });
    return { ok: true, command: 'run', taskId: task.id, projectId: project.id };
  } catch (err) {
    return { ok: false, command: 'run', error: err?.message ?? String(err) };
  }
}

/** `/sdlc stop [task-id?]`: kill switch — cancel live tasks, record the event. */
export function executeStop(input, config = {}) {
  const runtime = commandRuntime(config);
  if (!runtime) return { ok: false, command: 'stop', error: 'NO_RUNTIME' };
  const only = String(input ?? '').trim() || null;
  const stopped = [];
  try {
    const tasks = runtime.listTasks();
    for (const task of tasks) {
      if (only && task.id !== only) continue;
      if (!['BACKLOG', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING'].includes(task.state)) continue;
      const res = runtime.transition(task.id, 'CANCELLED', 'human', { workerStopped: true });
      if (res.ok) stopped.push(task.id);
    }
    runtime.state.record({ actor: 'human', action: 'kill-switch', payload: { stopped } });
  } catch (err) {
    return { ok: false, command: 'stop', error: err?.message ?? String(err) };
  }
  return { ok: true, command: 'stop', stopped };
}

/** `/sdlc retry <task-id>`: FAILED → READY when budget remains, else ESCALATED. */
export function executeRetry(input, config = {}) {
  const taskId = String(input ?? '').trim();
  if (!taskId) return { ok: false, command: 'retry', error: 'USAGE: /sdlc retry <task-id>' };
  const runtime = commandRuntime(config);
  if (!runtime) return { ok: false, command: 'retry', error: 'NO_RUNTIME' };
  try {
    const task = runtime.getTask(taskId);
    if (!task) return { ok: false, command: 'retry', error: `NO_SUCH_TASK: ${taskId}` };
    if (task.state !== 'FAILED') return { ok: false, command: 'retry', error: `NOT_FAILED: ${taskId} is ${task.state}` };
    // The FAILED→READY/ESCALATED rows belong to the scheduler actor;
    // the user command drives the scheduler path (same as resume).
    const remaining = (task.retry_budget ?? 1) - (task.attempt ?? 0);
    const to = remaining > 0 ? 'READY' : 'ESCALATED';
    const res = runtime.transition(taskId, to, 'scheduler', { attempt: task.attempt ?? 0, retryBudget: task.retry_budget ?? 0, correctiveRetry: true });
    if (!res.ok) return { ok: false, command: 'retry', error: res.reason ?? res.error ?? 'INVALID_TRANSITION' };
    return { ok: true, command: 'retry', taskId, to };
  } catch (err) {
    return { ok: false, command: 'retry', error: err?.message ?? String(err) };
  }
}

/**
 * `/sdlc approve|reject|elevate`: authority commands execute directly
 * against the runtime (L.1 rule 4 — user-only, never a model tool).
 * Approve/reject resolve a queued approve proposal when one exists;
 * elevate records the escalation path. All fail-closed.
 */
export function executeAuthority(name, input, config = {}) {
  const runtime = commandRuntime(config);
  if (!runtime) return { ok: false, command: name, error: 'NO_RUNTIME' };
  try {
    if (name === 'approve' || name === 'reject') {
      const parts = String(input ?? '').trim().split(/\s+/).filter(Boolean);
      const [taskId, to] = parts;
      if (!taskId) return { ok: false, command: name, error: `USAGE: /sdlc ${name} <task-id> [to-state]` };
      const target = to ?? (name === 'approve' ? 'ACCEPTED' : 'FAILED');
      const res = runtime.transition(taskId, target, 'human', { decidedBy: 'human', via: `sdlc-${name}` });
      if (!res.ok) return { ok: false, command: name, error: res.reason ?? res.error ?? 'INVALID_TRANSITION' };
      return { ok: true, command: name, taskId, to: target };
    }
    const taskId = String(input ?? '').trim();
    if (!taskId) return { ok: false, command: 'elevate', error: 'USAGE: /sdlc elevate <task-id>' };
    const task = runtime.getTask(taskId);
    if (!task) return { ok: false, command: 'elevate', error: `NO_SUCH_TASK: ${taskId}` };
    return { ok: true, command: 'elevate', taskId, state: task.state, note: 'escalated for lead review' };
  } catch (err) {
    return { ok: false, command: name, error: err?.message ?? String(err) };
  }
}

/**
 * Build a loader entry for one preset-plane tool slice.
 *
 * The preset rows use the package's `./report`, `./dispatch` and `./plan`
 * exports, each of which is one of these. A slice registers only its tools
 * and NEVER the command surface: the host `sdlc-tools` row owns commands, and
 * mounting them once per preset would collide on the second mount.
 * @param {string[]} toolNames - the exact tool names this entry registers.
 * @returns {(ctx: object, config?: object) => undefined}
 */
export function toolSubsetPlugin(toolNames) {
  const tools = [...toolNames];
  return function applyToolSubset(ctx, config = {}) {
    setSelftestMeta({ version: pkgVersion() });
    contributeSelftest({ tools: registerTools(ctx, { ...config, tools }) });
  };
}

/**
 * Loader entry. MUST return nothing: the Cordis runner interprets a plugin's
 * return value as an effect (`TypeError: Invalid effect` for a
 * non-constructible apply; silently dropped for this regular-function apply).
 * Tests that want the registration report call `registerTools` /
 * `registerCommands` directly.
 * @returns {undefined}
 */
export function apply(ctx, config = {}) {
  setSelftestMeta({ version: pkgVersion() });
  const tools = registerTools(ctx, config);
  const commands = registerCommands(ctx, config);
  contributeSelftest({ tools, commands });
}

export { COMMANDS, TOOL_DEFS, WORKER_TOOLS, LEAD_TOOLS, ALL_TOOLS, DEBUG_COMMANDS };
