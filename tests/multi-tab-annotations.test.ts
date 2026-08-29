/**
 * VIE-2: multi-tab annotation merge.
 *
 * Two viewer tabs (simulated as two WS connections) each push their own
 * annotation payload tagged with the SAME modelVersion. The server's
 * `getAnnotations()` must return the union of both clients' items, not
 * just the most recent one (the pre-VIE-2 behavior).
 *
 * Then we close one of the tabs and assert that after the eviction
 * grace window expires, only the surviving tab's items remain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { createAnnotationsMessage } from '../packages/protocol/src/wire/annotations.js';
import type { ViewerModelFrame } from '../packages/protocol/src/wire/model.js';

import type * as PreviewModuleNs from '../packages/viewer-host/src/preview/preview-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distPreview = join(repoRoot, 'packages', 'viewer-host', 'dist', 'preview', 'preview-server.js');
const distPublic = join(repoRoot, 'packages', 'viewer-host', 'dist', 'public', 'index.html');
const skipUnlessBuilt = !existsSync(distPreview) || !existsSync(distPublic);

type PreviewModule = typeof PreviewModuleNs;
let previewModule: PreviewModule;
let handle: PreviewModule extends { startPreviewServer: (...args: never[]) => Promise<infer H> } ? H : never;

interface MeshHeader {
  kind: 'mesh' | 'model_version' | 'hello';
  modelVersion?: string;
  clientId?: string;
}

function openTabAndAwaitVersion(url: string): Promise<{ ws: WebSocket; modelVersion: string; clientId?: string }> {
  const wsUrl = `${url.replace(/^http/, 'ws')}ws`;
  const origin = new URL(url).origin;
  const host = new URL(url).host;
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Host: host } });
  let resolvedModelVersion: string | undefined;
  let resolvedClientId: string | undefined;
  return new Promise((resolve, reject) => {
    const tryResolve = (): void => {
      if (resolvedModelVersion !== undefined) {
        resolve({
          ws,
          modelVersion: resolvedModelVersion,
          ...(resolvedClientId !== undefined ? { clientId: resolvedClientId } : {}),
        });
      }
    };
    // Attach the message handler synchronously, BEFORE awaiting open, so
    // we don't miss the hello / model_version frames that the server
    // emits as part of the connection handshake.
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        return;
      }
      let msg: MeshHeader;
      try {
        msg = JSON.parse(raw.toString()) as MeshHeader;
      } catch {
        return;
      }
      if (msg.kind === 'hello' && typeof msg.clientId === 'string') {
        resolvedClientId = msg.clientId;
      }
      if (msg.kind === 'model_version' && typeof msg.modelVersion === 'string') {
        resolvedModelVersion = msg.modelVersion;
      }
      tryResolve();
    });
    ws.once('error', reject);
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  await new Promise<void>(resolve => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      resolve();
    }, 500);
  });
}

function syntheticModel(): ViewerModelFrame {
  // Bare-minimum well-formed payload so the server will accept push() and
  // emit a fresh modelVersion. Geometry doesn't need to be physically
  // meaningful — the server just shuttles bytes to clients. The runner
  // protocol exposes the typed arrays as raw ArrayBuffers (transferable
  // between worker boundaries) so we hand back the .buffer slot directly.
  return {
    description: 'multi-tab test',
    numProp: 3,
    triangles: 1,
    vertices: 3,
    features: [
      {
        label: 'unknown#1',
        kind: 'unknown',
        params: {},
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      },
    ],
    vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
    triVerts: new Uint32Array([0, 1, 2]).buffer,
    triFeatureIds: new Uint32Array([0]).buffer,
    volume: 0,
    surfaceArea: 1,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [1, 1, 0],
  };
}

describe.skipIf(skipUnlessBuilt)('preview server: multi-tab annotation merge', () => {
  beforeAll(async () => {
    previewModule = (await import(pathToFileURL(distPreview).href)) as PreviewModule;
    handle = await previewModule.startPreviewServer(48171);
  }, 15_000);

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  it('returns the union of annotations from two simultaneously-open tabs', async () => {
    // Push a mesh first so modelVersion advances away from 'none' — the
    // server only accepts annotations matching the current modelVersion.
    handle.pushModel(syntheticModel());

    const a = await openTabAndAwaitVersion(handle.url);
    const b = await openTabAndAwaitVersion(handle.url);
    const tabA = a.ws;
    const tabB = b.ws;
    try {
      expect(a.modelVersion).toBe(b.modelVersion);

      tabA.send(
        JSON.stringify(
          createAnnotationsMessage(a.modelVersion, 1, [
            {
              id: 'A-1',
              modelVersion: a.modelVersion,
              kind: 'point',
              partLabel: 'cube#1',
              note: 'note from tab A',
              worldCoord: [1, 0, 0],
            },
          ]),
        ),
      );
      tabB.send(
        JSON.stringify(
          createAnnotationsMessage(b.modelVersion, 1, [
            {
              id: 'B-1',
              modelVersion: b.modelVersion,
              kind: 'point',
              partLabel: 'cube#1',
              note: 'note from tab B',
              worldCoord: [0, 1, 0],
            },
            {
              id: 'B-2',
              modelVersion: b.modelVersion,
              kind: 'region',
              partLabel: 'cube#1',
              note: 'a region from B',
              worldCoord: [0, 0, 1],
              triCount: 1,
            },
          ]),
        ),
      );

      // Give the server a moment to process both messages.
      await new Promise<void>(resolve => setTimeout(resolve, 100));

      const snap = handle.getAnnotations();
      expect(snap.modelVersion).toBe(a.modelVersion);
      const ids = snap.items.map(i => i.id).sort();
      expect(ids).toEqual(['A-1', 'B-1', 'B-2']);
      // Every server-cached annotation should carry the originating clientId.
      for (const item of snap.items) {
        expect(typeof item.clientId).toBe('string');
        expect(item.clientId).toBeTruthy();
      }
      // The two tabs must have distinct clientIds.
      const distinctClientIds = new Set(snap.items.map(i => i.clientId));
      expect(distinctClientIds.size).toBe(2);
    } finally {
      await closeWs(tabA);
      await closeWs(tabB);
    }
  }, 15_000);

  it("clears all clients' annotations when a new model is pushed", async () => {
    handle.pushModel(syntheticModel());

    const a = await openTabAndAwaitVersion(handle.url);
    const tabA = a.ws;
    try {
      tabA.send(
        JSON.stringify(
          createAnnotationsMessage(a.modelVersion, 1, [
            {
              id: 'X',
              modelVersion: a.modelVersion,
              kind: 'point',
              partLabel: 'cube#1',
              note: 'before push',
              worldCoord: [0, 0, 0],
            },
          ]),
        ),
      );
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      expect(handle.getAnnotations().items.length).toBe(1);

      // New model push -> bumps modelVersion and clears every client's bucket.
      handle.pushModel(syntheticModel());
      // Wait for the server-side state mutation to be observable. The push
      // is synchronous so we don't strictly need to wait, but a tick lets
      // any in-flight WS frames settle.
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      const after = handle.getAnnotations();
      expect(after.items).toEqual([]);
      expect(after.modelVersion).not.toBe(a.modelVersion);
    } finally {
      await closeWs(tabA);
    }
  }, 15_000);
});
