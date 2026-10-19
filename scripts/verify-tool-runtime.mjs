#!/usr/bin/env node
/** Offline proof using an unpacked, installed DSH runtime. No server or model.
 * node scripts/verify-tool-runtime.mjs <runtime-directory>
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import foldMeta from './lib/fold-meta.cjs';
import { presetRows, PUBLIC_ROLE_IDS, presetIdFor } from '../packages/sdlc-presets/src/roles.js';

const runtime = resolve(process.argv[2] ?? '.tools/dsh');
const pkg = (name) => pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', name, 'lib/index.js')).href;
const { Context, Service } = await import(pkg('cordis'));
const { default: Loader } = await import(pkg('cordis-plugin-loader'));
const { ToolRuntime } = await import(pkg('dsh-tools'));
const { default: Presets } = await import(pkg('dsh-agent-preset-registry'));
const { createScope, scopeOf } = await import(pkg('dsh-scope'));
const root = new Context();
const { default: Prompt } = await import(pkg('dsh-system-prompt'));
class Projections extends Service {
  constructor(ctx) { super(ctx, 'sessionProjections'); this.register = () => () => {}; }
}
await root.plugin(Loader);
await root.plugin(Prompt);
await root.plugin(Projections);
// Non-exercised OS/delegation boundaries: no process, file operation, or model
// is allowed in this mounting check. Real tool consumers still parse configs.
await root.plugin((ctx) => {
  const unavailable = () => { throw new Error('OS/delegation boundary not exercised by this check'); };
  ctx.provide('shell', { sandboxMode: undefined, execute: unavailable, resolve: unavailable });
  ctx.provide('shellEnv', { collect: unavailable });
  ctx.provide('workingDirectory', { ensure: unavailable });
  ctx.provide('fs', { sandboxMode: undefined });
  ctx.provide('subagents', { getProvider: () => undefined });
});
await root.plugin(ToolRuntime, { mode: 'native' });
await root.plugin(Presets, { default: 'sdlc-lead' });
const tools = root.get('tools');
const registry = root.get('agentPresets');
const metaDir = resolve(process.argv[3] ?? 'packages/sdlc-orchestrator');
const require = createRequire(join(metaDir, 'package.json'));
const { load: loadYaml } = await import(pathToFileURL(join(runtime, 'node_modules/js-yaml/dist/js-yaml.mjs')).href);
const patch = loadYaml(readFileSync(join(metaDir, 'cordis.patch.yml'), 'utf8').replace(/!!js process\.cwd\(\)/g, 'null'));
const publicPresets = patch.flatMap((item) => item.insert ?? []).filter((row) => row.name === '@deepseek-ai/dsh-agent-preset');
const expectedPublic = PUBLIC_ROLE_IDS.map(presetIdFor);
assert.deepEqual(
  publicPresets.map((row) => row.id).sort(),
  [...expectedPublic].sort(),
  'the shipped lead exposes exactly the public role presets',
);

// The lead artifact is the user-facing surface. The full role compositions
// stay in roles.js (and in the probe bundle), so keep exercising all of them
// here; fold the row names exactly as the lead patch does when the meta package
// is self-contained.
const allRows = presetRows().filter((row) => row.id !== 'agent-preset-registry');
const metaManifest = JSON.parse(readFileSync(join(metaDir, 'package.json'), 'utf8'));
const foldedArtifact = !metaManifest.dependencies && Boolean(metaManifest.exports?.['./services']);
const rewritten = foldedArtifact
  ? foldMeta.rewritePatch(JSON.stringify(allRows))
  : JSON.stringify(allRows);
const presets = JSON.parse(rewritten);
assert.equal(presets.length, 26, 'the role registry contains every composition');
const rows = (id) => {
  const preset = presets.find((row) => row.config.id === id);
  assert.ok(preset, `missing role composition ${id}`);
  return preset.config.plugins.map((row) => ({
    ...row,
    // Exercise shipped configs on real host entries, resolving from their actual
    // package roots. Absolute URLs avoid installing a scratch profile/server.
    name: pathToFileURL(row.name.startsWith('@patwoodman/')
      ? require.resolve(row.name)
      : createRequire(join(runtime, 'package.json')).resolve(row.name)).href,
  }));
};
try {
  for (const preset of presets) {
    await registry.register({ ...preset.config, plugins: rows(preset.config.id) });
  }
  // Check every role, not merely a representative worker. Retained generations
  // are the same API session creation uses to admit a selected preset.
  for (const preset of presets) {
    const role = createScope(root, {});
    try {
      await registry.mount(role.ctx, preset.config.id);
      const names = tools.schemas(scopeOf(role.ctx)).map((schema) => schema.name).filter((name) => name.startsWith('sdlc_'));
      assert.equal(names.length, preset.config.id === 'sdlc-lead' ? 7 : 3, `${preset.config.id}: wrong SDLC tool surface`);
    } finally {
      await role.dispose();
    }
  }
  const lead = createScope(root, {});
  const worker = createScope(root, {});
  try {
    await registry.mount(lead.ctx, 'sdlc-lead');
    await registry.mount(worker.ctx, 'sdlc-backend-engineer');
    assert.equal(tools.schemas().length, 0, 'no globally leaked SDLC tools');
    const leadNames = tools.schemas(scopeOf(lead.ctx)).map((s) => s.name).filter((name) => name.startsWith('sdlc_'));
    const workerNames = tools.schemas(scopeOf(worker.ctx)).map((s) => s.name).filter((name) => name.startsWith('sdlc_'));
    assert.equal(leadNames.length, 7);
    assert.deepEqual(workerNames.sort(), ['sdlc_claim_check', 'sdlc_report_result', 'sdlc_request_decision']);
    const args = { question: 'Choose a schema', decision: 'A' };
    const definition = tools.get('sdlc_record_decision', scopeOf(lead.ctx));
    const result = await tools.execute({
      name: 'sdlc_record_decision', arguments: args, agent: scopeOf(lead.ctx),
      callId: 'verify-sdlc-decision', signal: new AbortController().signal,
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    const value = result.value;
    assert.equal(value.ok, true);
    assert.equal(value.proposal.kind, 'decision');
    assert.equal(definition.output.render(args, value)[0].type, 'text');
    assert.equal(result.content[0].type, 'text');
    const denied = await tools.execute({
      name: 'sdlc_record_decision', arguments: args, agent: scopeOf(worker.ctx),
      callId: 'verify-worker-denied', signal: new AbortController().signal,
    });
    assert.equal(denied.isError, true, 'workers must not execute lead-only tools');
    const invalid = await tools.execute({
      name: 'sdlc_record_decision', arguments: {}, agent: scopeOf(lead.ctx),
      callId: 'verify-invalid-arguments', signal: new AbortController().signal,
    });
    assert.equal(invalid.isError, true, 'schema validation must reject missing arguments');
    console.log(`PASS: ${presets.length} role compositions mount; lead exposes ${publicPresets.length} selectable preset(s); 7/3 scoped SDLC tools; actual execution pipeline; worker/invalid-input negative controls (OS/delegation boundaries stubbed)`);
  } finally {
    await lead.dispose();
    await worker.dispose();
  }
} finally {
  await root.fiber.dispose();
}
