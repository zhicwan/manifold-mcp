import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import {
  VIEWER_PROTOCOL_VERSION,
  decodeViewerModel,
  parseModelHeader,
  type ModelHeader,
  type ViewerModelFrame,
} from '../packages/protocol/src/wire/model.js';
import type * as PreviewModuleNs from '../apps/manifold3d-mcp/src/server/preview/preview-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distPreview = join(repoRoot, 'apps', 'manifold3d-mcp', 'build', 'server', 'preview', 'preview-server.js');
const distPublic = join(repoRoot, 'apps', 'manifold3d-mcp', 'build', 'viewer', 'index.html');

const skipUnlessBuilt = !existsSync(distPreview) || !existsSync(distPublic);

// Exercise the built application adapter with an explicit asset provider root.
type PreviewModule = typeof PreviewModuleNs;
let previewModule: PreviewModule;
let handle: PreviewModule extends { startPreviewServer: (...args: never[]) => Promise<infer H> } ? H : never;

function syntheticModel(): ViewerModelFrame {
  return {
    description: 'preview transport test',
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

describe.skipIf(skipUnlessBuilt)('preview server', () => {
  beforeAll(async () => {
    previewModule = (await import(pathToFileURL(distPreview).href)) as PreviewModule;
    handle = await previewModule.startPreviewServer({ preferredPort: 47371, assetRoot: dirname(distPublic) });
  }, 15_000);

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  it('serves index.html at /', async () => {
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<!doctype html>/i);
  });

  it('serves index.html at /index.html', async () => {
    const res = await fetch(`${handle.url}index.html`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for missing files', async () => {
    const res = await fetch(`${handle.url}missing-file.js`);
    expect(res.status).toBe(404);
  });

  it('sends a versioned header and binary frames that decode as the pushed model', async () => {
    const localHandle = await previewModule.startPreviewServer({
      preferredPort: 47771,
      assetRoot: dirname(distPublic),
      additionalOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
    });
    const wsUrl = `${localHandle.url.replace(/^http/, 'ws')}ws`;
    const origin = new URL(localHandle.url).origin;
    const host = new URL(localHandle.url).host;
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Host: host } });
    const frame = syntheticModel();

    try {
      const decoded = new Promise<{ header: ModelHeader; model: ReturnType<typeof decodeViewerModel> }>(
        (resolve, reject) => {
          let header: ModelHeader | undefined;
          const buffers: ArrayBuffer[] = [];
          ws.on('message', (raw, isBinary) => {
            try {
              if (!isBinary) {
                const parsed = JSON.parse(raw.toString()) as { kind?: unknown };
                if (parsed.kind === 'mesh') {
                  header = parseModelHeader(parsed);
                }
                return;
              }
              if (!header) {
                return;
              }
              buffers.push(Uint8Array.from(raw as Buffer).buffer);
              if (buffers.length === 3) {
                resolve({
                  header,
                  model: decodeViewerModel(header, {
                    vertProperties: buffers[0]!,
                    triVerts: buffers[1]!,
                    triFeatureIds: buffers[2]!,
                  }),
                });
              }
            } catch (error) {
              reject(error);
            }
          });
          ws.once('error', reject);
        },
      );

      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      localHandle.pushModel(frame);

      const { header, model } = await decoded;
      expect(model.description).toBe(frame.description);
      expect(model.triangles).toBe(frame.triangles);
      expect([...model.triVerts]).toEqual([0, 1, 2]);
      expect(header.protocolVersion).toBe(VIEWER_PROTOCOL_VERSION);
    } finally {
      ws.terminate();
      await localHandle.close();
    }
  });

  it('ignores annotation messages tagged with a stale model version', async () => {
    const wsUrl = `${handle.url.replace(/^http/, 'ws')}ws`;
    const origin = new URL(handle.url).origin;
    const host = new URL(handle.url).host;
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Host: host } });

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      // Send an annotations payload with a model version the server has
      // never seen (the server starts with modelVersion = 'none' and only
      // changes after push()). Model-version filter is at preview-server.ts:103.
      ws.send(
        JSON.stringify({
          kind: 'annotations',
          protocolVersion: 1,
          revision: 1,
          modelVersion: 'v-stale-12345',
          items: [
            {
              id: 'a1',
              modelVersion: 'v-stale-12345',
              kind: 'point',
              partLabel: 'point#1',
              note: 'should be dropped',
              worldCoord: [0, 0, 0],
            },
          ],
        }),
      );

      // Give the server a moment to process the (rejected) message.
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      const snap = handle.getAnnotations();
      expect(snap.modelVersion).toBe('none');
      expect(snap.items).toEqual([]);
    } finally {
      await new Promise<void>(resolve => {
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
  });
});
