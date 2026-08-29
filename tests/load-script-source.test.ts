import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { MAX_CODE_BYTES } from '../packages/modeling/src/validation/validators.js';

// `loadScriptSource` is not exported from packages/manifold3d-mcp/src/server/mcp/mcp-server.ts (and
// that file is in the no-touch list for this phase). We exercise its behaviour
// through the running MCP server over stdio. This is an integration-style
// unit test scoped to one helper, gated on the dist build that smoke uses.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'packages', 'manifold3d-mcp', 'dist', 'server', 'index.js');

interface ToolResult {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
}

class MiniHarness {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderr = '';

  start(extraScriptRoot?: string): void {
    // SEC-2 (already partially landed) restricts filePath to MANIFOLD_MCP_SCRIPT_ROOTS.
    // When the test temp dir lives outside the repo (the implicit root),
    // the harness needs to opt-in by extending MANIFOLD_MCP_SCRIPT_ROOTS.
    const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: 'none', MANIFOLD_MCP_NO_OPEN: '1' };
    if (extraScriptRoot !== undefined) {
      env.MANIFOLD_MCP_SCRIPT_ROOTS = extraScriptRoot;
    }
    this.child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>(r => setTimeout(r, 1500))]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  call<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error('Harness not started');
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout for ${method}\nstderr:\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => resolve(v as T),
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    const child = this.child;
    if (!child) {
      throw new Error('Harness not started');
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let msg: { id?: number; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }
}

const distExists = (): boolean => {
  try {
    return existsSync(entry);
  } catch {
    return false;
  }
};

const skipUnlessBuilt = !distExists() || process.env.SKIP_RUNNER_TESTS === '1';

describe.skipIf(skipUnlessBuilt)('loadScriptSource (via MCP server)', () => {
  const harness = new MiniHarness();
  let tempDir: string;
  let oversizePath: string;
  let nonExistentPath: string;
  let directoryPath: string;
  let validSamplePath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'manifold3d-mcp-loadsrc-'));
    oversizePath = join(tempDir, 'oversize.ts');
    nonExistentPath = join(tempDir, 'does-not-exist.ts');
    // The SEC-2 file-extension allow-list rejects extensionless paths
    // before stat() runs. Give the directory a .ts extension so the
    // FILE_READ_ERROR (not-a-file) branch is exercised.
    directoryPath = join(tempDir, 'a-dir.ts');
    validSamplePath = join(tempDir, 'valid.ts');

    // Build an oversize file: padding > MAX_CODE_BYTES.
    const tail = 'result = Manifold.cube();\n';
    const padBytes = MAX_CODE_BYTES + 1 - Buffer.byteLength(tail, 'utf8');
    writeFileSync(oversizePath, 'x'.repeat(padBytes) + tail, 'utf8');

    mkdirSync(directoryPath, { recursive: true });

    writeFileSync(
      validSamplePath,
      'const size: [number, number, number] = [3, 3, 3]; result = Manifold.cube(size, true);\n',
      'utf8',
    );

    harness.start(tempDir);
    await harness.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'load-script-source-tests', version: '0' },
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

  const callValidate = async (args: Record<string, unknown>): Promise<string> => {
    const r = await harness.call<ToolResult>('tools/call', { name: 'validate_script', arguments: args });
    return r.content[0].text;
  };

  it('reports FILE_READ_ERROR for a non-existent file', async () => {
    const text = await callValidate({ filePath: nonExistentPath });
    expect(text).toMatch(/FILE_READ_ERROR/);
  });

  it('reports FILE_READ_ERROR for a directory path', async () => {
    const text = await callValidate({ filePath: directoryPath });
    expect(text).toMatch(/FILE_READ_ERROR/);
  });

  it('reports CODE_TOO_LARGE for an oversize file', async () => {
    const text = await callValidate({ filePath: oversizePath });
    expect(text).toMatch(/CODE_TOO_LARGE/);
  });

  it('loads an existing valid sample file', async () => {
    const text = await callValidate({ filePath: validSamplePath });
    expect(text).toMatch(/ok: true/);
  });

  // SEC-2: filePath is restricted to the configured MANIFOLD_MCP_SCRIPT_ROOTS, and
  // only `.ts/.js/.mjs/.cts/.mts` extensions are accepted. The harness above
  // opted-in to `tempDir`; we now exercise a path that lives OUTSIDE that
  // allow-list and a path inside it but with a disallowed extension.
  it('rejects paths outside MANIFOLD_MCP_SCRIPT_ROOTS allow-list', async () => {
    // mkdtempSync returns a system-tmp path. A *second* mkdtemp produces a
    // sibling directory that is NOT under the allow-list we passed in.
    const outsideDir = mkdtempSync(join(tmpdir(), 'manifold3d-mcp-load-source-outside-'));
    try {
      const outsidePath = join(outsideDir, 'evil.ts');
      writeFileSync(outsidePath, 'result = Manifold.cube();\n', 'utf8');
      const text = await callValidate({ filePath: outsidePath });
      expect(text).toMatch(/FILE_NOT_ALLOWED/);
      expect(text).toMatch(/outside the allowed roots/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects non-.ts/.js/.mjs extensions', async () => {
    const jsonPath = join(tempDir, 'config.json');
    writeFileSync(jsonPath, '{"hello":"world"}\n', 'utf8');
    const text = await callValidate({ filePath: jsonPath });
    expect(text).toMatch(/FILE_NOT_ALLOWED/);
    expect(text).toMatch(/extension '\.json' is not permitted/);
  });

  it('rejects an allowed-name symlink whose canonical target has a disallowed extension', async () => {
    const jsonPath = join(tempDir, 'linked-config.json');
    const symlinkPath = join(tempDir, 'linked-config.ts');
    writeFileSync(jsonPath, '{"hello":"world"}\n', 'utf8');
    symlinkSync(jsonPath, symlinkPath);
    const text = await callValidate({ filePath: symlinkPath });
    expect(text).toMatch(/FILE_NOT_ALLOWED/);
    expect(text).toMatch(/resolves to extension '\.json'/);
  });

  it.skipIf(process.platform === 'win32')('rejects a named pipe without waiting for a writer', async () => {
    const fifoPath = join(tempDir, 'blocked.ts');
    const created = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const text = await callValidate({ filePath: fifoPath });
    expect(text).toMatch(/FILE_READ_ERROR/);
    expect(text).toMatch(/is not a file/);
  });

  it('round-trips a sample under MANIFOLD_MCP_SCRIPT_ROOTS opt-in', async () => {
    // `tempDir` is the root we opted-in to in beforeAll(). A fresh sample
    // under it should validate successfully end-to-end (this is the happy
    // path that proves the allow-list is *additive*, not just restrictive).
    const optInPath = join(tempDir, 'opt-in.ts');
    writeFileSync(optInPath, 'result = Manifold.sphere(1);\n', 'utf8');
    const text = await callValidate({ filePath: optInPath });
    expect(text).toMatch(/ok: true/);
  });
});
