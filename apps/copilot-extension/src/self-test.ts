import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { createAnnotationsMessage, type WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import { createHostActionInvocation, type HostActionDescriptor } from '@manifold3d/protocol/wire/host-actions.js';
import { ModelingEngine, ModelingSession } from '@manifold3d/modeling/modeling.js';
import { toViewerModelFrame } from '@manifold3d/modeling/runner/model-artifact.js';
import { Runner } from '@manifold3d/modeling/runner/host.js';
import {
  createInMemoryViewerAssetProvider,
  startViewerHost,
  type ViewerAssetManifest,
} from '@manifold3d/viewer-host/viewer-host.js';
import { WebSocket, type RawData } from 'ws';

import {
  embeddedManifoldWasmBytes,
  embeddedTypeScriptLibBytes,
  embeddedViewerAssetBytes,
  embeddedViewerAssetCount,
} from 'virtual:manifold-resources';

type EmbeddedAssets = ViewerAssetManifest;

export interface ExtensionSelfTestOptions {
  workerFilename: string | URL;
  wasmBinary: Uint8Array;
  typescriptLibDeclarations: string;
  viewerAssets: EmbeddedAssets;
  sdkImported(): boolean;
}

export async function runExtensionSelfTest(options: ExtensionSelfTestOptions): Promise<Record<string, unknown>> {
  assert(!options.sdkImported(), 'Self-test imported the host Copilot SDK.');
  assert(options.wasmBinary.byteLength === embeddedManifoldWasmBytes, 'Embedded WASM byte count is inconsistent.');
  assert(options.viewerAssets.size === embeddedViewerAssetCount, 'Embedded Viewer asset count is inconsistent.');
  const actualViewerBytes = [...options.viewerAssets.values()].reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
  assert(actualViewerBytes === embeddedViewerAssetBytes, 'Embedded Viewer asset byte count is inconsistent.');

  const modeling = new ModelingSession(
    new ModelingEngine(
      new Runner({
        workerFilename: options.workerFilename,
        workerData: {
          role: 'model-worker',
          wasmBinary: options.wasmBinary,
          typescriptLibDeclarations: options.typescriptLibDeclarations,
        },
      }),
    ),
  );
  const host = await startViewerHost({
    assetProvider: createInMemoryViewerAssetProvider(options.viewerAssets),
    preferredPort: 0,
    host: '127.0.0.1',
    allowAnyFrameAncestor: true,
    logger: {
      error: message => process.stderr.write(`${message}\n`),
      warn: message => process.stderr.write(`${message}\n`),
    },
  });
  const roomA = host.createRoom({ annotationGraceMs: 50 });
  const roomB = host.createRoom({ annotationGraceMs: 50 });
  let clientA: RoomClient | undefined;
  let clientB: RoomClient | undefined;
  let actionCallsA = 0;
  let actionCallsB = 0;
  try {
    roomA.registerAction(selfTestActionDescriptor(), context => {
      actionCallsA += 1;
      assert(
        context.annotations.length === 1 && context.annotations[0]?.note === 'room A',
        'Room A action snapshot leaked.',
      );
      return { status: 'succeeded', message: 'room A handled' };
    });
    roomB.registerAction(selfTestActionDescriptor(), context => {
      actionCallsB += 1;
      assert(
        context.annotations.length === 1 && context.annotations[0]?.note === 'room B',
        'Room B action snapshot leaked.',
      );
      return { status: 'succeeded', message: 'room B handled' };
    });

    const execution = await modeling.execute(
      {
        code: 'result = Manifold.cube([2, 3, 4], true);',
        description: 'Self-test cube',
      },
      {
        beforeCommit: model => {
          const frame = toViewerModelFrame(model.artifact);
          roomA.pushModel(frame);
          roomB.pushModel(frame);
        },
      },
    );
    assert(
      execution.report.ok && execution.model,
      `Self-test cube did not execute successfully: ${JSON.stringify(execution.report)}`,
    );
    assert(execution.report.stats?.triangles === 12, 'Self-test cube triangle count is wrong.');
    assert(execution.report.stats.vertices === 8, 'Self-test cube vertex count is wrong.');
    assert(execution.report.stats.volume === 24, 'Self-test cube volume is wrong.');
    assert(execution.report.stats.surfaceArea === 52, 'Self-test cube surface area is wrong.');

    const failed = await modeling.validate({
      code: [
        'const value: { nested?: { size: number } } = {};',
        'const missing = value.nested as { size: number };',
        '// The error must map to line 4 without any external source-map resource.',
        'result = Manifold.cube(missing.size);',
      ].join('\n'),
    });
    assert(
      failed.report.errors.some(issue => issue.code === 'RUNTIME_ERROR' && issue.line === 4),
      'Single-file runtime error did not map to the original source line.',
    );

    const assets = await verifyAssets(roomA.url, options.viewerAssets);
    const indexResponse = await fetch(roomA.url);
    assert(
      indexResponse.headers.get('content-security-policy')?.includes('frame-ancestors *') === true,
      'Extension embedding policy was not applied.',
    );
    assert(indexResponse.headers.get('access-control-allow-origin') === null, 'Viewer Host unexpectedly enabled CORS.');

    clientA = await openRoom(roomA.url, host.origin);
    clientB = await openRoom(roomB.url, host.origin);
    const versionA = roomA.getAnnotations().modelVersion;
    const versionB = roomB.getAnnotations().modelVersion;
    assert(versionA !== versionB, 'Room model versions must be isolated.');
    clientA.socket.send(
      JSON.stringify(createAnnotationsMessage(versionA, 1, [pointAnnotation('a', versionA, 'room A')])),
    );
    clientB.socket.send(
      JSON.stringify(createAnnotationsMessage(versionB, 3, [pointAnnotation('b', versionB, 'room B')])),
    );
    await eventually(() => roomA.getAnnotations().items.length === 1 && roomB.getAnnotations().items.length === 1);

    const requestA = createHostActionInvocation({
      requestId: 'self-test-request',
      actionId: 'self-test-action',
      modelVersion: versionA,
      annotationRevision: 1,
    });
    clientA.socket.send(JSON.stringify(requestA));
    await clientA.messages.waitFor(
      message =>
        message.kind === 'host_action_status' &&
        message.requestId === requestA.requestId &&
        message.state === 'succeeded',
    );
    clientA.socket.send(JSON.stringify(requestA));
    await eventually(
      () =>
        clientA!.messages.items.filter(
          message =>
            message.kind === 'host_action_status' &&
            message.requestId === requestA.requestId &&
            message.state === 'succeeded',
        ).length >= 2,
    );

    const requestB = createHostActionInvocation({
      requestId: 'self-test-request',
      actionId: 'self-test-action',
      modelVersion: versionB,
      annotationRevision: 3,
    });
    clientB.socket.send(JSON.stringify(requestB));
    await clientB.messages.waitFor(
      message =>
        message.kind === 'host_action_status' &&
        message.requestId === requestB.requestId &&
        message.state === 'succeeded',
    );
    assert(actionCallsA === 1, 'Room A request was not idempotent.');
    assert(actionCallsB === 1, 'Room B request did not execute exactly once.');
    assert(roomA.getAnnotations().items[0]?.note === 'room A', 'Room A annotations changed unexpectedly.');
    assert(roomB.getAnnotations().items[0]?.note === 'room B', 'Room B annotations changed unexpectedly.');

    await closeSocket(clientA.socket);
    clientA = undefined;
    await roomA.close();
    assert((await fetch(roomA.url)).status === 404, 'Closed room credential remained valid.');
    assert((await fetch(roomB.url)).status === 200, 'Closing room A affected room B.');

    return {
      verified: true,
      sdkImported: options.sdkImported(),
      singleFileWorker: true,
      embedded: {
        viewerAssetCount: embeddedViewerAssetCount,
        viewerAssetBytes: embeddedViewerAssetBytes,
        wasmCount: 1,
        wasmBytes: embeddedManifoldWasmBytes,
        typeScriptLibBytes: embeddedTypeScriptLibBytes,
      },
      assets,
      model: {
        revision: execution.model.revision,
        triangles: execution.report.stats.triangles,
        vertices: execution.report.stats.vertices,
        volume: execution.report.stats.volume,
        surfaceArea: execution.report.stats.surfaceArea,
      },
      rooms: {
        count: 2,
        isolated: true,
        actionCalls: [actionCallsA, actionCallsB],
        idempotent: true,
      },
    };
  } finally {
    clientA?.socket.terminate();
    clientB?.socket.terminate();
    await cleanupSelfTest([roomA.close(), roomB.close(), host.close(), modeling.dispose()]);
  }
}

async function cleanupSelfTest(operations: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(operations);
  const errors = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Extension self-test cleanup failed.');
  }
}

function selfTestActionDescriptor(): HostActionDescriptor {
  return {
    id: 'self-test-action',
    label: 'Self-test action',
    icon: 'check',
    slot: 'annotation-footer',
    tone: 'default',
    requires: ['model', 'annotations'],
  };
}

async function verifyAssets(
  roomUrl: string,
  assets: EmbeddedAssets,
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const results: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [path, asset] of assets) {
    const response = await fetch(new URL(path, roomUrl));
    assert(response.status === 200, `Embedded Viewer asset ${path} returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.equals(Buffer.from(asset.bytes)), `Embedded Viewer asset ${path} changed while being served.`);
    results.push({
      path,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return results;
}

interface RoomClient {
  socket: WebSocket;
  messages: MessageCollector;
}

class MessageCollector {
  readonly items: Array<Record<string, unknown>> = [];
  private readonly waiters = new Set<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  push(message: Record<string, unknown>): void {
    this.items.push(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const existing = this.items.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Timed out waiting for Viewer Host message.'));
        }, 10_000),
      };
      this.waiters.add(waiter);
    });
  }
}

async function openRoom(roomUrl: string, origin: string): Promise<RoomClient> {
  const messages = new MessageCollector();
  const socket = new WebSocket(`${roomUrl.replace(/^http/, 'ws')}ws`, { origin });
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      return;
    }
    const parsed: unknown = JSON.parse(rawDataToString(data));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      messages.push(parsed as Record<string, unknown>);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await messages.waitFor(message => message.kind === 'hello');
  await messages.waitFor(message => message.kind === 'host_actions_manifest');
  await messages.waitFor(message => message.kind === 'mesh');
  return { socket, messages };
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

function pointAnnotation(id: string, modelVersion: string, note: string): WireAnnotation {
  return {
    id,
    modelVersion,
    kind: 'point',
    partLabel: `point#${id}`,
    note,
    worldCoord: [1, 2, 3],
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for self-test state.');
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
