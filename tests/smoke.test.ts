import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface, type Interface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'dist', 'server', 'index.js');
const skipUnlessBuilt = !existsSync(entry);

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

interface ToolResult {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
}

interface ReportIssue {
  stage?: string;
  code?: string;
  message: string;
  line?: number;
  snippet?: string;
  tsCode?: number;
}

interface ValidationReport {
  ok: boolean;
  stage: string;
  errors: ReportIssue[];
}

interface ToolsListResult {
  tools: Array<{ name: string }>;
}

interface PendingRequest {
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class McpHarness {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readline: Interface | undefined;
  private stderr = '';

  start(): void {
    this.child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', MANIFOLD_MCP_NO_OPEN: '1' },
    });

    this.readline = createInterface({ input: this.child.stdout });
    this.readline.on('line', line => this.handleLine(line));

    this.child.stderr.on('data', chunk => {
      this.stderr += chunk.toString('utf8');
    });

    this.child.once('exit', (code, signal) => {
      const error = new Error(`MCP server exited unexpectedly: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
  }

  async stop(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MCP server stopped with pending request ${id}`));
      this.pending.delete(id);
    }
    this.readline?.close();

    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(2_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  async initialize(): Promise<void> {
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    this.notify('notifications/initialized');
    await sleep(50);
  }

  async call<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error('MCP server not started');
    }

    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}. Server stderr:\n${this.stderr}`));
      }, timeoutMs);

      this.pending.set(id, {
        timeout,
        resolve: value => resolve(value as T),
        reject,
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child) {
      throw new Error('MCP server not started');
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.call<ToolResult>('tools/call', { name, arguments: args });
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForAsync(predicate: () => Promise<boolean>, description: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function closeWebSocket(socket: WebSocket | undefined): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await Promise.race([
    new Promise<void>(resolve => {
      socket.once('close', () => resolve());
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else {
        socket.close();
      }
    }),
    sleep(500).then(() => {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    }),
  ]);
}

function textOf(result: ToolResult): string {
  const text = result.content.find(item => item.type === 'text');
  expect(text).toBeTruthy();
  return text!.text;
}

function reportOf(result: ToolResult): ValidationReport {
  return parseYaml(textOf(result)) as ValidationReport;
}

async function validateWith(harness: McpHarness, code: string): Promise<ValidationReport> {
  return reportOf(await harness.callTool('validate_script', { code }));
}

function expectError(
  report: ValidationReport,
  expected: { stage: string; code: string; tsCode?: number },
): ReportIssue {
  const issue = report.errors?.find(
    error =>
      error.stage === expected.stage &&
      error.code === expected.code &&
      (expected.tsCode === undefined || error.tsCode === expected.tsCode),
  );
  expect(issue).toEqual(expect.objectContaining(expected));
  return issue!;
}

describe.skipIf(skipUnlessBuilt)('MCP smoke tests', () => {
  const harness = new McpHarness();

  beforeAll(async () => {
    harness.start();
    await harness.initialize();
  }, 35_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('lists the expected tools', async () => {
    const tools = await harness.call<ToolsListResult>('tools/list', {});

    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'capture_view',
      'execute_script',
      'get_annotations',
      'validate_script',
    ]);
  });

  it('returns NO_MODEL when capturing before any preview model exists', async () => {
    const result = await harness.callTool('capture_view');

    expect(result.isError).toBe(true);
    const report = reportOf(result);
    expectError(report, { stage: 'static', code: 'NO_MODEL' });
  });

  it('validates TypeScript snippets with annotations and helpers', async () => {
    const report = await validateWith(
      harness,
      `
function makePost(width: number, depth: number, height: number): Manifold {
  const size: [number, number, number] = [width, depth, height];
  return Manifold.cube(size, true);
}
const offsets: Array<[number, number, number]> = [[-4, 0, 0], [4, 0, 0]];
const posts = offsets.map(offset => makePost(3, 3, 10).translate(offset));
result = Manifold.union(...posts);
`,
    );

    expect(report.ok).toBe(true);
    expect(report.stage).toBe('ok');
    expect(report.errors).toEqual([]);
  });

  it.each([
    {
      name: 'unknown Manifold.box API',
      code: 'result = Manifold.box([10, 10, 10]);',
    },
    {
      name: 'singular CrossSection.ofPolygon API',
      code: 'result = CrossSection.ofPolygon([[0, 0], [1, 0], [0, 1]]).extrude(2);',
    },
    {
      name: 'options-object Manifold.cylinder call',
      code: 'result = Manifold.cylinder({ height: 5 });',
    },
    {
      name: 'CrossSection assigned to result',
      code: 'result = CrossSection.square([2, 2]);',
    },
    {
      name: 'number assigned to result',
      code: 'result = 42;',
    },
    {
      name: 'malformed tuple vector',
      code: 'const size: [number, number, number] = [1, 2]; result = Manifold.cube(size);',
    },
    {
      name: 'possibly undefined result assignment',
      code: 'const parts: Manifold[] = []; result = parts[0];',
    },
  ])('blocks $name at typecheck', async ({ code }) => {
    const report = await validateWith(harness, code);

    expect(report.ok).toBe(false);
    expect(report.stage).toBe('typecheck');
    expectError(report, { stage: 'typecheck', code: 'TS_DIAGNOSTIC' });
  });

  it('adds sandbox-specific guidance to result type errors', async () => {
    const crossSectionReport = await validateWith(harness, 'result = CrossSection.square([2, 2]);');
    const undefinedReport = await validateWith(harness, 'const parts: Manifold[] = []; result = parts[0];');

    expectError(crossSectionReport, { stage: 'typecheck', code: 'TS_DIAGNOSTIC' });
    expect(crossSectionReport.errors.map(error => error.message).join('\n')).toMatch(/result must be a manifold/i);
    expectError(undefinedReport, { stage: 'typecheck', code: 'TS_DIAGNOSTIC' });
    expect(undefinedReport.errors.map(error => error.message).join('\n')).toMatch(/cannot be undefined/);
  });

  it('blocks forbidden globals and imports at static stage before typecheck', async () => {
    const report = await validateWith(
      harness,
      `
import fs from 'node:fs';
process.exit(1);
result = Manifold.box([1, 1, 1]);
`,
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe('static');
    expectError(report, { stage: 'static', code: 'FORBIDDEN_GLOBAL' });
    expect(report.errors ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'typecheck', code: 'TS_DIAGNOSTIC' })]),
    );
  });

  it('blocks exports at static stage before emitted JavaScript execution', async () => {
    const report = await validateWith(harness, 'export const part = Manifold.cube(); result = part;');

    expect(report.ok).toBe(false);
    expect(report.stage).toBe('static');
    expectError(report, { stage: 'static', code: 'FORBIDDEN_GLOBAL' });
  });

  it('reaches geometry validation for empty booleans', async () => {
    const report = await validateWith(
      harness,
      `
const a = Manifold.cube([10, 10, 10]);
const b = Manifold.cube([10, 10, 10]).translate([100, 0, 0]);
result = a.intersect(b);
`,
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe('geometry');
    expectError(report, { stage: 'geometry', code: 'EMPTY_RESULT' });
  });

  it('reports runtime errors with user snippet line context', async () => {
    const report = await validateWith(
      harness,
      `
const size: [number, number, number] = [10, 10, 10];
throw new Error('boom');
result = Manifold.cube(size);
`,
    );

    const error = expectError(report, { stage: 'runtime', code: 'RUNTIME_ERROR' });
    expect(error.line).toBe(3);
    expect(error.snippet).toMatch(/throw new Error\('boom'\)/);
  });

  it('executes a cube and returns a preview URL', async () => {
    const result = await harness.callTool('execute_script', {
      code: 'const size: [number, number, number] = [20, 20, 20]; result = Manifold.cube(size, true);',
      description: 'unit-cube',
    });

    const report = textOf(result);
    expect(report).toMatch(/ok: true/);
    expect(report).toMatch(/triangles: 12/);
    expect(report).toMatch(/previewUrl:/);

    // Verify the preview server is actually serving the viewer bundle —
    // a regression here surfaced when restructuring src/server moved
    // preview-server.js into a subfolder and the relative `public/` path
    // broke. Hitting `/` should return the index.html, not a 404.
    const previewUrl = report.match(/previewUrl:\s*(\S+)/)?.[1];
    expect(previewUrl).toBeTruthy();
    const httpRes = await fetch(previewUrl!);
    expect(httpRes.status).toBe(200);
    const body = await httpRes.text();
    expect(body).toMatch(/<!doctype html>/i);
  });

  it('captures the last preview model as PNG with metadata', async () => {
    await harness.callTool('execute_script', {
      code: 'result = Manifold.cube([12, 8, 4], true);',
      description: 'capture-cube',
    });

    const result = await harness.callTool('capture_view', { view: 'front', width: 160, height: 128 });

    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual(expect.objectContaining({ type: 'text' }));

    const metadata = parseYaml(textOf(result)) as Record<string, unknown>;
    expect(metadata).toEqual(
      expect.objectContaining({
        view: 'front',
        width: 160,
        height: 128,
        includeAnnotations: false,
        renderBackend: 'software-rasterizer',
      }),
    );
    expect(metadata).toHaveProperty('filePath');
    const filePath = metadata.filePath as string;
    const png = await readFile(filePath);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(160);
    expect(png.readUInt32BE(20)).toBe(128);
    expect(metadata.modelVersion).toEqual(expect.stringMatching(/^v/));
    expect(metadata.bboxMin).toEqual([-6, -4, -2]);
    expect(metadata.bboxMax).toEqual([6, 4, 2]);
  });

  it('captures with includeAnnotations=true after point and sketch annotations are present', async () => {
    let annotationSocket: WebSocket | undefined;

    try {
      const execution = await harness.callTool('execute_script', {
        code: 'result = Manifold.cube([10, 10, 10], true);',
        description: 'capture-with-annotations',
      });
      const previewUrl = textOf(execution).match(/previewUrl:\s*(\S+)/)?.[1];
      expect(previewUrl).toBeTruthy();

      const wsUrl = `${previewUrl!.replace(/^http/, 'ws')}ws`;
      const wsOrigin = new URL(previewUrl!).origin;
      const wsHost = new URL(previewUrl!).host;
      annotationSocket = new WebSocket(wsUrl, { headers: { Origin: wsOrigin, Host: wsHost } });

      let serverModelVersion: string | undefined;
      annotationSocket.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'model_version' &&
          'modelVersion' in message &&
          typeof message.modelVersion === 'string'
        ) {
          serverModelVersion = message.modelVersion;
        }
      });

      await new Promise<void>((resolve, reject) => {
        annotationSocket?.once('open', () => resolve());
        annotationSocket?.once('error', reject);
      });
      await waitFor(() => typeof serverModelVersion === 'string', 'capture annotation model_version');

      annotationSocket.send(
        JSON.stringify({
          kind: 'annotations',
          modelVersion: serverModelVersion,
          items: [
            {
              id: 'capture-point-1',
              modelVersion: serverModelVersion,
              kind: 'point',
              partLabel: 'point#1',
              note: 'capture this point',
              worldCoord: [1, 2, 3],
            },
            {
              id: 'capture-sketch-1',
              modelVersion: serverModelVersion,
              kind: 'sketch',
              partLabel: 'sketch#1',
              note: 'capture this sketch',
              worldCoord: [0, 0, 5],
              viewPlane: 'front',
              planeOrigin: [0, 0, 5],
              strokes: [
                [
                  [0, 0],
                  [1, 1],
                ],
              ],
            },
          ],
        }),
      );

      let annotations = '';
      await waitForAsync(async () => {
        annotations = textOf(await harness.callTool('get_annotations'));
        return /count:\s*2/.test(annotations);
      }, 'point and sketch annotation snapshot');
      expect(annotations).toMatch(/partLabel:\s*point#1/);
      expect(annotations).toMatch(/kind:\s*sketch/);
      expect(annotations).toMatch(/partLabel:\s*sketch#1/);

      const result = await harness.callTool('capture_view', {
        view: 'iso',
        width: 128,
        height: 128,
        includeAnnotations: true,
      });

      expect(result.isError).toBe(false);
      expect(result.content[0]).toEqual(expect.objectContaining({ type: 'text' }));

      const metadata = parseYaml(textOf(result)) as Record<string, unknown>;
      expect(metadata).toEqual(
        expect.objectContaining({
          view: 'iso',
          width: 128,
          height: 128,
          includeAnnotations: true,
          modelVersion: serverModelVersion,
          renderBackend: 'software-rasterizer',
        }),
      );
      expect(metadata).toHaveProperty('filePath');
      const png = await readFile(metadata.filePath as string);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      await closeWebSocket(annotationSocket);
    }
  }, 35_000);

  it('validates and executes snippets loaded from an absolute local filePath', async () => {
    // Allow-list (SEC-2) requires filePath be inside MANIFOLD_MCP_SCRIPT_ROOTS,
    // which defaults to the harness CWD (= repoRoot). Create the temp dir
    // inside the repo so the default allow-list accepts it.
    const tempDir = await mkdtemp(join(repoRoot, '.manifold3d-mcp-smoke-'));
    try {
      const filePath = join(tempDir, 'file-snippet.ts');
      await writeFile(
        filePath,
        'const size: [number, number, number] = [7, 8, 9]; result = Manifold.cube(size, true);\n',
      );

      const validation = await harness.callTool('validate_script', { filePath });
      const validationReport = reportOf(validation);
      expect(validationReport.ok).toBe(true);
      expect(validationReport.errors).toEqual([]);

      const execution = await harness.callTool('execute_script', {
        filePath,
        description: 'file-snippet',
      });
      const executionText = textOf(execution);
      expect(executionText).toMatch(/ok: true/);
      expect(executionText).toMatch(/triangles: 12/);
      expect(executionText).toMatch(/previewUrl:/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects filePath sources outside the MANIFOLD_MCP_SCRIPT_ROOTS allow-list', async () => {
    // tmpdir() is outside the harness CWD (= repoRoot) and thus outside
    // the default allow-list. The error must NOT echo file contents.
    const tempDir = await mkdtemp(join(tmpdir(), 'manifold3d-mcp-outside-'));
    try {
      const filePath = join(tempDir, 'leak.ts');
      const secret = 'SECRET_SHOULD_NOT_LEAK_42';
      await writeFile(filePath, `// ${secret}\nresult = Manifold.cube([1,1,1]);\n`);

      const result = await harness.callTool('validate_script', { filePath });
      const text = textOf(result);
      expect(text).toMatch(/FILE_NOT_ALLOWED/);
      expect(text).toMatch(/outside the allowed roots/);
      expect(text).toMatch(/MANIFOLD_MCP_SCRIPT_ROOTS/);
      expect(text).not.toContain(secret);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects filePath sources with a disallowed extension', async () => {
    const result = await harness.callTool('validate_script', {
      filePath: join(repoRoot, 'package.json'),
    });
    const text = textOf(result);
    expect(text).toMatch(/FILE_NOT_ALLOWED/);
    expect(text).toMatch(/extension '\.json' is not permitted/);
  });

  it('omits diagnostic snippets for filePath-loaded sources', async () => {
    const tempDir = await mkdtemp(join(repoRoot, '.manifold3d-mcp-smoke-'));
    try {
      const filePath = join(tempDir, 'unknown-api.ts');
      // Manifold.box is not a known static API → emits an UNKNOWN_API
      // warning that historically included a `snippet` echo. With SEC-2
      // the snippet field must be omitted.
      await writeFile(filePath, 'result = Manifold.box([1, 1, 1]);\n');

      const result = await harness.callTool('validate_script', { filePath });
      const report = reportOf(result);
      const allIssues = [
        ...(report.errors ?? []),
        ...((report as unknown as { warnings?: ReportIssue[] }).warnings ?? []),
      ];
      for (const issue of allIssues) {
        expect(issue.snippet).toBeUndefined();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous script source arguments', async () => {
    const result = await harness.callTool('validate_script', {
      code: 'result = Manifold.cube(1);',
      filePath: join(repoRoot, 'samples', '92-k2-terrain.ts'),
    });

    expect(textOf(result)).toMatch(/INVALID_ARGUMENT/);
    expect(textOf(result)).toMatch(/Pass exactly one of `code` or `filePath`/);
  });

  it('rejects relative filePath arguments', async () => {
    const result = await harness.callTool('validate_script', {
      filePath: '92-k2-terrain.ts',
    });

    expect(textOf(result)).toMatch(/INVALID_ARGUMENT/);
    expect(textOf(result)).toMatch(/must be an absolute path/);
  });

  it('catches missing result assignment during validation', async () => {
    const result = await harness.callTool('validate_script', {
      code: 'Manifold.cube([1,1,1]);',
    });

    expect(textOf(result)).toMatch(/RESULT_NOT_ASSIGNED/);
  });

  it('catches forbidden globals during validation', async () => {
    const result = await harness.callTool('validate_script', {
      code: 'const fs = require("fs"); result = Manifold.cube([1,1,1]);',
    });

    expect(textOf(result)).toMatch(/FORBIDDEN_GLOBAL/);
  });

  it('gives actionable static hints for common API assumptions', async () => {
    const result = await harness.callTool('validate_script', {
      code:
        'const profile = CrossSection.roundedRectangle([20, 10], 2); ' +
        'const boss = Manifold.cylinder({ height: 5, radiusLow: 2 }); ' +
        'result = Manifold.box([10,10,10]).add(boss).rotate([0, 0, Math.PI / 2]);',
    });

    const report = textOf(result);
    expect(report).toMatch(/UNKNOWN_API/);
    expect(report).toMatch(/Manifold\.cube/);
    expect(report).toMatch(/No roundedRectangle helper exists/);
    expect(report).toMatch(/positional arguments/);
    expect(report).toMatch(/RADIANS_DETECTED/);
  });

  it('reports an empty intersection', async () => {
    const result = await harness.callTool('execute_script', {
      code:
        'const a = Manifold.cube([10,10,10]); ' +
        'const b = Manifold.cube([10,10,10]).translate([100,0,0]); ' +
        'result = a.intersect(b);',
      description: 'disjoint-intersect',
    });

    const report = textOf(result);
    expect(report).toMatch(/EMPTY_RESULT/);
    expect(report).not.toMatch(/\.inf/);
  });

  it('supports cube minus sphere execution', async () => {
    const result = await harness.callTool('execute_script', {
      code: 'const c = Manifold.cube([20,20,20], true); const s = Manifold.sphere(12, 32); result = c.subtract(s);',
      description: 'cube-minus-sphere',
    });

    expect(textOf(result)).toMatch(/ok: true/);
  });

  it('roundtrips annotations over websocket and clears them after a new model push', async () => {
    let annotationSocket: WebSocket | undefined;

    try {
      const initial = await harness.callTool('execute_script', {
        code: 'result = Manifold.cube([5,5,5]);',
        description: 'tiny-cube-for-anno-test',
      });
      const previewUrl = textOf(initial).match(/previewUrl:\s*(\S+)/)?.[1];
      expect(previewUrl).toBeTruthy();

      const wsUrl = `${previewUrl!.replace(/^http/, 'ws')}ws`;
      // Match the headers a browser would naturally send when the viewer
      // page (served from previewUrl) opens a WebSocket back to /ws. The
      // server's Origin/Host allow-list rejects requests without them.
      const wsOrigin = new URL(previewUrl!).origin;
      const wsHost = new URL(previewUrl!).host;
      annotationSocket = new WebSocket(wsUrl, { headers: { Origin: wsOrigin, Host: wsHost } });
      annotationSocket.binaryType = 'arraybuffer';

      let serverModelVersion: string | undefined;
      annotationSocket.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'model_version' &&
          'modelVersion' in message &&
          typeof message.modelVersion === 'string'
        ) {
          serverModelVersion = message.modelVersion;
        }
      });

      await new Promise<void>((resolve, reject) => {
        annotationSocket?.once('open', () => resolve());
        annotationSocket?.once('error', reject);
      });

      await waitFor(() => typeof serverModelVersion === 'string', 'initial model_version');
      const previousVersion = serverModelVersion;
      await harness.callTool('execute_script', {
        code: 'result = Manifold.cube([6,6,6]);',
        description: 'fresh-cube-for-anno-test',
      });
      await waitFor(
        () => typeof serverModelVersion === 'string' && serverModelVersion !== previousVersion,
        'model_version after execute_script',
      );

      annotationSocket.send(
        JSON.stringify({
          kind: 'annotations',
          modelVersion: serverModelVersion,
          items: [
            {
              id: 'ann_test_1',
              modelVersion: serverModelVersion,
              kind: 'point',
              partLabel: 'point#1',
              note: 'too thick',
              worldCoord: [1.5, 0, 2.0],
            },
          ],
        }),
      );
      let annotations = '';
      await waitForAsync(async () => {
        annotations = textOf(await harness.callTool('get_annotations'));
        return /count:\s*1/.test(annotations);
      }, 'annotation snapshot');
      expect(annotations).toMatch(/count:\s*1/);
      expect(annotations).toMatch(/note:\s*too thick/);
      expect(annotations).toMatch(/partLabel:\s*point#1/);

      await harness.callTool('execute_script', {
        code: 'result = Manifold.cube([7,7,7]);',
        description: 'second-tiny-cube',
      });
      await sleep(50);

      const cleared = textOf(await harness.callTool('get_annotations'));
      expect(cleared).toMatch(/count:\s*0/);
      expect(cleared).toMatch(/no active annotations/);
    } finally {
      await closeWebSocket(annotationSocket);
    }
  }, 35_000);
});
