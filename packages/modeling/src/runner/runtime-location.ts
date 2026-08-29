/**
 * Map a runtime stack frame from a thrown user-snippet error back to
 * the original TypeScript source via the source-map emitted by
 * `compileSnippetTypeScript` (RUN-6). Also formats the user-facing
 * code-frame snippet that gets attached to the diagnostic.
 *
 * Lives outside `worker.ts` so the runtime path stays focused on
 * orchestration and so unit tests can exercise the source-map math
 * without spinning up a real Worker.
 */
import { SourceMapConsumer } from 'source-map';

import { buildCodeFrame, type Issue } from '../validation/report.js';

export interface SourceLocation {
  line: number;
  col: number;
}

/**
 * Resolve a `<anonymous>:line:col` frame from a thrown error's stack
 * back to the original TS source. Returns `undefined` when the stack
 * doesn't include a usable frame; falls back to the emitted-JS line
 * when the source map is missing or has no entry for the frame.
 */
export async function runtimeSourceLocation(
  stack: string | undefined,
  source: string,
  sourceMapText: string | undefined,
): Promise<SourceLocation | undefined> {
  // `source` is reserved for a future fallback that re-parses the snippet
  // when no sourcemap is available; kept here so callers can pass it
  // unconditionally without churn the day we wire that up.
  void source;
  const match = stack?.match(/<anonymous>:(\d+):(\d+)/);
  if (!match) {
    return undefined;
  }
  const functionLine = Number(match[1]);
  const functionCol = Number(match[2]);
  if (!Number.isFinite(functionLine) || !Number.isFinite(functionCol)) {
    return undefined;
  }
  // 4-line prelude: function header + 'use strict' + let result + first JS line.
  const emittedLine = functionLine - 4;
  if (emittedLine < 1) {
    return undefined;
  }

  if (sourceMapText !== undefined) {
    const consumer = await new SourceMapConsumer(sourceMapText);
    try {
      const original = consumer.originalPositionFor({ line: emittedLine, column: Math.max(0, functionCol - 1) });
      if (original.line !== null) {
        return { line: original.line, col: (original.column ?? 0) + 1 };
      }
    } finally {
      consumer.destroy();
    }
  }

  return { line: emittedLine, col: functionCol };
}

/**
 * Format the snippet attached to a RUNTIME_ERROR diagnostic: a VAL-5
 * code-frame around the offending source line, optionally followed by
 * the first few lines of the original stack so the LLM can see the
 * call chain. Returns `undefined` if neither piece is available.
 */
export function runtimeErrorSnippet(
  source: string,
  loc: SourceLocation | undefined,
  stack: string | undefined,
): string | undefined {
  const stackSnippet = stack?.split('\n').slice(0, 8).join('\n');
  if (!loc) {
    return stackSnippet;
  }
  const frame = buildCodeFrame(source, loc.line, loc.col);
  if (!frame) {
    return stackSnippet;
  }
  return stackSnippet ? `${frame}\n${stackSnippet}` : frame;
}

/**
 * VAL-5 helper: replace any single-line `snippet` already on an Issue
 * with a multi-line code frame around the same line. Used for issues
 * coming back from typescript-compiler.ts, which doesn't import the
 * report helpers and emits raw single-line snippets. When SEC-2's
 * `suppress` flag is set we drop the snippet entirely.
 */
export function upgradeIssueSnippet(issue: Issue, source: string, suppress: boolean): void {
  if (suppress) {
    if (issue.snippet !== undefined) {
      delete issue.snippet;
    }
    return;
  }
  if (issue.line === undefined) {
    return;
  }
  const frame = buildCodeFrame(source, issue.line, issue.col);
  if (frame !== undefined) {
    issue.snippet = frame;
  }
}
