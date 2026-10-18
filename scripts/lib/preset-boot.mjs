/**
 * scripts/lib/preset-boot.mjs — prove the packaged presets actually MOUNT.
 *
 * WHY THIS EXISTS. beta.19 passed every static preset test and every gate, then
 * failed the only thing a user does: create a session with `sdlc-lead`. The
 * preset's `tool-todo` / `tool-subagent` configs were missing required DSH
 * values, and the three SDLC tool rows named a data-only package root, so the
 * registry answered `agent-preset/invalid` and the session never started.
 * `agent-preset` rows are validated at session creation, not at boot, so
 * `--dump-config`, the M0 probe and `SDLC_SELFTEST` cannot see it.
 *
 * This helper drives the real path over the same HTTP API the web UI uses:
 *
 *   1. boot `dsh --profile <lead> web` on an ephemeral port;
 *   2. authenticate with the launch token (the URL `dsh web` prints);
 *   3. POST `session/create` with `agentPreset: "sdlc-lead"`;
 *   4. require `ok: true` and the exact preset back.
 *
 * A broken preset fails with the registry's diagnostic verbatim, so the gate
 * reports `tool-todo ... invalid config` / `never started` instead of a vague
 * session error.
 *
 * Node built-ins only — no Playwright, no browser, no model call.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Strip the `; Path=/; HttpOnly; ...` suffix from a Set-Cookie value. */
function cookiePair(setCookie) {
  return String(setCookie ?? '').split(';', 1)[0];
}

/** Kill a child and wait briefly for it to leave, escalating to SIGKILL. */
function stopChild(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch {
      resolve();
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      resolve();
    }, 5_000).unref();
  });
}

/**
 * Boot the web UI and create one `sdlc-lead` session.
 *
 * @param {object} options
 * @param {string} [options.dshBin] - CLI entry (`lib/bin.js`); omitted = `dsh` on PATH.
 * @param {string} [options.dshHome] - DSH_HOME for the scratch profile.
 * @param {string} options.profile - web profile to boot (for example `sdlc-web`).
 * @param {string} options.cwd - workspace the session opens in.
 * @param {string} [options.preset] - preset to retain; defaults to `sdlc-lead`.
 * @param {NodeJS.ProcessEnv} [options.env] - child environment.
 * @param {number} [options.timeoutMs] - whole-operation bound.
 * @returns {Promise<{ sessionId: string, agentPreset: string, url: string }>}
 */
export async function createLeadSession({
  dshBin,
  dshHome,
  profile,
  cwd,
  preset = 'sdlc-lead',
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const command = dshBin === undefined ? 'dsh' : process.execPath;
  const args = [
    ...(dshBin === undefined ? [] : [dshBin]),
    '--profile', profile,
    '--no-open',
    '--port', '0',
  ];
  const child = spawn(command, args, {
    cwd,
    env: {
      ...env,
      ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer;

  const result = await new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const maybeUrl = () => {
      const match = /(http:\/\/127\.0\.0\.1:(\d+)\/)\?token=(\S+)/.exec(stdout);
      if (match !== null) finish(resolve, { url: `${match[1]}?token=${match[3]}`, origin: match[1].slice(0, -1) });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      maybeUrl();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.once('error', (error) => finish(reject, new Error(`preset-boot: cannot start dsh: ${error.message}`)));
    child.once('exit', (code, signal) => {
      finish(reject, new Error(
        `preset-boot: dsh exited before serving (code ${String(code)}, signal ${String(signal)})\n` +
        `${(stderr || stdout).trim().slice(-2_000)}`,
      ));
    });
    timer = setTimeout(() => {
      finish(reject, new Error(`preset-boot: dsh did not serve within ${timeoutMs}ms\n${(stderr || stdout).trim().slice(-2_000)}`));
    }, timeoutMs);
    maybeUrl();
  }).catch(async (error) => {
    await stopChild(child);
    throw error;
  });

  try {
    const login = await fetch(result.url, {
      redirect: 'manual',
      headers: { 'sec-fetch-site': 'none' },
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie');
    if (login.status !== 303 || !setCookie) {
      throw new Error(`preset-boot: web login failed (HTTP ${login.status}, cookie ${setCookie ? 'present' : 'missing'})`);
    }
    const response = await fetch(`${result.origin}/api/session/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookiePair(setCookie),
        origin: result.origin,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'preset-boot',
        method: 'session/create',
        payload: { args: { request: { cwd, agentPreset: preset } } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    const rpc = body?.result;
    if (rpc?.ok !== true) {
      const detail = rpc?.error?.message ?? JSON.stringify(body).slice(0, 2_000);
      throw new Error(`preset-boot: session/create rejected the ${JSON.stringify(preset)} preset:\n${detail}`);
    }
    if (rpc.value?.agentPreset !== preset) {
      throw new Error(`preset-boot: session created with preset ${JSON.stringify(rpc.value?.agentPreset)} instead of ${JSON.stringify(preset)}`);
    }
    return { sessionId: rpc.value.sessionId, agentPreset: rpc.value.agentPreset, url: result.url };
  } finally {
    await stopChild(child);
  }
}
