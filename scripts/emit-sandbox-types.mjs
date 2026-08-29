#!/usr/bin/env node
/**
 * Emit the canonical sandbox ambient `.d.ts` to consumers.
 *
 * The single source of truth for the sandbox ambient type declarations
 * is the template literal exported from
 * `packages/modeling/src/sandbox/ambient-types.ts`
 * (variable `sandboxAmbientDeclarations`). At runtime the TypeScript compiler
 * stage injects that string into a virtual `.d.ts` file. This script imports
 * the same string and writes it to:
 *
 *   - samples/manifold-sandbox.d.ts
 *       So `samples/*.ts` typecheck in editors and via `tsc --noEmit`.
 *   - plugin/skills/use-manifold/references/manifold-sandbox.d.ts
 *       So the Copilot skill can read the authoritative typing alongside the
 *       prose reference docs.
 *
 * Both outputs carry a "DO NOT EDIT" header and are meant to be regenerated
 * as part of `npm run build`.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { sandboxAmbientDeclarations } from '../packages/modeling/src/sandbox/ambient-types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const TARGETS = [
  resolve(repoRoot, 'samples/manifold-sandbox.d.ts'),
  resolve(repoRoot, 'plugin/skills/use-manifold/references/manifold-sandbox.d.ts'),
];

const HEADER = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT
//
// Generated from: packages/modeling/src/sandbox/ambient-types.ts
// Regenerate via: npm run build:sandbox-types  (or npm run build)
//
// This file is the canonical ambient declaration for the sandbox. The
// runtime TypeScript compiler injects the same content into the in-memory
// program when validating snippets, so editors and CLI checks see the exact
// API surface that the runtime accepts.
// =============================================================================

`;

function main() {
  const body = sandboxAmbientDeclarations.replace(/^\n+/, '').replace(/\n+$/, '\n');
  const output = `${HEADER}${body}`;

  for (const target of TARGETS) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
  }
}

main();
