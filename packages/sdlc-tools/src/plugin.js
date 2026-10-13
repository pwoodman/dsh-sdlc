/**
 * packages/sdlc-tools/src/plugin.js — DSH registration for tools and commands.
 *
 * Model tools are propose-only; authority-granting actions are user-only
 * command handlers (C.4, authoring constraint 4). Registration is defensive so
 * the package imports cleanly without a DSH host.
 */

import { readFileSync } from 'node:fs';
import { COMMANDS, TOOL_DEFS, WORKER_TOOLS, LEAD_TOOLS, ALL_TOOLS, DEBUG_COMMANDS, createHandlers } from './index.js';
import { contributeSelftest, setSelftestMeta } from './selftest.js';

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

/** Register every tool definition on a DSH context. */
export function registerTools(ctx, config = {}) {
  const registered = [];
  const worktreePath = config.worktreePath ?? process.cwd();
  const handlers = createHandlers({ worktreePath, runMeta: config.runMeta ?? {} });

  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    const handler = handlers[name];
    if (!handler) continue;
    registered.push(name);
    try {
      if (typeof ctx?.tools?.register === 'function') {
        ctx.tools.register({
          ...def,
          handler: (args) => handler(args),
        });
      }
    } catch (err) {
      if (ctx?.logger?.warn) ctx.logger.warn('sdlc-tools: failed to register %s: %s', name, err?.message ?? err);
    }
  }
  return registered;
}

/** Register the `/sdlc` command surface (interactive profiles only — E3). */
export function registerCommands(ctx, config = {}) {
  const registered = [];
  for (const name of COMMANDS) {
    registered.push(name);
    try {
      if (typeof ctx?.commands?.register === 'function') {
        ctx.commands.register({
          definitionId: `sdlc.${name}`,
          name: `sdlc ${name}`,
          description: `SDLC orchestrator: ${name}`,
          input: { type: 'string' },
          handler: (input) => {
            if (ctx?.logger?.debug) ctx.logger.debug('sdlc %s %s', name, input ?? '');
            return { ok: true, command: name, input: input ?? null, deferred: true };
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
