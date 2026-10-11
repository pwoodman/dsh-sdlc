#!/usr/bin/env node
/**
 * packages/sdlc-cli/bin/sdlc.mjs — the `sdlc` executable (spec v3 C.2/F/I).
 *
 * Deterministic control plane over `.sdlc/`: no model call, no network.
 */

import { main } from '../src/cli.mjs';

const code = await main(process.argv.slice(2));
process.exit(code ?? 0);
