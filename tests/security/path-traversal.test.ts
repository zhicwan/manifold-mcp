// SEC-4 regression suite: prove the preview server's static-asset handler
// blocks every flavour of path traversal we can throw at it. fetch()
// normalises URLs client-side ("/../foo" collapses to "/foo" before the
// request goes on the wire) so the more dangerous probes use a raw socket
// to put literal `..` segments and percent-encoded bytes into the request
// line. The server defends by:
//   * outright rejecting any URL containing `%` (no decoding attempted), and
//   * resolving the requested path against `viewer-host/dist/public/` and rejecting any
//     result whose `relative()` walk leaves the public root.
// We assert all those branches end with a 4xx and never with package.json.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distPreview = join(repoRoot, 'packages', 'viewer-host', 'dist', 'preview', 'preview-server.js');
const distPublic = join(repoRoot, 'packages', 'viewer-host', 'dist', 'public');
const skipUnlessBuilt = !existsSync(distPreview) || !existsSync(join(distPublic, 'index.html'));

interface PreviewModule {
  startPreviewServer: (
    preferredPort?: number,
    host?: string,
  ) => Promise<{
    url: string;
    close(): Promise<void>;
  }>;
}

// Find a non-index.html static asset so we can exercise the asset path
// without depending on a specific file name. Returns null when the public
// directory only ships index.html (in which case the asset-targeted test
// is skipped via `it.skipIf`).
const findStaticAsset = (): string | null => {
  if (!existsSync(distPublic)) {
    return null;
  }
  try {
    const walk = (dir: string): string | null => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
          const inner = walk(full);
          if (inner) {
            return inner;
          }
        } else if (entry !== 'index.html') {
          return full.slice(distPublic.length).replace(/\\/g, '/');
        }
      }
      return null;
    };
    return walk(distPublic);
  } catch {
    return null;
  }
};

// fetch() normalises URLs and would collapse "/../package.json" into
// "/package.json" before sending the request — useless for testing the
// server's traversal defence. This helper writes a raw HTTP/1.0 request
// to a TCP socket so the server sees exactly the bytes we send.
const rawGet = async (port: number, requestPath: string): Promise<{ status: number; body: string }> => {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${requestPath} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buf += chunk;
    });
    socket.on('end', () => {
      const headerEnd = buf.indexOf('\r\n\r\n');
      const head = headerEnd === -1 ? buf : buf.slice(0, headerEnd);
      const body = headerEnd === -1 ? '' : buf.slice(headerEnd + 4);
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(head);
      const statusText = m?.[1];
      resolve({ status: statusText === undefined ? 0 : Number.parseInt(statusText, 10), body });
    });
    socket.on('error', reject);
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error('rawGet timeout'));
    });
  });
};

describe.skipIf(skipUnlessBuilt)('SEC-4: static asset path traversal is blocked', () => {
  let port = 0;
  let roomPath = '';
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(distPreview).href)) as PreviewModule;
    const handle = await mod.startPreviewServer(47621, '127.0.0.1');
    const roomUrl = new URL(handle.url);
    port = Number(roomUrl.port);
    roomPath = roomUrl.pathname;
    stop = () => handle.close();
  }, 30_000);

  afterAll(async () => {
    if (stop) {
      await stop();
    }
  });

  it('serves the index page only through the authenticated room route', async () => {
    const r = await rawGet(port, roomPath);
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/<html/i);
    expect((await rawGet(port, '/')).status).toBe(404);
  });

  const asset = findStaticAsset();
  it.skipIf(!asset)(`serves an in-tree asset (${asset ?? '<none>'})`, async () => {
    const r = await rawGet(port, `${roomPath}${asset!.replace(/^\/+/, '')}`);
    expect(r.status).toBe(200);
  });

  it('rejects literal `..` segments leading out of public/', async () => {
    const r = await rawGet(port, `${roomPath}../package.json`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toMatch(/"name"\s*:\s*"@zhicwan\/manifold3d-mcp"/);
  });

  it('rejects URL-encoded `%2e%2e` traversal', async () => {
    const r = await rawGet(port, `${roomPath}%2e%2e/package.json`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toMatch(/"name"\s*:\s*"@zhicwan\/manifold3d-mcp"/);
  });

  it('rejects mixed encoding `..%2fpackage.json`', async () => {
    const r = await rawGet(port, `${roomPath}..%2fpackage.json`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toMatch(/"name"\s*:\s*"@zhicwan\/manifold3d-mcp"/);
  });

  it('rejects double-encoded `%252e%252e/package.json`', async () => {
    const r = await rawGet(port, `${roomPath}%252e%252e/package.json`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toMatch(/"name"\s*:\s*"@zhicwan\/manifold3d-mcp"/);
  });

  it('rejects URLs that contain *any* percent-encoding', async () => {
    // The current policy is "if it contains %, reject" — defence in depth
    // against decoder-bypass tricks. Even a benign "%41" (A) should 4xx.
    const r = await rawGet(port, `${roomPath}%41`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
