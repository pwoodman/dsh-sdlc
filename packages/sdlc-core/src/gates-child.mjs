#!/usr/bin/env node
/**
 * packages/sdlc-core/src/gates-child.mjs — one verification pass in a child.
 *
 * `runVerification` uses a synchronous runner (spawnSync) by design — gate
 * commands are real processes and the harness runs them inline. Running them
 * synchronously inside a host that also serves the panel would freeze the UI
 * for the duration of `npm test`. This shim keeps the contract and moves the
 * blocking part into a child process:
 *
 *   node gates-child.mjs '<json payload>'
 *
 * Payload: { cwd, gates, config, taskId, logDir, skipGates, changedFiles }.
 * Output: the `runVerification` result as one JSON line on stdout. Any crash
 * is reported by the caller (advanceFlow) as a verify-harness failure — the
 * gates never silently pass.
 */

import { runVerification } from './gates.js';

async function main() {
  const payload = JSON.parse(process.argv[2] ?? '{}');
  const result = runVerification({
    cwd: payload.cwd,
    gates: payload.gates,
    config: payload.config ?? {},
    taskId: payload.taskId ?? 'TASK',
    logDir: payload.logDir,
    skipGates: payload.skipGates ?? [],
    changedFiles: payload.changedFiles ?? [],
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

main().catch((err) => {
  process.stderr.write(`gates-child: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
