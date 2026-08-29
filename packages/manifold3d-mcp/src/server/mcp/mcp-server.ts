/**
 * MCP server: exposes manifold validation, execution, annotation, and capture tools.
 * Output is YAML serialized via report.ts.
 */
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import yaml from 'yaml';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { type ModelingSession, type RenderResult, type RenderViewOptions } from '@manifold3d/modeling/modeling.js';
import { toViewerModelFrame } from '@manifold3d/modeling/runner/model-artifact.js';
import { reportToYaml, type Report } from '@manifold3d/modeling/validation/report.js';
import type { PreviewServerHandle } from '@manifold3d/viewer-host/preview/preview-server.js';
import { type CaptureView } from '@manifold3d/modeling/preview/renderer.js';
import { MAX_CODE_BYTES } from '@manifold3d/modeling/validation/validators.js';

/** Filename extensions accepted by `filePath` loader. */
const ALLOWED_FILE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cts', '.mts']);
const CAPTURE_VIEWS = new Set<CaptureView>(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']);
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

export interface McpServerOptions {
  modelingSession: ModelingSession;
  /**
   * Lazy preview accessor. The HTTP/WS server is not started — and the
   * browser is not opened — until the first successful `execute_script`.
   * Subsequent calls reuse the same handle.
   */
  getPreview: () => Promise<PreviewServerHandle>;
  /**
   * Returns the preview handle if it has already been started, or
   * undefined otherwise. Used by `get_annotations` to read viewer state
   * without forcing a browser pop-up when no model exists yet.
   */
  peekPreview: () => PreviewServerHandle | undefined;
}

export interface McpServerHandle {
  /** Wait for every request handler accepted before this call to settle and flush. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function startMcpServer(opts: McpServerOptions): Promise<McpServerHandle> {
  const server = new Server(
    { name: 'manifold3d-mcp', version: await readPackageVersion() },
    { capabilities: { tools: {} } },
  );
  const inFlight = new Set<Promise<unknown>>();
  let acceptingToolCalls = true;
  let drainPromise: Promise<void> | undefined;

  // eslint-disable-next-line @typescript-eslint/require-await -- TST-8 follow-up: handler shape is dictated by SDK; refactor in next phase
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'validate_script',
        description:
          'Fast pre-flight check for a manifold-3d TypeScript snippet. ' +
          'Runs syntax + AST lint + executes the script in a sandboxed worker, ' +
          'verifies the resulting Manifold and returns a YAML diagnostic ' +
          'report (errors, warnings, hints, stats). Does NOT update the live ' +
          'preview. Use this whenever you want quick feedback before showing ' +
          'the user the model.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description:
                'TypeScript source. Must assign the final Manifold to a ' +
                "variable named 'result'. Globals available: Manifold, " +
                'CrossSection, Mesh. No require/import/process/fs.',
            },
            filePath: {
              type: 'string',
              description:
                'Absolute path to a local TypeScript or JavaScript snippet file to read instead of passing `code`. ' +
                'Relative paths are not supported. Subject to MANIFOLD_MCP_SCRIPT_ROOTS allow-list (defaults to CWD and samples/). ' +
                'Allowed extensions: .ts, .js, .mjs, .cts, .mts. ' +
                'Source contents are not echoed back in diagnostic snippets — line numbers only.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'execute_script',
        description:
          'Run a manifold-3d TypeScript snippet, validate the resulting ' +
          'Manifold, and (on success) push it to the live three.js preview ' +
          'page. Returns a YAML diagnostic report including the preview ' +
          'URL. Use this when you are ready to show the user a model.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'TypeScript source (see validate_script for rules).',
            },
            filePath: {
              type: 'string',
              description:
                'Absolute path to a local TypeScript or JavaScript snippet file to read instead of passing `code`. ' +
                'Relative paths are not supported. Subject to MANIFOLD_MCP_SCRIPT_ROOTS allow-list (defaults to CWD and samples/). ' +
                'Allowed extensions: .ts, .js, .mjs, .cts, .mts. ' +
                'Source contents are not echoed back in diagnostic snippets — line numbers only.',
            },
            description: {
              type: 'string',
              description:
                'Short human-readable label for the model, displayed in the ' + 'preview page header. Optional.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'get_annotations',
        description:
          'Returns the user\'s active annotations ("marks") on the current ' +
          'model as a YAML document. Each annotation has a partLabel (e.g., ' +
          '"point#1" or "bowl#1"), a worldCoord indicating where on the ' +
          'model the user pointed, and a free-form note with their ' +
          'feedback. Use this whenever the user references their marks ' +
          '(examples: "apply my notes", "fix what I marked", "改一下我标记的"), ' +
          'or proactively before regenerating the model so you can ' +
          'incorporate their feedback. Annotations are automatically cleared ' +
          'whenever a new model is pushed via execute_script. Returns an ' +
          'empty list (with a hint in the YAML) if the user has not yet ' +
          'marked anything.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'capture_view',
        description:
          'Capture the current preview model as a PNG image from a named view. ' +
          'Does not start or open the preview; it only renders the last model ' +
          'already produced by execute_script.',
        inputSchema: {
          type: 'object',
          properties: {
            view: {
              type: 'string',
              enum: [...CAPTURE_VIEWS],
              default: 'iso',
              description: 'Camera preset to render.',
            },
            width: {
              type: 'integer',
              minimum: 128,
              maximum: 2048,
              default: 1024,
              description: 'Requested PNG width in pixels (128–2048).',
            },
            height: {
              type: 'integer',
              minimum: 128,
              maximum: 2048,
              default: 1024,
              description: 'Requested PNG height in pixels (128–2048).',
            },
            includeAnnotations: {
              type: 'boolean',
              default: false,
              description: 'When true, overlays current point, region, and sketch annotations on the captured PNG.',
            },
          },
          additionalProperties: false,
        },
      },
    ],
  }));

  const handleToolCall = async (req: CallToolRequest) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const description = typeof args.description === 'string' ? args.description : undefined;

    if (name === 'validate_script' || name === 'execute_script') {
      const source = await loadScriptSource(args);
      if ('report' in source) {
        return toolResult(source.report);
      }

      const code = source.code;
      const suppressSnippet = source.suppressSnippet;
      if (name === 'validate_script') {
        const { report } = await opts.modelingSession.validate({ code, suppressSnippet });
        return toolResult(report);
      }

      let publishedPreview: PreviewServerHandle | undefined;
      const result = await opts.modelingSession.execute(
        {
          code,
          suppressSnippet,
          ...(description !== undefined ? { description } : {}),
        },
        {
          beforeCommit: async model => {
            const preview = await opts.getPreview();
            preview.pushModel(toViewerModelFrame(model.artifact));
            publishedPreview = preview;
          },
        },
      );
      const report = result.report;
      if (result.model && publishedPreview) {
        report.previewUrl = publishedPreview.url;
      }
      return toolResult(report);
    }

    if (name === 'get_annotations') {
      // Do NOT lazy-start the preview server here: if the viewer was
      // never opened there can be no annotations, and starting the
      // server would pop a browser unexpectedly.
      const preview = opts.peekPreview();
      const snap = preview ? preview.getAnnotations() : { modelVersion: 'none', items: [] };
      const body: Record<string, unknown> = {
        modelVersion: snap.modelVersion,
        count: snap.items.length,
        annotations: snap.items,
      };
      if (snap.items.length === 0) {
        body.note = `no active annotations${preview ? '' : ' (preview not started yet)'}`;
      }
      return { content: [{ type: 'text', text: yaml.stringify(body) }] };
    }

    if (name === 'capture_view') {
      const baseRenderOpts = captureRenderOptions(args);
      let annotations: ReturnType<PreviewServerHandle['getAnnotations']> | undefined;
      const capture = await opts.modelingSession.captureCurrent(() => {
        annotations = opts.peekPreview()?.getAnnotations();
        const renderOpts: RenderViewOptions = {
          ...baseRenderOpts,
          ...(baseRenderOpts.includeAnnotations ? { annotations: annotations?.items ?? [] } : {}),
        };
        return renderOpts;
      });
      if (!capture) {
        return toolResult(
          staticError(
            'NO_MODEL',
            'No model is available to capture. Run execute_script successfully before calling capture_view.',
          ),
        );
      }

      const artifact = capture.model.artifact;
      const result: RenderResult = capture.result;

      // Save PNG to disk instead of returning base64 image block
      const captureDir = join(tmpdir(), 'manifold3d-mcp-captures');
      await mkdir(captureDir, { recursive: true });
      const filename = `capture-${baseRenderOpts.view}-${Date.now()}.png`;
      const filePath = join(captureDir, filename);
      await writeFile(filePath, result.png);

      const metadata = {
        view: baseRenderOpts.view,
        width: result.width,
        height: result.height,
        filePath,
        includeAnnotations: baseRenderOpts.includeAnnotations,
        annotationCount: baseRenderOpts.includeAnnotations ? (annotations?.items.length ?? 0) : 0,
        modelVersion: annotations?.modelVersion,
        bboxMin: artifact.bboxMin,
        bboxMax: artifact.bboxMax,
        renderBackend: 'software-rasterizer',
      };
      return {
        content: [{ type: 'text', text: yaml.stringify(metadata) }],
        isError: false,
      };
    }

    return toolResult({
      ok: false,
      stage: 'runtime',
      errors: [
        {
          stage: 'runtime',
          code: 'RUNTIME_ERROR',
          message: `Unknown tool: ${name}`,
        },
      ],
      warnings: [],
      hints: [],
    });
  };

  server.setRequestHandler(CallToolRequestSchema, req => {
    if (!acceptingToolCalls) {
      return Promise.resolve(
        toolResult({
          ok: false,
          stage: 'runtime',
          errors: [{ stage: 'runtime', code: 'RUNTIME_ERROR', message: 'The MCP server is shutting down.' }],
          warnings: [],
          hints: [],
        }),
      );
    }
    const operation = handleToolCall(req);
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    );
    return operation;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[manifold3d-mcp] MCP server connected over stdio\n');
  return {
    drain(): Promise<void> {
      acceptingToolCalls = false;
      drainPromise ??= withTimeout(
        (async () => {
          const accepted = [...inFlight];
          if (accepted.length > 0) {
            await Promise.allSettled(accepted);
          }
          // Let the SDK continuation serialize settled handler responses.
          await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
          await flushStdout();
        })(),
        SHUTDOWN_DRAIN_TIMEOUT_MS,
        `MCP request drain exceeded ${SHUTDOWN_DRAIN_TIMEOUT_MS} ms.`,
      );
      return drainPromise;
    },
    close(): Promise<void> {
      acceptingToolCalls = false;
      return server.close();
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      value => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function flushStdout(): Promise<void> {
  if (process.stdout.destroyed) {
    return Promise.reject(new Error('Cannot flush MCP responses because stdout is closed.'));
  }
  return new Promise<void>((resolveFlush, reject) => {
    process.stdout.write('', error => {
      if (error) {
        reject(error);
      } else {
        resolveFlush();
      }
    });
  });
}

type ScriptSource = { code: string; suppressSnippet: boolean } | { report: Report };

async function readPackageVersion(): Promise<string> {
  const manifestUrl = new URL('../../../package.json', import.meta.url);
  const manifest: unknown = JSON.parse(await readFile(manifestUrl, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new Error(`Package manifest at ${manifestUrl.href} does not contain a string version.`);
  }
  return manifest.version;
}

async function loadScriptSource(args: Record<string, unknown>): Promise<ScriptSource> {
  const hasCode = Object.hasOwn(args, 'code');
  const hasFilePath = Object.hasOwn(args, 'filePath');

  if (hasCode === hasFilePath) {
    return {
      report: staticError('INVALID_ARGUMENT', 'Pass exactly one of `code` or `filePath`.'),
    };
  }

  if (hasCode) {
    if (typeof args.code !== 'string' || args.code.length === 0) {
      return {
        report: staticError('INVALID_ARGUMENT', 'Tool argument `code` must be a non-empty string.'),
      };
    }
    return { code: args.code, suppressSnippet: false };
  }

  if (typeof args.filePath !== 'string' || args.filePath.length === 0) {
    return {
      report: staticError('FILE_READ_ERROR', 'Tool argument `filePath` must be a non-empty string.'),
    };
  }

  if (!isAbsolute(args.filePath)) {
    return {
      report: staticError('INVALID_ARGUMENT', 'Tool argument `filePath` must be an absolute path.'),
    };
  }

  const requestedPath = resolve(args.filePath);
  const ext = extname(requestedPath).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
    return {
      report: staticError(
        'FILE_NOT_ALLOWED',
        `filePath extension '${ext || '(none)'}' is not permitted; allowed: ${[...ALLOWED_FILE_EXTENSIONS].join(', ')}`,
      ),
    };
  }

  let realPath: string;
  try {
    realPath = await realpath(requestedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        report: staticError(
          'FILE_READ_ERROR',
          `Could not read \`filePath\` ${requestedPath}: ${(error as Error).message}`,
        ),
      };
    }
    return {
      report: staticError(
        'FILE_READ_ERROR',
        `Could not resolve \`filePath\` ${requestedPath}: ${(error as Error).message}`,
      ),
    };
  }

  const canonicalExtension = extname(realPath).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(canonicalExtension)) {
    return {
      report: staticError(
        'FILE_NOT_ALLOWED',
        `filePath resolves to extension '${canonicalExtension || '(none)'}', which is not permitted; allowed: ${[
          ...ALLOWED_FILE_EXTENSIONS,
        ].join(', ')}`,
      ),
    };
  }

  const allowedRoots = await getAllowedRoots();
  if (!isWithinAnyRoot(realPath, allowedRoots)) {
    return {
      report: staticError(
        'FILE_NOT_ALLOWED',
        `filePath '${requestedPath}' is outside the allowed roots; set MANIFOLD_MCP_SCRIPT_ROOTS to permit additional directories.`,
      ),
    };
  }

  try {
    const handle = await open(realPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        return { report: staticError('FILE_READ_ERROR', `Tool argument \`filePath\` is not a file: ${requestedPath}`) };
      }
      if (info.size > MAX_CODE_BYTES) {
        return {
          report: staticError(
            'CODE_TOO_LARGE',
            `File exceeds the ${MAX_CODE_BYTES} byte source limit: ${requestedPath} (${info.size} bytes).`,
          ),
        };
      }
      return { code: await handle.readFile('utf8'), suppressSnippet: true };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { report: staticError('FILE_READ_ERROR', `Could not read \`filePath\` ${requestedPath}: ${message}`) };
  }
}

/**
 * Resolved, deduped allow-list of directories under which `filePath` sources
 * may be loaded. Computed once on first call and cached for the lifetime of
 * the process — `MANIFOLD_MCP_SCRIPT_ROOTS` is not hot-reloaded.
 *
 * Default roots: `process.cwd()` and `<cwd>/samples`. The samples directory
 * is always added even when `MANIFOLD_MCP_SCRIPT_ROOTS` is set so the bundled
 * sample scripts remain reachable without requiring callers to list it
 * manually.
 *
 * Roots are resolved with `realpath` so that downstream containment checks
 * compare canonical paths (defeats `..` traversal and symlink trickery).
 * Missing roots are warned to stderr and skipped.
 */
let cachedRoots: Promise<string[]> | undefined;

function getAllowedRoots(): Promise<string[]> {
  if (cachedRoots === undefined) {
    cachedRoots = resolveAllowedRoots();
  }
  return cachedRoots;
}

async function resolveAllowedRoots(): Promise<string[]> {
  const candidates: string[] = [];
  const env = process.env.MANIFOLD_MCP_SCRIPT_ROOTS;
  if (env && env.length > 0) {
    for (const part of env.split(delimiter)) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        candidates.push(resolve(trimmed));
      }
    }
  } else {
    candidates.push(process.cwd());
  }
  // Always allow the bundled samples directory regardless of env override.
  candidates.push(resolve('samples'));

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const real = await realpath(candidate);
      if (!resolved.includes(real)) {
        resolved.push(real);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[manifold3d-mcp] warning: MANIFOLD_MCP_SCRIPT_ROOTS entry skipped (${candidate}): ${message}\n`,
      );
    }
  }
  return resolved;
}

function isWithinAnyRoot(realFilePath: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    const rel = relative(root, realFilePath);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

type CaptureRenderOptions = Required<Omit<RenderViewOptions, 'annotations'>>;

function captureRenderOptions(args: Record<string, unknown>): CaptureRenderOptions {
  const view: CaptureView =
    typeof args.view === 'string' && CAPTURE_VIEWS.has(args.view as CaptureView) ? (args.view as CaptureView) : 'iso';
  const rawWidth = typeof args.width === 'number' && Number.isFinite(args.width) ? args.width : 1024;
  const rawHeight = typeof args.height === 'number' && Number.isFinite(args.height) ? args.height : 1024;
  return {
    view,
    width: Math.max(128, Math.min(2048, Math.round(rawWidth))),
    height: Math.max(128, Math.min(2048, Math.round(rawHeight))),
    includeAnnotations: typeof args.includeAnnotations === 'boolean' ? args.includeAnnotations : false,
  };
}

function staticError(code: string, message: string): Report {
  return {
    ok: false,
    stage: 'static',
    errors: [
      {
        stage: 'static',
        code,
        message,
      },
    ],
    warnings: [],
    hints: [],
  };
}

function toolResult(report: Report) {
  return {
    content: [{ type: 'text', text: reportToYaml(report) }],
    isError: !report.ok,
  };
}
