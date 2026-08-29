// SEC-3 regression suite: prove the WebSocket upgrade handler enforces the
// Origin/Host allow-list. The preview server only accepts origins that
// match `http://127.0.0.1:<port>` or `http://localhost:<port>` (and adds
// `http://127.0.0.1:5173` / `http://localhost:5173` when NODE_ENV is set
// to 'development' for the Vite dev-server overlay). Anything else,
// including missing Origin or rebound Host, must be rejected at the HTTP
// upgrade — the client must never see a 101.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distPreview = join(repoRoot, 'packages', 'viewer-host', 'dist', 'preview', 'preview-server.js');
const distPublic = join(repoRoot, 'packages', 'viewer-host', 'dist', 'public', 'index.html');
const skipUnlessBuilt = !existsSync(distPreview) || !existsSync(distPublic);

interface PreviewModule {
  startPreviewServer: (
    preferredPort?: number,
    host?: string,
  ) => Promise<{
    url: string;
    close(): Promise<void>;
  }>;
}

const loadModule = async (): Promise<PreviewModule> => (await import(pathToFileURL(distPreview).href)) as PreviewModule;

type Outcome = 'open' | 'error' | 'close';

const attempt = async (
  wsUrl: string,
  headers: Record<string, string>,
  timeoutMs = 5_000,
): Promise<{ outcome: Outcome; statusCode?: number; message?: string }> => {
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl, {
      headers,
      handshakeTimeout: timeoutMs,
    });
    let settled = false;
    const finish = (result: { outcome: Outcome; statusCode?: number; message?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.removeAllListeners();
        // Swallow any post-finish error (e.g. "WebSocket was closed
        // before the connection was established" when terminate fires
        // while the socket is still in CONNECTING) so it doesn't
        // surface as a Vitest unhandled exception.
        ws.on('error', () => {
          /* swallow post-finish error */
        });
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        /* swallow */
      }
      resolve(result);
    };
    ws.on('open', () => finish({ outcome: 'open' }));
    ws.on('unexpected-response', (_req, res) =>
      finish({ outcome: 'error', ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}) }),
    );
    ws.on('error', err => finish({ outcome: 'error', message: err.message }));
    ws.on('close', code => finish({ outcome: 'close', statusCode: code }));
  });
};

describe.skipIf(skipUnlessBuilt)('SEC-3: preview WS rejects bad Origin/Host', () => {
  let port = 0;
  let wsUrl = '';
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const mod = await loadModule();
    const handle = await mod.startPreviewServer(47471, '127.0.0.1');
    port = Number(new URL(handle.url).port);
    wsUrl = `${handle.url.replace(/^http/, 'ws')}ws`;
    stop = () => handle.close();
  }, 30_000);

  afterAll(async () => {
    if (stop) {
      await stop();
    }
  });

  it('rejects upgrade requests with no Origin header', async () => {
    const result = await attempt(wsUrl, { Host: `127.0.0.1:${port}` });
    expect(result.outcome).not.toBe('open');
  });

  it('rejects upgrade requests with an evil Origin', async () => {
    const result = await attempt(wsUrl, {
      Origin: 'http://evil.example.com',
      Host: `127.0.0.1:${port}`,
    });
    expect(result.outcome).not.toBe('open');
  });

  it('accepts upgrade requests from http://127.0.0.1:<port>', async () => {
    const result = await attempt(wsUrl, {
      Origin: `http://127.0.0.1:${port}`,
      Host: `127.0.0.1:${port}`,
    });
    expect(result.outcome).toBe('open');
  });

  it('accepts upgrade requests from http://localhost:<port>', async () => {
    const result = await attempt(wsUrl.replace('127.0.0.1', 'localhost'), {
      Origin: `http://localhost:${port}`,
      Host: `localhost:${port}`,
    });
    expect(result.outcome).toBe('open');
  });

  it('rejects DNS-rebinding: trusted Origin paired with off-host Host header', async () => {
    // Classic DNS-rebinding scenario: attacker-controlled hostname resolves
    // to 127.0.0.1, browser sends a *trusted* Origin while the Host
    // header reflects the attacker's domain. Allow-list must cross-check.
    const result = await attempt(wsUrl, {
      Origin: `http://127.0.0.1:${port}`,
      Host: 'attacker.example.com',
    });
    expect(result.outcome).not.toBe('open');
  });
});

describe.skipIf(skipUnlessBuilt)('SEC-3: preview WS dev-mode allow-list', () => {
  let port = 0;
  let wsUrl = '';
  let stop: () => Promise<void>;
  let savedNodeEnv: string | undefined;

  beforeAll(async () => {
    // The preview server reads NODE_ENV at startPreviewServer-call time
    // and bakes the dev-mode origins into its allow-list. Splice it in
    // for the duration of this describe block.
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const mod = await loadModule();
    const handle = await mod.startPreviewServer(47521, '127.0.0.1');
    port = Number(new URL(handle.url).port);
    wsUrl = `${handle.url.replace(/^http/, 'ws')}ws`;
    stop = () => handle.close();
  }, 30_000);

  afterAll(async () => {
    if (stop) {
      await stop();
    }
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('accepts the Vite dev-server origin when NODE_ENV=development', async () => {
    const result = await attempt(wsUrl, {
      Origin: 'http://localhost:5173',
      Host: `127.0.0.1:${port}`,
    });
    expect(result.outcome).toBe('open');
  });
});
