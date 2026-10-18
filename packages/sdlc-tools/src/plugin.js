/**
 * packages/sdlc-tools/src/plugin.js — DSH registration for tools and commands.
 *
 * Model tools are propose-only; authority-granting actions are user-only
 * command handlers (C.4, authoring constraint 4). Registration is defensive so
 * the package imports cleanly without a DSH host.
 */

import { readFileSync } from 'node:fs';
import { COMMANDS, TOOL_DEFS, WORKER_TOOLS, LEAD_TOOLS, ALL_TOOLS, DEBUG_COMMANDS, createHandlers, validateToolArgs } from './index.js';
import { contributeSelftest, setSelftestMeta } from './selftest.js';

// Keep this metadata on every loader entry, including the preset slices.
export const inject = ['tools'];

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
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
