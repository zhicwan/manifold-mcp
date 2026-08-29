/**
 * Static (AST) lint for user snippets.
 *
 * IMPORTANT (Codex review):
 *   The AST checks here are a *lint* — they help LLMs catch obvious
 *   mistakes and surface forbidden API usage with a friendly error code.
 *   They are NOT a security boundary. The worker scrub, API freezing,
 *   resource limits, and hard-kill watchdog are defense-in-depth inside
 *   the host process; a Worker is not OS-level isolation.
 */
import ts from 'typescript';
import { type Issue, type Report, addError, addWarning, buildCodeFrame, emptyReport } from './report.js';
import { hasAlias, unknownApiMessage } from './suggest.js';

const FORBIDDEN_GLOBALS = new Set([
  'require',
  'process',
  'global',
  'globalThis',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'AsyncGeneratorFunction',
  'fs',
  'child_process',
  'worker_threads',
  'http',
  'https',
  'net',
  'dgram',
  'tls',
  'os',
  'cluster',
  '__dirname',
  '__filename',
  'Buffer',
  'SharedArrayBuffer',
  'Atomics',
  'module',
]);

/** Surfaced in script-conventions.md and validation-report.md — keep docs in sync. */
export const MAX_CODE_BYTES = 64 * 1024;

/**
 * Capture Buffer at module load. The runner worker scrubs `Buffer` from
 * `globalThis` as part of the sandbox hardening, but `runStaticStage`
 * must still measure UTF-8 byte length of the user snippet after the
 * scrub. Holding a module-scope reference keeps the byte-budget check
 * working without re-introducing `Buffer` to user-visible globals.
 */
const CapturedBuffer = Buffer;

export const KNOWN_MANIFOLD_STATIC = new Set([
  'cube',
  'cylinder',
  'sphere',
  'tetrahedron',
  'extrude',
  'revolve',
  'compose',
  'union',
  'difference',
  'intersection',
  'levelSet',
  'smooth',
  'ofMesh',
  'hull',
]);

export const KNOWN_CROSSSECTION_STATIC = new Set([
  'square',
  'circle',
  'union',
  'difference',
  'intersection',
  'compose',
  'ofPolygons',
  'hull',
]);

export interface StaticAnalysisResult {
  resultAssigned: boolean;
  forbidden: Issue[];
  unknownApi: Issue[];
  warnings: Issue[];
  syntaxError?: Issue;
}

export interface StaticStageOptions {
  /**
   * When true, no `Issue.snippet` field is emitted. Used when the source was
   * loaded via `filePath` so that diagnostic reports cannot leak file
   * contents back to the caller (file-content exfiltration channel).
   */
  suppressSnippet?: boolean;
}

/** Parse + scan AST. Returns lint findings. */
export function analyzeStatic(code: string, opts: StaticStageOptions = {}): StaticAnalysisResult {
  const out: StaticAnalysisResult = {
    resultAssigned: false,
    forbidden: [],
    unknownApi: [],
    warnings: [],
  };

  const sourceFile = ts.createSourceFile('manifold-snippet.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const frameAtNode = (node: ts.Node): string | undefined =>
    opts.suppressSnippet ? undefined : codeFrameForNode(code, sourceFile, node);
  const frameAtPos = (line: number, col: number): string | undefined =>
    opts.suppressSnippet ? undefined : buildCodeFrame(code, line, col);
  const forbidDynamicCode = (node: ts.Node, message: string): void => {
    out.forbidden.push(
      withSnippet(
        {
          stage: 'static',
          code: 'FORBIDDEN_GLOBAL',
          category: 'sandbox',
          message,
          ...spanOf(sourceFile, node),
        },
        frameAtNode(node),
      ),
    );
  };
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const err = parseDiagnostics[0];
    if (!err) {
      throw new Error('TypeScript reported a parse diagnostic without an entry.');
    }
    const pos = err.start === undefined ? undefined : sourceFile.getLineAndCharacterOfPosition(err.start);
    const syntaxError: Issue = {
      stage: 'syntax',
      code: 'SYNTAX_ERROR',
      category: 'syntax',
      message: ts.flattenDiagnosticMessageText(err.messageText, '\n'),
    };
    if (pos !== undefined) {
      syntaxError.line = pos.line + 1;
      syntaxError.col = pos.character + 1;
      const snippet = frameAtPos(pos.line + 1, pos.character + 1);
      if (snippet !== undefined) {
        syntaxError.snippet = snippet;
      }
    }
    out.syntaxError = syntaxError;
    return out;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (FORBIDDEN_GLOBALS.has(node.text)) {
        out.forbidden.push(
          withSnippet(
            {
              stage: 'static',
              code: 'FORBIDDEN_GLOBAL',
              category: 'sandbox',
              message: `Forbidden global '${node.text}' is not available in the sandbox.`,
              ...spanOf(sourceFile, node),
            },
            frameAtNode(node),
          ),
        );
      }
    }

    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      forbidDynamicCode(node, `'import' is not allowed inside the sandbox; all APIs are pre-bound as globals.`);
    }

    if (isDynamicImportCall(node)) {
      forbidDynamicCode(node, `Dynamic import() is not allowed inside the sandbox because it can load host modules.`);
    }

    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      forbidDynamicCode(node, `'import.meta' is not available inside the sandbox.`);
    }

    if (isExportSyntax(node)) {
      out.forbidden.push(
        withSnippet(
          {
            stage: 'static',
            code: 'FORBIDDEN_GLOBAL',
            category: 'sandbox',
            message: `'export' is not allowed inside the sandbox; snippets run as scripts.`,
            ...spanOf(sourceFile, node),
          },
          frameAtNode(node),
        ),
      );
    }

    if (ts.isBinaryExpression(node)) {
      // Direct + compound assignments to `result`: `result = X`,
      // `result ??= X`, `result ||= X`, `result &&= X`.
      if (
        ts.isIdentifier(node.left) &&
        node.left.text === 'result' &&
        isResultAssignmentOperator(node.operatorToken.kind)
      ) {
        out.resultAssigned = true;
      }
      // Array destructuring `[result] = X` (and `[a, result] = X`).
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isArrayLiteralExpression(node.left) &&
        node.left.elements.some(el => ts.isIdentifier(el) && el.text === 'result')
      ) {
        out.resultAssigned = true;
      }
      // Object destructuring `({ result } = X)` and `({ x: result } = X)`.
      // The TS parser keeps the parens as a ParenthesizedExpression around
      // the BinaryExpression — the BinaryExpression's `left` is the bare
      // ObjectLiteralExpression.
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) {
        for (const prop of node.left.properties) {
          if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'result') {
            out.resultAssigned = true;
            break;
          }
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.initializer) &&
            prop.initializer.text === 'result'
          ) {
            out.resultAssigned = true;
            break;
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node)) {
      // `let result = ...` / `const result = ...` also counts.
      if (ts.isIdentifier(node.name) && node.name.text === 'result' && node.initializer !== undefined) {
        out.resultAssigned = true;
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'constructor') {
        forbidDynamicCode(
          node,
          `Access to '.constructor' is not allowed because it can recover dynamic-code constructors.`,
        );
      }

      // VAL-1: only emit UNKNOWN_API when we have an alias hint to add.
      // For other unknown identifiers, the TypeScript pass emits TS2339
      // ("Property 'foo' does not exist on type 'typeof Manifold'") with
      // custom guidance via explainDiagnostic, so a static-stage warning
      // would be a duplicate.
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Manifold') {
        const name = node.name.text;
        if (!KNOWN_MANIFOLD_STATIC.has(name) && !looksLikeInstanceMethod(name) && hasAlias('Manifold', name)) {
          out.unknownApi.push(
            withSnippet(
              {
                stage: 'static',
                code: 'UNKNOWN_API',
                category: 'api',
                message: unknownApiMessage('Manifold', name, KNOWN_MANIFOLD_STATIC),
                ...spanOf(sourceFile, node),
              },
              frameAtNode(node),
            ),
          );
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'CrossSection') {
        const name = node.name.text;
        if (!KNOWN_CROSSSECTION_STATIC.has(name) && hasAlias('CrossSection', name)) {
          out.unknownApi.push(
            withSnippet(
              {
                stage: 'static',
                code: 'UNKNOWN_API',
                category: 'api',
                message: unknownApiMessage('CrossSection', name, KNOWN_CROSSSECTION_STATIC),
                ...spanOf(sourceFile, node),
              },
              frameAtNode(node),
            ),
          );
        }
      }
    }

    if (ts.isElementAccessExpression(node) && isConstructorPropertyName(node.argumentExpression)) {
      forbidDynamicCode(
        node,
        `Computed access to 'constructor' is not allowed because it can recover dynamic-code constructors.`,
      );
    }

    if (ts.isCallExpression(node)) {
      if (isStaticCall(node, 'Reflect', 'construct')) {
        forbidDynamicCode(node, `Reflect.construct() is not available inside the sandbox.`);
      }
      if (
        (isStaticCall(node, 'Reflect', 'get') ||
          isStaticCall(node, 'Object', 'getOwnPropertyDescriptor') ||
          isStaticCall(node, 'Reflect', 'getOwnPropertyDescriptor')) &&
        isConstructorPropertyName(node.arguments[1])
      ) {
        forbidDynamicCode(
          node,
          `Reflective access to 'constructor' is not allowed because it can recover dynamic-code constructors.`,
        );
      }

      if (
        isStaticCall(node, 'Manifold', 'cylinder') &&
        node.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        out.warnings.push(
          withSnippet(
            {
              stage: 'static',
              code: 'INVALID_CONSTRUCTION',
              category: 'api',
              message:
                'Manifold.cylinder uses positional arguments, not an options object: cylinder(height, radiusLow, radiusHigh?, circularSegments?, center?).',
              ...spanOf(sourceFile, node),
            },
            frameAtNode(node),
          ),
        );
      }

      if (isRotateCall(node) && looksLikeRadians(code, sourceFile, node.arguments)) {
        out.warnings.push(
          withSnippet(
            {
              stage: 'static',
              code: 'RADIANS_DETECTED',
              category: 'units',
              message:
                'Manifold/CrossSection rotate() expects degrees, not radians. Use 90, 45, -30, etc. instead of Math.PI-derived values.',
              ...spanOf(sourceFile, node),
            },
            frameAtNode(node),
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return out;
}

function looksLikeInstanceMethod(name: string): boolean {
  // Allow well-known instance methods used as helpers via Manifold.prototype.
  return ['prototype'].includes(name);
}

function isExportSyntax(node: ts.Node): boolean {
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
    return true;
  }
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false;
}

function isStaticCall(call: ts.CallExpression, objectName: string, propertyName: string): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === objectName &&
    callee.name.text === propertyName
  );
}

function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function isConstructorPropertyName(node: ts.Expression | undefined): boolean {
  return (
    (node !== undefined && ts.isStringLiteralLike(node) && node.text === 'constructor') ||
    (node !== undefined && ts.isNoSubstitutionTemplateLiteral(node) && node.text === 'constructor')
  );
}

function isRotateCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'rotate';
}

export function looksLikeRadians(code: string, sourceFile: ts.SourceFile, args: ts.NodeArray<ts.Expression>): boolean {
  // VAL-2: only fire when the source text references Math.PI or a
  // radian-named identifier. Magnitude-based heuristics on plain
  // numeric literals false-positive on common degree values like
  // `rotate(0.5)` or `rotate([0, 0, 0.25])`.
  return args.some(arg => {
    const text = sourceFor(code, sourceFile, arg);
    return /\bMath\.PI\b|(?:^|[^A-Za-z])PI(?:[^A-Za-z]|$)|\brad(?:ian)?s?\b/i.test(text);
  });
}

function isResultAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function sourceFor(code: string, sourceFile: ts.SourceFile, node: ts.Node): string {
  return code.slice(node.getStart(sourceFile), node.end);
}

function withSnippet(issue: Issue, snippet: string | undefined): Issue {
  return snippet === undefined ? issue : { ...issue, snippet };
}

function spanOf(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { line: number; col: number; endLine: number; endCol: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.end);
  return { line: start.line + 1, col: start.character + 1, endLine: end.line + 1, endCol: end.character + 1 };
}

function codeFrameForNode(code: string, sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  const span = spanOf(sourceFile, node);
  return buildCodeFrame(code, span.line, span.col, span.endLine, span.endCol);
}

/**
 * Final-gate check (VAL-3): walks the JS emitted by the TypeScript
 * compiler to verify *something* assigns to the top-level `result`
 * variable. The TypeScript pass lowers exotic patterns (array/object
 * destructuring, compound assigns, parenthesised binders) to plain
 * `result = …` forms, so a JS-side scan picks up cases the static AST
 * walk misses.
 *
 * Runs only after `compileSnippetTypeScript` succeeds — at that point
 * the script is syntactically valid JavaScript by construction, so the
 * TS parser-in-JS-mode walk is cheap and reliable.
 */
export function detectResultAssignmentInJs(js: string): boolean {
  const sf = ts.createSourceFile('manifold-emitted.js', js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isBinaryExpression(node) && isResultAssignmentOperator(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left) && node.left.text === 'result') {
        found = true;
        return;
      }
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isArrayLiteralExpression(node.left) &&
        node.left.elements.some(el => ts.isIdentifier(el) && el.text === 'result')
      ) {
        found = true;
        return;
      }
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) {
        for (const prop of node.left.properties) {
          if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'result') {
            found = true;
            return;
          }
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.initializer) &&
            prop.initializer.text === 'result'
          ) {
            found = true;
            return;
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'result' &&
      node.initializer !== undefined
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Run stage 1 (syntax + static lint) and merge findings into a fresh report.
 * Returns the report. If `report.ok === false` after this call, runtime should
 * not proceed.
 */
export function runStaticStage(code: string, opts: StaticStageOptions = {}): Report {
  const r = emptyReport('static');

  if (CapturedBuffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    addError(r, {
      stage: 'static',
      code: 'CODE_TOO_LARGE',
      category: 'sandbox',
      message: `Script exceeds ${MAX_CODE_BYTES} byte budget.`,
    });
    return r;
  }

  const a = analyzeStatic(code, opts);
  if (a.syntaxError) {
    addError(r, a.syntaxError);
    return r;
  }

  for (const issue of a.forbidden) {
    addError(r, issue);
  }
  for (const issue of a.unknownApi) {
    addWarning(r, issue);
  }
  for (const issue of a.warnings) {
    addWarning(r, issue);
  }

  if (!a.resultAssigned) {
    addError(r, {
      stage: 'static',
      code: 'RESULT_NOT_ASSIGNED',
      category: 'sandbox',
      message: `Script must assign the final Manifold to a variable named 'result'.`,
    });
  }

  if (r.ok) {
    r.stage = 'ok';
  }
  return r;
}
