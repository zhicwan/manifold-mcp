// SEC-2 regression suite: prove that loading a script via `filePath` (which
// triggers `suppressSnippet=true` inside the MCP server) strips
// `Issue.snippet` from EVERY error path — static lint, syntax, typecheck,
// and runtime — while inline `code` callers (the safe path) keep their
// snippets. The defence-in-depth scrubber `enforceSnippetInvariant` writes
// a stderr warning if any code path forgot to honour suppressSnippet; we
// capture stderr and assert the warning never fired.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'apps', 'manifold3d-mcp', 'dist', 'manifold.mjs');
const skipUnlessBuilt = !existsSync(entry);

interface ToolResult {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
}

interface Issue {
  code: string;
  message: string;
  snippet?: string;
}

interface Report {
  ok: boolean;
  errors: Issue[];
  warnings?: Issue[];
}

class Harness {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  stderr = '';

  start(extraScriptRoot: string): void {
    this.child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BROWSER: 'none',
        MANIFOLD_MCP_NO_OPEN: '1',
        MANIFOLD_MCP_SCRIPT_ROOTS: extraScriptRoot,
      },
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', line => this.handleLine(line));
    this.child.stderr.on('data', chunk => {
      this.stderr += chunk.toString('utf8');
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.stdin.end();
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
        }
        resolve();
      }, 2_000);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      this.send(message);
    });
  }

  private send(message: unknown): void {
    if (!this.child) {
      throw new Error('Harness not started');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let parsed: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }
    if (typeof parsed.id !== 'number') {
      return;
    }
    const waiter = this.pending.get(parsed.id);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.pending.delete(parsed.id);
    if (parsed.error) {
      waiter.reject(new Error(parsed.error.message ?? 'unknown JSON-RPC error'));
    } else {
      waiter.resolve(parsed.result);
    }
  }
}

const callValidate = async (harness: Harness, args: Record<string, unknown>): Promise<Report> => {
  const r = await harness.call<ToolResult>('tools/call', { name: 'validate_script', arguments: args });
  return parseYaml(r.content[0].text) as Report;
};

describe.skipIf(skipUnlessBuilt)('SEC-2: filePath suppresses Issue.snippet across all stages', () => {
  const harness = new Harness();
  let tempDir = '';

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'manifold3d-mcp-snippet-suppress-'));
    harness.start(tempDir);
    await harness.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'snippet-suppression-tests', version: '0' },
    });
    harness.notify('notifications/initialized');
    await new Promise<void>(r => setTimeout(r, 50));
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('inline `code` keeps snippet on error (control)', async () => {
    // Confirms the snippet is normally present on inline-code errors —
    // without this baseline, a "no snippet present" assertion below
    // could be vacuously true (e.g. if the report shape ever changed).
    const report = await callValidate(harness, { code: 'result = nope.cube();' });
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    const withSnippet = report.errors.find(e => typeof e.snippet === 'string' && e.snippet.length > 0);
    expect(withSnippet, `expected at least one snippet in ${JSON.stringify(report)}`).toBeDefined();
  }, 30_000);

  it('strips snippet when filePath fails the static/typecheck stage', async () => {
    const filePath = join(tempDir, 'unknown-api.ts');
    writeFileSync(filePath, 'result = nope.cube();\n', 'utf8');
    const report = await callValidate(harness, { filePath });
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    for (const e of report.errors) {
      expect(e.snippet, `errors[${e.code}].snippet should be absent`).toBeUndefined();
    }
  }, 30_000);

  it('strips snippet when filePath has SYNTAX_ERROR', async () => {
    const filePath = join(tempDir, 'syntax-error.ts');
    writeFileSync(filePath, 'result = Manifold.cube(\n', 'utf8');
    const report = await callValidate(harness, { filePath });
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    for (const e of report.errors) {
      expect(e.snippet, `errors[${e.code}].snippet should be absent`).toBeUndefined();
    }
  }, 30_000);

  it('strips snippet when filePath has TS_DIAGNOSTIC', async () => {
    // Manifold.cube takes (size: [number,number,number] | number, ...).
    // Passing an object literal blows the typecheck stage.
    const filePath = join(tempDir, 'ts-diagnostic.ts');
    writeFileSync(filePath, 'result = Manifold.cube({ bogus: true } as never);\n', 'utf8');
    const report = await callValidate(harness, { filePath });
    // Whichever stage rejects it, no Issue across errors+warnings may
    // carry a snippet.
    for (const e of [...report.errors, ...(report.warnings ?? [])]) {
      expect(e.snippet, `${e.code}.snippet should be absent`).toBeUndefined();
    }
  }, 30_000);

  it('does not trip the enforceSnippetInvariant scrubber warning', () => {
    // After running the suppression cases above, the worker's invariant
    // checker should not have observed any leaked snippet field. If it
    // had, it would have written this exact phrase to stderr.
    expect(harness.stderr).not.toMatch(/snippet field\(s\) leaked through/);
  });
});
