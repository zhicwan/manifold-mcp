/** VIE-4: Cache-Control header policy for the static preview assets. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as PreviewModuleNs from '../packages/viewer-host/src/preview/preview-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distPreview = join(repoRoot, 'packages', 'viewer-host', 'dist', 'preview', 'preview-server.js');
const distPublic = join(repoRoot, 'packages', 'viewer-host', 'dist', 'public', 'index.html');
const distAssets = join(repoRoot, 'packages', 'viewer-host', 'dist', 'public', 'assets');
const skipUnlessBuilt = !existsSync(distPreview) || !existsSync(distPublic);

type PreviewModule = typeof PreviewModuleNs;
let previewModule: PreviewModule;
let handle: PreviewModule extends { startPreviewServer: (...args: never[]) => Promise<infer H> } ? H : never;

describe.skipIf(skipUnlessBuilt)('preview server: cache-control matrix', () => {
  beforeAll(async () => {
    previewModule = (await import(pathToFileURL(distPreview).href)) as PreviewModule;
    handle = await previewModule.startPreviewServer(47571);
  }, 15_000);

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  it('returns Cache-Control: no-store for /index.html', async () => {
    const res = await fetch(`${handle.url}index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns Cache-Control: no-store for the bare / root', async () => {
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns immutable+max-age=1y for hashed assets', async () => {
    if (!existsSync(distAssets)) {
      // Viewer not built with hashed assets — skip rather than fail. The
      // skipUnlessBuilt gate above already covers a missing viewer-host/dist/public.
      return;
    }
    const candidates = readdirSync(distAssets);
    const asset = candidates.find(f => f.endsWith('.js') || f.endsWith('.css'));
    expect(asset, 'expected at least one hashed asset under viewer-host/dist/public/assets/').toBeDefined();
    const res = await fetch(`${handle.url}assets/${asset!}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});
