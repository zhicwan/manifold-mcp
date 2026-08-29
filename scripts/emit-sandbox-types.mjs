#!/usr/bin/env node
/**
 * Emit the canonical sandbox ambient `.d.ts` to consumers.
 *
 * The single source of truth for the sandbox ambient type declarations
 * is the template literal exported from
 * `packages/modeling/src/sandbox/ambient-types.ts`
 * (variable `sandboxAmbientDeclarations`). At runtime the TypeScript compiler
 * stage injects that string into a virtual `.d.ts` file. This script extracts
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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const SOURCE = resolve(repoRoot, 'packages/modeling/src/sandbox/ambient-types.ts');
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

function extractTemplateLiteral(source) {
  // Locate the exported template literal:
  //   export const sandboxAmbientDeclarations = String.raw`…`;
  // We scan rather than parse to keep this script dependency-free, but we
  // honour backslash-escapes inside the template so that future edits with
  // escaped backticks (\`) do not silently truncate the generated .d.ts.
  const marker = 'sandboxAmbientDeclarations';
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) {
    throw new Error(`Could not find export "${marker}" in ${SOURCE}`);
  }
  const openTick = source.indexOf('`', markerIdx);
  if (openTick < 0) {
    throw new Error(`Could not find opening backtick after "${marker}"`);
  }
  // A String.raw template ignores backslash escapes at runtime, but the
  // JavaScript tokenizer still treats `\`` as an escaped backtick that does
  // NOT close the template. Mirror that here, and fail loudly if the
  // template contains an interpolation (`${…}`) — those would change meaning
  // when emitted as plain .d.ts text.
  for (let i = openTick + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      throw new Error(
        `Template literal for "${marker}" contains an interpolation at offset ${i}; ` +
          'the sandbox ambient declarations must be a static string.',
      );
    }
    if (ch === '`') {
      return source.slice(openTick + 1, i);
    }
  }
  throw new Error(`Could not find closing backtick after "${marker}"`);
}

function main() {
  const source = readFileSync(SOURCE, 'utf8');
  const body = extractTemplateLiteral(source).replace(/^\n+/, '').replace(/\n+$/, '\n');
  const output = `${HEADER}${body}`;

  for (const target of TARGETS) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
  }
}

main();
