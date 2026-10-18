/** Real Cordis lifecycle coverage: a successful import is not tool registration. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// CI can select its installed host explicitly; otherwise prefer extracted Desktop.
const runtimeBase = process.env.SDLC_VERIFY_RUNTIME
  ? pathToFileURL(join(resolve(process.env.SDLC_VERIFY_RUNTIME), 'node_modules/@deepseek-ai/')).href
  : existsSync(new URL('../../.validation/desktop-runtime/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url))
    ? '../../.validation/desktop-runtime/node_modules/@deepseek-ai/'
    : '../../.tools/dsh/node_modules/@deepseek-ai/';
const hasRuntime = existsSync(new URL(`${runtimeBase}cordis/lib/index.js`, import.meta.url));
const { Context } = hasRuntime ? await import(new URL(`${runtimeBase}cordis/lib/index.js`, import.meta.url)) : {};
const { default: Loader } = hasRuntime ? await import(new URL(`${runtimeBase}cordis-plugin-loader/lib/index.js`, import.meta.url)) : {};
const runtimeOptions = { skip: hasRuntime ? false : 'No installed Cordis runtime; run verify-tool-runtime with an unpacked host' };
// Cordis const-enum states are erased from its JavaScript exports.
const FiberState = { PENDING: 0, ACTIVE: 2 };

const surfaces = {
  report: ['sdlc_report_result', 'sdlc_claim_check', 'sdlc_request_decision'],
  dispatch: ['sdlc_dispatch_task', 'sdlc_approve_transition', 'sdlc_record_decision'],
  plan: ['sdlc_plan_delta'],
};
const entries = [
  ['source', '../../packages/sdlc-tools/src/'],
  ['folded', '../../packages/sdlc-orchestrator/lib/rows/tools/lib/'],
];

for (const [kind, base] of entries) {
  for (const [slice, names] of Object.entries(surfaces)) {
    test(`${kind} ${slice}: loader preserves tools injection and waits for provider`, runtimeOptions, async () => {
      const namespace = await import(new URL(`${base}${slice}.js`, import.meta.url));
      assert.equal(Object.hasOwn(namespace, 'default'), false, 'a bare default apply strips named inject');
      assert.deepEqual(namespace.inject, ['tools']);
      const plugin = Loader.prototype.unwrapExports(namespace);
      assert.equal(plugin, namespace);
      assert.equal(typeof plugin.apply, 'function');
      const ctx = new Context();
      const definitions = new Map();
      let commandRegistrations = 0;
      let provider;
      const consumer = ctx.plugin(plugin, { worktreePath: null });
      try {
        await consumer.await();
        assert.equal(consumer.state, FiberState.PENDING);
        assert.deepEqual(Object.keys(consumer.inject), ['tools']);
        assert.equal(definitions.size, 0);
        provider = ctx.plugin((child) => {
          child.provide('tools', {
            register(definition) {
              assert.ok(!definitions.has(definition.name), 'duplicate tool registration');
              definitions.set(definition.name, definition);
            },
          });
          child.provide('commands', { register() { commandRegistrations++; } });
        });
        await provider.await();
        await consumer.await();
        assert.equal(consumer.state, FiberState.ACTIVE);
        assert.deepEqual([...definitions.keys()], names);
        assert.equal(commandRegistrations, 0, 'preset slices must not mount host commands');
        const { TOOL_DEFS } = await import(new URL(`${base}index.js`, import.meta.url));
        for (const definition of definitions.values()) {
          assert.equal(typeof definition.execute, 'function');
          assert.equal(Object.hasOwn(definition, 'handler'), false);
          assert.equal(definition.parameters.type, 'object');
          assert.equal(definition.output.schema.type, 'object');
          const rendered = definition.output.render({ ok: false }, { ok: true, count: 2, task_id: 'T' });
          assert.ok(Array.isArray(rendered), 'render must return host content blocks');
          assert.ok(rendered.length > 0);
          assert.equal(rendered[0].type, 'text');
          assert.equal(typeof rendered[0].text, 'string');
          assert.ok(rendered[0].text.length > 0, 'render must read output value, not arguments');
          assert.equal(rendered[0].text, TOOL_DEFS[definition.name].output.render({ ok: true, count: 2, task_id: 'T' }));
        }
        const executable = definitions.get(slice === 'report' ? 'sdlc_claim_check'
          : slice === 'dispatch' ? 'sdlc_dispatch_task' : 'sdlc_plan_delta');
        const args = slice === 'report' ? { ac_id: 'AC1', claim: 'pass' }
          : slice === 'dispatch' ? { task_id: 'T' } : { tasks: [{ id: 'T' }] };
        const value = await executable.execute(args, {});
        assert.equal(typeof value.ok, 'boolean');
        if (slice === 'dispatch') assert.match(value.error, /INVALID_TRANSITION/);
        else assert.equal(value.ok, true);
        if (slice === 'plan') assert.equal(value.count, 1);
      } finally {
        await consumer.dispose();
        if (provider) await provider.dispose();
      }
    });

    test(`${kind} ${slice}: registration errors reject activation`, runtimeOptions, async () => {
      const namespace = await import(new URL(`${base}${slice}.js`, import.meta.url));
      const ctx = new Context();
      const failure = new Error(`registration rejected: ${kind}/${slice}`);
      const provider = ctx.plugin((child) => {
        child.provide('tools', { register() { throw failure; } });
      });
      await provider.await();
      const consumer = ctx.plugin(Loader.prototype.unwrapExports(namespace));
      try {
        await assert.rejects(consumer.await(), (error) => error === failure);
        assert.notEqual(consumer.state, FiberState.ACTIVE);
      } finally {
        await consumer.dispose();
        await provider.dispose();
      }
    });
  }
}

for (const [kind, base] of entries) {
  test(`${kind} root entry also exports injection metadata`, runtimeOptions, async () => {
    const namespace = await import(new URL(`${base}plugin.js`, import.meta.url));
    assert.deepEqual(namespace.inject, ['tools']);
    assert.equal(Loader.prototype.unwrapExports(namespace), namespace);
  });
}
// These tests use the installed Cordis runtime, not plain ctx mocks.
