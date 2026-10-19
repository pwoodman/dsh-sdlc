/**
 * packages/sdlc-core/src/scheduler.js — task scheduling & lock policy (spec v3 B.2.1, B.10).
 *
 * The two claims the whole design rests on (K.3):
 *   "zero known ownership collisions" and "the runtime owns transitions".
 * Both are property-tested here: `checkNoOverlap` is the invariant, and
 * `planStep` returns only transitions in the B.2.1 matrix.
 *
 * The scheduler is pure over a plain state snapshot, so a random DAG can be
 * evolved in a unit test with no processes, no DB and no model.
 */

import { matchGlob } from './glob-lite.js';

export const DEP_BLOCKING_STATES = ['FAILED', 'BLOCKED', 'ESCALATED', 'CANCELLED'];

/** Static (wildcard-free) prefix of a glob, used for overlap detection. */
export function staticPrefix(pattern) {
  const p = String(pattern).replace(/^\.\//, '');
  const idx = p.search(/[*?]/);
  const head = idx === -1 ? p : p.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash + 1);
}

/** A representative concrete path for a glob (used to probe the other glob). */
export function samplePath(pattern) {
  return String(pattern)
    .replace(/^\.\//, '')
    .replace(/\*\*/g, 'x')
    .replace(/\*/g, 'y')
    .replace(/\?/g, 'z');
}

/**
 * Conservative overlap test for two ownership globs. Sound in the direction
 * that matters: it may report overlap for disjoint patterns (forcing
 * serialization) but never reports disjoint for genuinely overlapping ones.
 */
export function globsOverlap(a, b) {
  const A = String(a).replace(/^\.\//, '');
  const B = String(b).replace(/^\.\//, '');
  if (A === B) return true;
  if (matchGlob(A, samplePath(B)) || matchGlob(B, samplePath(A))) return true;
  const pa = staticPrefix(A);
  const pb = staticPrefix(B);
  if (!pa || !pb) return true; // a wildcard at the root overlaps everything
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export function overlapsAny(patterns = [], activePatterns = []) {
  for (const p of patterns) for (const q of activePatterns) if (globsOverlap(p, q)) return [p, q];
  return null;
}

export function dependencyStates(task, byId) {
  const out = {};
  for (const dep of task.depends_on ?? []) out[dep] = byId.get(dep)?.state ?? 'BACKLOG';
  return out;
}

export function depsAllDone(task, byId) {
  return (task.depends_on ?? []).every((d) => byId.get(d)?.state === 'DONE');
}

export function depsBlocking(task, byId) {
  return (task.depends_on ?? []).some((d) => DEP_BLOCKING_STATES.includes(byId.get(d)?.state));
}

/** Effective resources: explicit task_resources plus coarse ownership roots. */
export function resourcesOf(task, sharedResources = {}) {
  return [...new Set([...(task.resources ?? []), ...(sharedResources[task.id] ?? [])])].sort();
}

export function activeTasks(tasks) {
  return tasks.filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'VERIFYING'].includes(t.state));
}

/**
 * The no-overlap invariant (K.3): no two concurrently active tasks may have
 * overlapping allowed_paths or share a task_resources entry beyond the
 * configured cap.
 */
export function checkNoOverlap(tasks, { maxSharedResourceTasks = 1 } = {}) {
  const active = activeTasks(tasks);
  const violations = [];
  // Path ownership is a pairwise property: any overlap between two active tasks
  // is a violation regardless of the resource cap.
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      const pathHit = overlapsAny(a.allowed_paths ?? [], b.allowed_paths ?? []);
      if (pathHit) violations.push({ kind: 'ownership-overlap', a: a.id, b: b.id, patterns: pathHit });
    }
  }
  // Resources are a CAP, not a pairwise property: counting holders is required
  // for `maxSharedResourceTasks > 1`, where three holders of one resource is a
  // violation even though no PAIR of them exceeds the cap.
  const holders = new Map();
  for (const t of active) {
    for (const r of resourcesOf(t)) {
      if (!holders.has(r)) holders.set(r, []);
      holders.get(r).push(t.id);
    }
  }
  for (const [resource, ids] of holders) {
    if (ids.length <= maxSharedResourceTasks) continue;
    const violation = { kind: 'resource-collision', a: ids[0], b: ids[1] ?? null, resources: [resource] };
    // Preserve the documented 2-holder shape exactly; a wider overrun carries
    // the full holder list so the evidence says which cap was breached.
    if (ids.length > 2) Object.assign(violation, { holders: [...ids], cap: maxSharedResourceTasks });
    violations.push(violation);
  }
  return violations;
}

/** Locks grantable for `task` given the currently active tasks. */
export function locksGrantable(task, tasks, { maxSharedResourceTasks = 1 } = {}) {
  const active = activeTasks(tasks).filter((t) => t.id !== task.id);
  const pathHit = overlapsAny(task.allowed_paths ?? [], active.flatMap((t) => t.allowed_paths ?? []));
  if (pathHit) return { ok: false, reason: `ownership conflict with ${pathHit[1]}` };
  const mine = resourcesOf(task);
  for (const r of mine) {
    const holders = active.filter((t) => resourcesOf(t).includes(r));
    if (holders.length >= maxSharedResourceTasks) {
      return { ok: false, reason: `resource ${r} locked by ${holders[0].id}` };
    }
  }
  return { ok: true };
}

export function effectiveParallelism({ maxParallelWorkers = 'auto', cpus = 1, ramGb = 4, providerLimit = Infinity, configured = Infinity } = {}) {
  const auto = Math.min(Math.floor(cpus / 2), Math.floor(ramGb / 2), providerLimit, configured);
  const value = maxParallelWorkers === 'auto' ? auto : Number(maxParallelWorkers);
  return Math.max(1, Math.floor(Math.min(value, providerLimit, configured)));
}

/**
 * Pure scheduling step. Returns the transitions the runtime should apply.
 * Deterministic: tasks are processed in stable id order.
 */
export function planStep(state, {
  maxParallelWorkers = 4,
  maxSharedResourceTasks = 1,
  waitBudgetExceeded = {},
} = {}) {
  const tasks = [...(state.tasks ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const transitions = [];

  for (const task of tasks) {
    if (task.state !== 'BACKLOG') continue;
    if (depsBlocking(task, byId)) {
      transitions.push({ taskId: task.id, to: 'BLOCKED', actor: 'scheduler', ctx: { depStates: dependencyStates(task, byId) } });
    } else if (depsAllDone(task, byId)) {
      transitions.push({ taskId: task.id, to: 'READY', actor: 'scheduler', ctx: { depStates: dependencyStates(task, byId) } });
    }
  }

  // Recompute active set including transitions proposed above (READY is not
  // active). Copy every task: the working snapshot mutates state below, and
  // aliasing the caller's objects would leak those mutations into its DAG.
  const projected = tasks.map((task) => ({ ...task }));
  for (const change of transitions) {
    const task = projected.find((candidate) => candidate.id === change.taskId);
    if (task) task.state = change.to;
  }

  let activeCount = activeTasks(projected).length;
  for (const task of projected) {
    if (task.state !== 'READY') continue;
    if (activeCount >= maxParallelWorkers) break;
    const lock = locksGrantable(task, projected, { maxSharedResourceTasks });
    if (lock.ok) {
      transitions.push({ taskId: task.id, to: 'ASSIGNED', actor: 'scheduler', ctx: { locks: resourcesOf(task) } });
      // Mutate the working snapshot so the NEXT candidate sees this lock as
      // taken — otherwise two tasks could both be granted one resource.
      task.state = 'ASSIGNED';
      activeCount += 1;
    } else if (waitBudgetExceeded[task.id]) {
      transitions.push({
        taskId: task.id,
        to: 'BLOCKED',
        actor: 'scheduler',
        ctx: { waitBudgetExceeded: true, waiting_on: lock.reason },
      });
      task.state = 'BLOCKED';
    }
  }

  return transitions;
}

/** Topological order; `null` on a cycle (the planner must reject cycles). */
export function topoSort(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set();
  const temp = new Set();
  const order = [];
  let cycle = false;
  const visit = (id) => {
    if (cycle || visited.has(id)) return;
    if (temp.has(id)) { cycle = true; return; }
    temp.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep);
    temp.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const t of [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)))) visit(t.id);
  return cycle ? null : order;
}

/** Derived readiness used by recovery/resume (B.12). */
export function recomputeReadiness(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  for (const t of tasks) {
    let next = t.state;
    if (t.state === 'BACKLOG') {
      if (depsBlocking(t, byId)) next = 'BLOCKED';
      else if (depsAllDone(t, byId)) next = 'READY';
    }
    if (next !== t.state) out.push({ taskId: t.id, from: t.state, to: next });
  }
  return out;
}

export default {
  planStep, checkNoOverlap, locksGrantable, globsOverlap, topoSort, recomputeReadiness, effectiveParallelism,
};
