/**
 * eval/lib/env.mjs — the frozen-environment identity stamped into every record.
 *
 * EVAL_PROTOCOL.md requires host/node/git/dsh versions in every run record: a
 * result that cannot name the runtime it was produced on is not reproducible,
 * and a DSH version bump between arms would invalidate the comparison. Every
 * probe here is best-effort and returns null rather than throwing, because a
 * missing version must show up as a gap in the record, never abort a paid run.
 */

import { spawnSync } from 'node:child_process';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';

function probe(spawn, cmd, args) {
  try {
    const res = spawn(cmd, args, { encoding: 'utf8', timeout: 20_000 });
    if (res.status !== 0) return null;
    return String(res.stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Collect the environment identity for a record.
 * @param {{spawn?:Function}} [opts]
 * @returns {{capturedAt:string, node:string, dsh:string|null, git:string|null, platform:string, arch:string, osRelease:string, hostname:string|null, cpuCount:number|null, totalMemBytes:number|null}}
 */
export function collectEnvironment({ spawn = spawnSync } = {}) {
  const cpusList = cpus();
  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    dsh: probe(spawn, 'dsh', ['--version']),
    git: probe(spawn, 'git', ['--version']),
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    hostname: hostname() || null,
    cpuCount: Array.isArray(cpusList) ? cpusList.length : null,
    totalMemBytes: totalmem(),
  };
}

export default { collectEnvironment };
