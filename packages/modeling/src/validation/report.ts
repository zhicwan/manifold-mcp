/**
 * Unified Report data model + YAML serialization.
 * Both `validate_script` and `execute_script` MCP tools return a YAML report.
 */
import { stringify as yamlStringify } from 'yaml';

export type Stage = 'syntax' | 'static' | 'typecheck' | 'runtime' | 'geometry' | 'print' | 'ok';

export type Severity = 'error' | 'warning' | 'hint';

/**
 * High-level grouping that helps an LLM (or human) skim a report and
 * understand where the failure surfaced semantically — independent of
 * which validation stage produced it. Set automatically by addError /
 * addWarning when the call site doesn't pass one explicitly.
 */
export type Category = 'sandbox' | 'api' | 'units' | 'geometry' | 'syntax' | 'runtime';

export type ErrorCode =
  // syntax / static
  | 'SYNTAX_ERROR'
  | 'INVALID_ARGUMENT'
  | 'CODE_TOO_LARGE'
  | 'FILE_READ_ERROR'
  | 'FILE_NOT_ALLOWED'
  | 'FORBIDDEN_GLOBAL'
  | 'RESULT_NOT_ASSIGNED'
  | 'UNKNOWN_API'
  | 'RADIANS_DETECTED'
  // typecheck
  | 'TS_DIAGNOSTIC'
  | 'TS_EMIT_ERROR'
  // runtime
  | 'TIMEOUT'
  | 'OUT_OF_MEMORY'
  | 'WORKER_CRASH'
  | 'RUNTIME_ERROR'
  // geometry
  | 'RESULT_NOT_MANIFOLD'
  | 'EMPTY_RESULT'
  | 'NON_FINITE_VERTEX'
  | 'NOT_MANIFOLD'
  | 'VERTEX_OUT_OF_BOUNDS'
  | 'PROPERTIES_WRONG_LENGTH'
  | 'MISSING_POSITION_PROPERTIES'
  | 'MERGE_VECTORS_DIFFERENT_LENGTHS'
  | 'MERGE_INDEX_OUT_OF_BOUNDS'
  | 'TRANSFORM_WRONG_LENGTH'
  | 'RUN_INDEX_WRONG_LENGTH'
  | 'FACE_ID_WRONG_LENGTH'
  | 'INVALID_CONSTRUCTION'
  | 'RESULT_TOO_LARGE'
  | 'INVALID_TANGENTS'
  | 'CANCELLED'
  | 'ZERO_VOLUME'
  | 'TRIANGLE_BUDGET'
  | 'BBOX_TOO_SMALL'
  | 'BBOX_TOO_LARGE'
  // print readiness
  | 'FEATURE_TOO_FINE';

export interface Issue {
  stage: Stage;
  code: ErrorCode | string;
  message: string;
  /**
   * High-level grouping (sandbox / api / units / geometry / syntax /
   * runtime). Optional in the type so existing constructors don't break;
   * `addError`/`addWarning` will fill it in automatically based on `code`
   * if the caller doesn't.
   */
  category?: Category;
  line?: number;
  col?: number;
  /** Optional inclusive end of the source span. Used to size the caret line in the code frame. */
  endLine?: number;
  endCol?: number;
  tsCode?: number;
  /**
   * VAL-5: a 3-line code frame around the offending source line, with a
   * caret pointer (`~~~~`) on the column range. Null when the source is
   * not available or when SEC-2's `suppressSnippet` flag is set.
   *
   *     line 4 | result = Manifold.box([10, 10, 10]);
   *            |          ~~~~~~~~~~~~
   *     line 5 | result = result.translate([0, 0, 5]);
   */
  snippet?: string;
}

export interface Stats {
  triangles: number;
  vertices: number;
  volume: number;
  surfaceArea: number;
  genus: number;
  bbox: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

export interface Report {
  ok: boolean;
  stage: Stage;
  durationMs?: number;
  errors: Issue[];
  warnings: Issue[];
  hints: string[];
  stats?: Stats;
  previewUrl?: string;
}

export const ERROR_STATUS_TO_CODE: Record<string, ErrorCode> = {
  NoError: 'EMPTY_RESULT',
  NonFiniteVertex: 'NON_FINITE_VERTEX',
  NotManifold: 'NOT_MANIFOLD',
  VertexOutOfBounds: 'VERTEX_OUT_OF_BOUNDS',
  PropertiesWrongLength: 'PROPERTIES_WRONG_LENGTH',
  MissingPositionProperties: 'MISSING_POSITION_PROPERTIES',
  MergeVectorsDifferentLengths: 'MERGE_VECTORS_DIFFERENT_LENGTHS',
  MergeIndexOutOfBounds: 'MERGE_INDEX_OUT_OF_BOUNDS',
  TransformWrongLength: 'TRANSFORM_WRONG_LENGTH',
  RunIndexWrongLength: 'RUN_INDEX_WRONG_LENGTH',
  FaceIDWrongLength: 'FACE_ID_WRONG_LENGTH',
  InvalidConstruction: 'INVALID_CONSTRUCTION',
  ResultTooLarge: 'RESULT_TOO_LARGE',
  InvalidTangents: 'INVALID_TANGENTS',
  Cancelled: 'CANCELLED',
};

const SANDBOX_CODES = new Set<string>(['FORBIDDEN_GLOBAL', 'CODE_TOO_LARGE', 'RESULT_NOT_ASSIGNED']);
const API_CODES = new Set<string>([
  'UNKNOWN_API',
  'INVALID_ARGUMENT',
  'FILE_READ_ERROR',
  'FILE_NOT_ALLOWED',
  'TS_DIAGNOSTIC',
  'TS_EMIT_ERROR',
]);
const RUNTIME_CODES = new Set<string>(['TIMEOUT', 'OUT_OF_MEMORY', 'WORKER_CRASH', 'RUNTIME_ERROR']);
const SYNTAX_CODES = new Set<string>(['SYNTAX_ERROR']);
const UNITS_CODES = new Set<string>(['RADIANS_DETECTED']);

/**
 * Map an error code to its high-level category. Anything not in the
 * other buckets falls through to 'geometry' — the manifold ErrorStatus
 * codes plus EMPTY_RESULT, RESULT_NOT_MANIFOLD, INVALID_CONSTRUCTION,
 * ZERO_VOLUME, TRIANGLE_BUDGET, BBOX_*, FEATURE_TOO_FINE.
 */
export function categoryOf(code: string): Category {
  if (SANDBOX_CODES.has(code)) {
    return 'sandbox';
  }
  if (API_CODES.has(code)) {
    return 'api';
  }
  if (RUNTIME_CODES.has(code)) {
    return 'runtime';
  }
  if (SYNTAX_CODES.has(code)) {
    return 'syntax';
  }
  if (UNITS_CODES.has(code)) {
    return 'units';
  }
  return 'geometry';
}

export function emptyReport(stage: Stage = 'ok'): Report {
  return { ok: true, stage, errors: [], warnings: [], hints: [] };
}

function ensureCategory(issue: Issue): void {
  if (issue.category === undefined) {
    issue.category = categoryOf(issue.code);
  }
}

export function addError(r: Report, issue: Issue): void {
  ensureCategory(issue);
  r.errors.push(issue);
  r.ok = false;
  r.stage = issue.stage;
}

export function addWarning(r: Report, issue: Issue): void {
  ensureCategory(issue);
  r.warnings.push(issue);
}

export function addHint(r: Report, message: string): void {
  r.hints.push(message);
}

/**
 * VAL-5: build a 3-line code frame with a caret pointer for an issue.
 * Lines are 1-based; `col` and `endCol` are 1-based inclusive starts of
 * the highlighted span. Returns undefined when the source is empty or
 * the line is out of range.
 *
 * Example output:
 *
 *     line 4 | result = Manifold.box([10, 10, 10]);
 *            |          ~~~~~~~~~~~~
 *     line 5 | result = result.translate([0, 0, 5]);
 */
export function buildCodeFrame(
  source: string,
  line: number,
  col?: number,
  endLine?: number,
  endCol?: number,
): string | undefined {
  if (!source || !Number.isFinite(line) || line < 1) {
    return undefined;
  }
  const lines = source.split(/\r?\n/);
  if (line > lines.length) {
    return undefined;
  }
  const start = Math.max(1, line - 1);
  const end = Math.min(lines.length, line + 1);
  const gutterWidth = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const text = lines[i - 1] ?? '';
    const gutter = `line ${String(i).padStart(gutterWidth, ' ')} | `;
    out.push(gutter + text);
    if (i === line && col !== undefined && col >= 1) {
      const caretGutter = `${' '.repeat(gutter.length - 2)}| `;
      const indent = ' '.repeat(col - 1);
      let caretLen = 1;
      if (endLine === line && endCol !== undefined && endCol > col) {
        caretLen = endCol - col;
      } else if (endLine !== undefined && endLine > line) {
        caretLen = Math.max(1, text.length - col + 1);
      }
      out.push(caretGutter + indent + '~'.repeat(caretLen));
    }
  }
  return out.join('\n');
}

/** Serialize a report to YAML for the MCP text response. */
export function reportToYaml(r: Report): string {
  return yamlStringify(r, { lineWidth: 0, defaultStringType: 'PLAIN', blockQuote: 'literal' });
}
