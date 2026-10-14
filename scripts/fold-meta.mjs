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
 *   node scripts/fold-meta.mjs
 */
import fold from './lib/fold-meta.cjs';

const folded = fold.fold();
process.stdout.write(`fold-meta: folded ${folded.join(', ')} into @patwoodman/dsh-sdlc-flow (lib/rows/)\n`);
