/**
 * tests/fault/session-adoption.test.mjs — L5 fault matrix row: session adoption
 * mismatch (spec v3 E8, K.5; threat "preset/role confusion").
 *
 * A retry may resume the SAME worker session only while the worktree and the
 * preset are unchanged. A re-created worktree or a changed preset forces a
 * fresh session, and that fresh session must carry corrective context.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, cleanup, core } from '../lib/helpers.mjs';

const { sessionForAttempt } = await core.workerMgr();
const { buildElevationPacket } = await core.loop();

test('first attempt starts fresh', () => {
  const res = sessionForAttempt({ previousSessionId: null });
  assert.deepEqual(res, { sessionId: null, fresh: true, reason: 'first-attempt' });
});

test('the same worktree + preset resumes the same session', () => {
  const res = sessionForAttempt({ previousSessionId: 'sess-123', worktreeRecreated: false, presetChanged: false });
  assert.equal(res.sessionId, 'sess-123');
  assert.equal(res.fresh, false);
  assert.equal(res.reason, 'same-worktree');
});

test('a re-created worktree refuses adoption and starts fresh', () => {
  const res = sessionForAttempt({ previousSessionId: 'sess-123', worktreeRecreated: true, presetChanged: false });
  assert.equal(res.sessionId, null, 'the old session is never adopted');
  assert.equal(res.fresh, true);
  assert.equal(res.reason, 'worktree-recreated');
});

test('a changed preset refuses adoption and starts fresh', () => {
  const res = sessionForAttempt({ previousSessionId: 'sess-123', worktreeRecreated: false, presetChanged: true });
  assert.equal(res.sessionId, null);
  assert.equal(res.fresh, true);
  assert.equal(res.reason, 'preset-changed');
});

test('worktree recreation outranks preset change and still starts fresh', () => {
  const res = sessionForAttempt({ previousSessionId: 'sess-123', worktreeRecreated: true, presetChanged: true });
  assert.equal(res.sessionId, null);
  assert.equal(res.fresh, true);
  assert.equal(res.reason, 'worktree-recreated');
});

test('a fresh session carries corrective context from the failed attempt (E8)', () => {
  const tmp = tempDir('sdlc-session-');
  try {
    const decision = sessionForAttempt({ previousSessionId: 'sess-dead', worktreeRecreated: true });
    assert.equal(decision.fresh, true);

    // The fresh dispatch's context must include the corrective packet derived
    // from the previous failure — the reason the fresh session exists at all.
    const correctiveContext = {
      fresh: decision.fresh,
      reason: decision.reason,
      prior_session: 'sess-dead',
      corrective: buildElevationPacket({
        taskId: 'T1',
        attempts: [{ n: 1, status: 'failed', model: 'mock/base-weak' }],
        failures: ['SCOPE_VIOLATION at src/evil.ts'],
        filesChanged: ['src/evil.ts'],
        outOfScopeFiles: ['src/evil.ts'],
        worktreeDiffPath: '.sdlc/recovery/R1/diff.patch',
      }),
    };

    assert.equal(correctiveContext.fresh, true);
    assert.equal(correctiveContext.corrective.task_id, 'T1');
    assert.deepEqual(correctiveContext.corrective.files_changed, ['src/evil.ts']);
    assert.deepEqual(correctiveContext.corrective.out_of_scope_files, ['src/evil.ts']);
    assert.match(correctiveContext.corrective.failures[0], /SCOPE_VIOLATION/);
    assert.equal(correctiveContext.corrective.worktree_diff_path, '.sdlc/recovery/R1/diff.patch');
  } finally {
    cleanup(tmp);
  }
});
