/**
 * eval/lib/session.mjs — locate a run's persisted Session and read its identity.
 *
 * The harness must be able to answer "which model actually ran?" and, when the
 * NDJSON stream carries no usage, "what did the run cost in tokens?". Both live
 * in DSH's persisted session log, which is written under
 * `$DSH_HOME/sessions/<project>/<session>/session.jsonl[.zstd]`.
 *
 * A `--session-id` cannot be pre-assigned for a NEW session (DSH only adopts an
 * existing one), so the log is discovered by scanning the sessions tree for the
 * project directory whose log is newer than the run's start, then confirmed by
 * the `cwd` recorded in the log's own `session` event. That makes discovery
 * robust to DSH's project-directory encoding rather than guessing at it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { splitZstdFrames } from './zstd-frames.mjs';
import { parseJsonl } from './usage.mjs';

/** Default DSH home, matching the launcher's own resolution. */
export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function isZstdBuf(buf) {
  return buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
}

/** Decompressed text of the first `maxFrames` frames (or whole plain file). */
function readLeadingText(path, maxFrames) {
  const buf = readFileSync(path);
  if (!isZstdBuf(buf)) return { text: buf.toString('utf8'), frames: 1, complete: true };
  const { frames, complete } = splitZstdFrames(buf);
  const parts = [];
  for (const frame of frames.slice(0, maxFrames)) {
    try {
      parts.push(zstdDecompressSync(frame));
    } catch {
      return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length, complete: false };
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: Math.min(frames.length, maxFrames), complete: complete && frames.length <= maxFrames };
}

/**
 * Read a session log's identity: id, cwd, and the agent's provider/model.
 *
 * Only the leading frames are decoded (the `session` and `request/header`
 * events are written first), so this stays cheap on a multi-megabyte log.
 * @returns {{id:string|null, cwd:string|null, createdAt:number|null, provider:string|null, model:string|null, framesScanned:number, complete:boolean}}
 */
export function readSessionInfo(path, { maxFrames = 400 } = {}) {
  const { text, frames, complete } = readLeadingText(path, maxFrames);
  const { events } = parseJsonl(text);
  const out = { id: null, cwd: null, createdAt: null, provider: null, model: null, framesScanned: frames, complete };
  for (const ev of events) {
    if (out.id == null && ev?.type === 'session') {
      out.id = typeof ev.id === 'string' ? ev.id : null;
      out.cwd = typeof ev.cwd === 'string' ? ev.cwd : null;
      out.createdAt = typeof ev.createdAt === 'number' ? ev.createdAt : null;
    }
    if (out.model == null && ev?.type === 'request/header') {
      const config = ev?.data?.header?.config;
      if (config && typeof config === 'object') {
        out.provider = typeof config.provider === 'string' ? config.provider : null;
        out.model = typeof config.model === 'string' ? config.model : null;
      }
    }
    if (out.id != null && out.model != null) break;
  }
  return out;
}

/**
 * Every session log on disk newer than `sinceMs`, newest first.
 * The project directory is not decoded here; the caller confirms `cwd` via
 * {@link readSessionInfo} so an encoding mismatch cannot select the wrong run.
 */
export function findSessionLogs({ home = defaultDshHome(), sinceMs = 0 } = {}) {
  const root = join(home, 'sessions');
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions;
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(projectDir, session.name);
      let names;
      try {
        names = readdirSync(sessionDir);
      } catch {
        continue;
      }
      // DSH writes a versioned name (`session.v4.jsonl.zstd`), while older logs
      // are `session.jsonl.zstd`. Match both rather than a single hard-coded one.
      const scored = names
        .filter((f) => /^session(\.[A-Za-z0-9_-]+)*\.jsonl(\.zstd)?$/.test(f))
        .map((f) => {
          const path = join(sessionDir, f);
          try {
            return { path, mtimeMs: statSync(path).mtimeMs, zstd: f.endsWith('.zstd') };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (scored.length === 0) continue;
      // Prefer a compressed log, then the newest.
      scored.sort((a, b) => Number(b.zstd) - Number(a.zstd) || b.mtimeMs - a.mtimeMs);
      const chosen = scored[0];
      if (chosen.mtimeMs < sinceMs) continue;
      out.push({ id: session.name, path: chosen.path, mtimeMs: chosen.mtimeMs, project: project.name });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The session log for a run that started at `sinceMs` in `cwd`, or null.
 * The newest candidate that records the same `cwd` wins; a candidate whose
 * leading frames are unreadable is skipped rather than guessed at.
 */
export function findSessionForRun({ home = defaultDshHome(), cwd, sinceMs = 0 } = {}) {
  for (const candidate of findSessionLogs({ home, sinceMs })) {
    try {
      const info = readSessionInfo(candidate.path);
      if (cwd && info.cwd && info.cwd !== cwd) continue;
      return { ...candidate, info };
    } catch {
      continue;
    }
  }
  return null;
}

export default { defaultDshHome, readSessionInfo, findSessionLogs, findSessionForRun };
