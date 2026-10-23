#!/usr/bin/env node
/**
 * scripts/fold-meta.mjs — apply the member fold (see scripts/lib/fold-meta.cjs).
 *
 * Copies each member's built lib/ into packages/sdlc-orchestrator/lib/rows/<m>/
 * with cross-member imports rewritten to relative paths, drops the meta
 * package's member dependencies, and adds the flat `./services`, `./tools`,
 * `./tools-plugin`, `./presets`, `./presets-plugin`, `./ui`, `./core`,
 * `./guard`, `./cli` exports the folded patch rows resolve through. Run AFTER
 * `build.mjs`/`build-ui.mjs` and BEFORE `gen-bundle-patch.mjs`.
 *
 *   node scripts/fold-meta.mjs [--check]
 *
 * C20: `--check` verifies the fold is applied (manifest folded, rows fresh)
 * without writing, exiting EXIT.FAIL when stale and EXIT.USAGE on unknown
 * flags. All exit codes come from scripts/lib/harness.mjs EXIT.
 */
import { EXIT } from './lib/harness.mjs';
import fold from './lib/fold-meta.cjs';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const unknown = argv.filter((a) => a.startsWith('--') && a !== '--check');
if (unknown.length) {
  process.stderr.write(`fold-meta: unknown flag ${unknown[0]} (usage: [--check])\n`);
  process.exit(EXIT.USAGE);
}

if (CHECK) {
  if (!fold.isFolded()) {
    process.stderr.write('fold-meta --check: meta manifest is not folded (run scripts/fold-meta.mjs)\n');
    process.exit(EXIT.FAIL);
  }
  const stale = fold.foldedStale();
  if (stale.length) {
    process.stderr.write(`fold-meta --check: stale folded rows: ${stale.join(', ')}\n`);
    process.exit(EXIT.FAIL);
  }
  try {
    fold.assertFoldedSiblings();
  } catch (err) {
    process.stderr.write(`fold-meta --check: ${err.message}\n`);
    process.exit(EXIT.FAIL);
  }
  process.stdout.write('fold-meta --check: fold applied, rows fresh\n');
  process.exit(EXIT.PASS);
}

const folded = fold.fold();
process.stdout.write(`fold-meta: folded ${folded.join(', ')} into @patwoodman/dsh-sdlc-flow (lib/rows/)\n`);
