/**
 * Backward-compatible facade.
 *
 * The original `validators.ts` was a single 700-line module covering the
 * static AST lint, geometry checks, and string-distance helpers. After
 * MNT-1 the implementation lives in three focused siblings; this file
 * re-exports their public surface so external callers (mcp-server,
 * runner/worker, tests) keep working with no path changes.
 */
export * from './static-lint.js';
export * from './geometry.js';
export * from './suggest.js';
