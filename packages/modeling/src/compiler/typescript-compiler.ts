import ts from 'typescript';

import type { Issue } from '../validation/report.js';
import { sandboxAmbientDeclarations } from '../sandbox/ambient-types.js';

const snippetFileName = '/manifold-snippet.ts';
const ambientFileName = '/manifold-sandbox.d.ts';

export interface TypecheckResult {
  ok: boolean;
  js?: string;
  /**
   * v3 source map for `js`, as a JSON string. Present whenever `js` is.
   * The runner uses this to walk runtime stack frames back from emitted
   * positions to original .ts positions for accurate error reporting.
   */
  sourceMap?: string;
  issues: Issue[];
}

export interface CompileOptions {
  /**
   * When true, no `Issue.snippet` field is emitted on diagnostics. Used when
   * the source was loaded via `filePath` so reports cannot leak file
   * contents back to the caller.
   */
  suppressSnippet?: boolean;
  /**
   * Optional self-contained standard-library declarations supplied by
   * single-file hosts that cannot ship TypeScript's sibling lib files.
   */
  libDeclarations?: string;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  lib: ['lib.es2022.d.ts'],
  strict: true,
  alwaysStrict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noEmitOnError: true,
  skipLibCheck: true,
  types: [],
  noErrorTruncation: true,
  // RUN-6: emit a sidecar source map so the worker can walk runtime
  // stack frames back to the original TypeScript line/column. Inline
  // sources stay off — the worker already has the user source.
  sourceMap: true,
  inlineSources: false,
};

// RUN-3: the ambient sandbox declarations and the underlying CompilerHost
// are pure functions of compilerOptions/sandboxAmbientDeclarations — both
// constant for the lifetime of the process — but `ts.createSourceFile`
// and `ts.createCompilerHost` together account for ~70% of typecheck
// latency on small snippets. Memoising at module scope cuts the steady-
// state typecheck path roughly in half without changing semantics.
let cachedAmbientFile: ts.SourceFile | undefined;
function getAmbientFile(): ts.SourceFile {
  if (!cachedAmbientFile) {
    cachedAmbientFile = ts.createSourceFile(
      ambientFileName,
      sandboxAmbientDeclarations,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
  }
  return cachedAmbientFile;
}

let cachedFallbackHost: ts.CompilerHost | undefined;
function getFallbackHost(): ts.CompilerHost {
  if (!cachedFallbackHost) {
    cachedFallbackHost = ts.createCompilerHost(compilerOptions, true);
  }
  return cachedFallbackHost;
}

let cachedEmbeddedLibText: string | undefined;
let cachedEmbeddedLibFile: ts.SourceFile | undefined;
function getEmbeddedLibFile(declarations: string): ts.SourceFile {
  if (!cachedEmbeddedLibFile || cachedEmbeddedLibText !== declarations) {
    cachedEmbeddedLibText = declarations;
    cachedEmbeddedLibFile = ts.createSourceFile(
      '/lib.es2022.d.ts',
      declarations,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
  }
  return cachedEmbeddedLibFile;
}

export function compileSnippetTypeScript(source: string, opts: CompileOptions = {}): TypecheckResult {
  let emittedJavaScript: string | undefined;
  let emittedSourceMap: string | undefined;
  const sourceFile = ts.createSourceFile(snippetFileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const ambientFile = getAmbientFile();
  const host = createInMemoryCompilerHost(
    sourceFile,
    ambientFile,
    (fileName, output) => {
      if (fileName.endsWith('.js.map')) {
        emittedSourceMap = output;
      } else if (fileName.endsWith('.js')) {
        emittedJavaScript = output;
      }
    },
    opts.libDeclarations,
  );
  const program = ts.createProgram([snippetFileName, ambientFileName], compilerOptions, host);
  const preEmitDiagnostics = ts.getPreEmitDiagnostics(program);
  const blockingDiagnostics = preEmitDiagnostics.filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  const preEmitIssues = diagnosticsToIssues(preEmitDiagnostics, sourceFile, source, opts);

  if (blockingDiagnostics.length > 0) {
    return {
      ok: false,
      issues: preEmitIssues,
    };
  }

  const emitResult = program.emit();
  const emitIssues = diagnosticsToIssues(emitResult.diagnostics, sourceFile, source, opts);
  const issues = [...preEmitIssues, ...emitIssues];
  const hasBlockingEmitDiagnostics = emitResult.diagnostics.some(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (
    emitResult.emitSkipped ||
    emittedJavaScript === undefined ||
    emittedSourceMap === undefined ||
    hasBlockingEmitDiagnostics
  ) {
    return {
      ok: false,
      issues:
        issues.length > 0
          ? issues
          : [
              {
                stage: 'typecheck',
                code: 'TS_EMIT_ERROR',
                message: 'TypeScript emit failed without diagnostics.',
              },
            ],
    };
  }

  return {
    ok: true,
    js: emittedJavaScript,
    sourceMap: emittedSourceMap,
    issues,
  };
}

function createInMemoryCompilerHost(
  sourceFile: ts.SourceFile,
  ambientFile: ts.SourceFile,
  writeOutput: (fileName: string, output: string) => void,
  libDeclarations: string | undefined,
): ts.CompilerHost {
  const fallbackHost = getFallbackHost();
  const virtualFiles = new Map<string, ts.SourceFile>([
    [snippetFileName, sourceFile],
    [ambientFileName, ambientFile],
  ]);
  const embeddedLib = libDeclarations === undefined ? undefined : getEmbeddedLibFile(libDeclarations);
  const getVirtualFile = (fileName: string): ts.SourceFile | undefined => {
    const normalizedFileName = normalizeFileName(fileName);
    return (
      virtualFiles.get(normalizedFileName) ??
      (embeddedLib && normalizedFileName.endsWith('/lib.es2022.d.ts') ? embeddedLib : undefined)
    );
  };

  return {
    ...fallbackHost,
    getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
      const virtualFile = getVirtualFile(fileName);
      if (virtualFile !== undefined) {
        return virtualFile;
      }
      return fallbackHost.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    },
    fileExists(fileName) {
      return getVirtualFile(fileName) !== undefined || fallbackHost.fileExists(fileName);
    },
    readFile(fileName) {
      const virtualFile = getVirtualFile(fileName);
      return virtualFile?.text ?? fallbackHost.readFile(fileName);
    },
    writeFile(fileName, data) {
      writeOutput(fileName, data);
    },
    getCurrentDirectory() {
      return '/';
    },
  };
}

function diagnosticsToIssues(
  diagnostics: readonly ts.Diagnostic[],
  userSourceFile: ts.SourceFile,
  userSource: string,
  opts: CompileOptions,
): Issue[] {
  return diagnostics
    .filter(diagnostic => diagnostic.file === userSourceFile)
    .map(diagnostic => diagnosticToIssue(diagnostic, userSourceFile, userSource, opts));
}

function diagnosticToIssue(
  diagnostic: ts.Diagnostic,
  userSourceFile: ts.SourceFile,
  userSource: string,
  opts: CompileOptions,
): Issue {
  const issue: Issue = {
    stage: 'typecheck',
    code: 'TS_DIAGNOSTIC',
    tsCode: diagnostic.code,
    message: explainDiagnostic(diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  };

  if (diagnostic.start !== undefined) {
    const { line, character } = userSourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    issue.line = line + 1;
    issue.col = character + 1;
    if (!opts.suppressSnippet) {
      const snippet = getSourceLine(userSource, line);
      if (snippet !== undefined) {
        issue.snippet = snippet;
      }
    }
  }

  return issue;
}

function explainDiagnostic(tsCode: number, message: string): string {
  const hints: string[] = [];
  if (tsCode === 2740 && message.includes("Type 'CrossSection'") && message.includes("type 'Manifold'")) {
    hints.push(
      'Result must be a Manifold, not a CrossSection. Did you forget to call Manifold.extrude(profile, height), profile.extrude(height), or Manifold.revolve(profile, segments)?',
    );
  }
  if ((tsCode === 2322 || tsCode === 2345) && message.includes('undefined') && message.includes("type 'Manifold'")) {
    hints.push(
      'Result cannot be undefined. Check optional array lookups, Map.get(), conditional branches, and helper functions before assigning to result.',
    );
  }
  if ((tsCode === 2322 || tsCode === 2769) && message.includes('number[]') && message.includes('Vec')) {
    hints.push(
      'Use tuple annotations for vectors, e.g. const offset: [number, number, number] = [x, y, z], instead of a widened number[].',
    );
  }
  if (tsCode === 2554 && message.includes('Expected') && message.includes('arguments')) {
    hints.push(
      'Factory methods use positional arguments, not option objects; check the Manifold/CrossSection signature in the skill reference.',
    );
  }
  if (tsCode === 2339 && message.includes('does not exist')) {
    hints.push('Check the skill API reference for the supported method name or equivalent modeling recipe.');
  }
  if (hints.length === 0) {
    return message;
  }
  return `${message}\nhint: ${hints.join(' ')}`;
}

function getSourceLine(source: string, zeroBasedLine: number): string | undefined {
  return source.split(/\r?\n/)[zeroBasedLine];
}

function normalizeFileName(fileName: string): string {
  return fileName.replaceAll('\\', '/');
}
