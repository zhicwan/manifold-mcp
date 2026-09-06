import type { CanvasOptions, JoinSessionConfig } from '@github/copilot-sdk/extension';
import type { WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import type {
  HostActionHandler,
  HostActionHandlerContext,
  ViewerHost,
  ViewerRoom,
} from '@manifold3d/viewer-host/viewer-host.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ANNOTATION_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_ANNOTATIONS,
  parseAnnotationAttachment,
} from '../src/annotation-attachment.js';
import {
  ATTACH_ANNOTATION_BATCH_ACTION_ID,
  ATTACH_LOCATION_SELECTION_ACTION_ID,
  FIX_ANNOTATION_BATCH_ACTION_ID,
  FIX_ANNOTATION_BATCH_PROMPT,
  MANIFOLD_CANVAS_ID,
  startCopilotExtension,
  type CopilotExtensionApplication,
} from '../src/composition.js';
import type { CopilotExtensionSession, CopilotSdkBoundary } from '../src/sdk-boundary.js';

const dependencies = vi.hoisted(() => {
  const actions = new Map<string, HostActionHandler>();
  const room: ViewerRoom = {
    url: 'http://127.0.0.1:1234/room',
    pushModel: vi.fn(),
    getAnnotations: vi.fn(),
    registerAction: (descriptor, handler) => {
      actions.set(descriptor.id, handler);
      return () => {
        actions.delete(descriptor.id);
      };
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  const host: ViewerHost = {
    origin: 'http://127.0.0.1:1234',
    createRoom: () => room,
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { actions, room, host, disposeModel: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@manifold3d/viewer-host/viewer-host.js', () => ({
  startViewerHost: () => Promise.resolve(dependencies.host),
  createInMemoryViewerAssetProvider: vi.fn(),
}));
vi.mock('@manifold3d/modeling/modeling.js', () => ({
  ModelingEngine: class {},
  ModelingSession: class {
    getCurrentModel() {
      return undefined;
    }

    dispose = dependencies.disposeModel;
  },
}));
vi.mock('@manifold3d/modeling/runner/host.js', () => ({ Runner: class {} }));
vi.mock('@manifold3d/modeling/runner/model-artifact.js', () => ({ toViewerModelFrame: vi.fn() }));
vi.mock('../src/tools.js', () => ({ createExtensionTools: () => [] }));

describe('Fix and Attach delivery (source composition)', () => {
  let application: CopilotExtensionApplication | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.actions.clear();
  });

  afterEach(async () => {
    await application?.shutdown();
    application = undefined;
    vi.useRealTimers();
  });

  it('sends an immutable complete v2 snapshot directly and succeeds only when the SDK accepts it', async () => {
    const harness = createHarness();
    const enqueue = deferred<string>();
    harness.send.mockReturnValueOnce(enqueue.promise);
    application = await harness.start();
    await harness.canvas().open(canvasContext());
    const annotations = batchAnnotations();
    const context = actionContext(FIX_ANNOTATION_BATCH_ACTION_ID, annotations);
    const action = actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID)(context);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.sendAttachments).not.toHaveBeenCalled();
    expect(context.publish.running).toHaveBeenCalledOnce();
    expect(context.publish.succeeded).not.toHaveBeenCalled();
    expect(await action).toEqual({
      status: 'accepted',
      operationId: context.requestId,
      message: 'Sending annotation fix to Copilot.',
    });
    const sent = harness.send.mock.calls[0]?.[0];
    if (!sent) {
      throw new Error('Expected a programmatic message.');
    }
    expect(sent).toEqual({
      mode: 'enqueue',
      displayPrompt: 'Fix 3 Manifold annotations · batch-1',
      prompt: expect.stringContaining(FIX_ANNOTATION_BATCH_PROMPT),
    });
    const serialized = sent.prompt.slice(`${FIX_ANNOTATION_BATCH_PROMPT}\n\n`.length);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_ANNOTATION_ATTACHMENT_BYTES);
    expect(parseAnnotationAttachment(JSON.parse(serialized))).toEqual({
      version: 2,
      source: 'manifold3d-viewer',
      mode: 'annotation-batch',
      batchId: 'batch-1',
      modelVersion: 'model-7',
      annotationRevision: 9,
      annotations: [
        {
          id: 'point',
          partLabel: 'body#1',
          note: 'raise this point',
          selection: { kind: 'point', worldCoord: [1, 2, 3] },
        },
        {
          id: 'region',
          partLabel: 'body#1',
          note: 'round the region',
          selection: { kind: 'region', worldCoord: [4, 5, 6], triangleCount: 12 },
        },
        {
          id: 'sketch',
          partLabel: 'body#1',
          note: 'follow this curve',
          selection: {
            kind: 'sketch',
            worldCoord: [7, 8, 9],
            viewPlane: 'front',
            planeOrigin: [0, 0, 0],
            strokes: [
              [
                [0, 0],
                [1, 1],
              ],
            ],
          },
        },
      ],
    });
    expect(serialized).not.toContain('clientId');
    annotations[0]!.note = 'edited after clicking Fix';
    annotations[0]!.worldCoord[0] = 100;
    expect(sent.prompt).not.toContain('edited after clicking Fix');
    expect(sent.prompt).toContain('"worldCoord":[1,2,3]');

    enqueue.resolve('queued-message');
    await enqueue.promise;
    expect(context.publish.succeeded).toHaveBeenCalledWith('Annotation fix was accepted by Copilot for enqueueing.');
    expect(context.publish.failed).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('only attaches static context pills for Attach and location selection', async () => {
    const harness = createHarness();
    application = await harness.start();
    await harness.canvas().open(canvasContext());
    const batch = actionContext(ATTACH_ANNOTATION_BATCH_ACTION_ID);
    await expect(actionHandler(ATTACH_ANNOTATION_BATCH_ACTION_ID)(batch)).resolves.toMatchObject({
      status: 'succeeded',
    });
    const location = actionContext(ATTACH_LOCATION_SELECTION_ACTION_ID, [{ ...batchAnnotations()[0]!, note: '' }]);
    await expect(actionHandler(ATTACH_LOCATION_SELECTION_ACTION_ID)(location)).resolves.toMatchObject({
      status: 'succeeded',
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendAttachments).toHaveBeenCalledTimes(2);
    expect(harness.sendAttachments.mock.calls[0]?.[0]).toMatchObject({
      instanceId: 'canvas-1',
      attachments: [{ type: 'extension_context', payload: { mode: 'annotation-batch', batchId: 'batch-1' } }],
    });
    expect(harness.sendAttachments.mock.calls[1]?.[0]).toMatchObject({
      attachments: [
        {
          type: 'extension_context',
          payload: { mode: 'location-selection', annotations: [{ selection: { kind: 'point' } }] },
        },
      ],
    });
    const attachment = harness.sendAttachments.mock.calls[1]?.[0].attachments[0];
    if (attachment?.type !== 'extension_context') {
      throw new Error('Expected a location context attachment.');
    }
    expect(attachment.payload).not.toHaveProperty('batchId');
    expect(attachment.payload).not.toHaveProperty('annotations.0.note');
  });

  it.each(['rejection', 'synchronous throw'] as const)(
    'reports SDK %s and allows a new manual batch request without adding any pill',
    async failure => {
      const harness = createHarness();
      harness.send.mockImplementationOnce(() => {
        if (failure === 'synchronous throw') {
          throw new Error('SDK unavailable');
        }
        return Promise.reject(new Error('SDK unavailable'));
      });
      harness.log.mockRejectedValue(new Error('logging unavailable'));
      application = await harness.start();
      await harness.canvas().open(canvasContext());
      const failed = actionContext(FIX_ANNOTATION_BATCH_ACTION_ID);
      await actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID)(failed);
      expect(failed.publish.failed).toHaveBeenCalledWith('Could not send annotation fix: SDK unavailable');
      expect(failed.publish.succeeded).not.toHaveBeenCalled();

      const retry = actionContext(FIX_ANNOTATION_BATCH_ACTION_ID);
      retry.requestId = 'manual-retry';
      retry.input = { batchId: 'retry-batch' };
      await actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID)(retry);
      expect(retry.publish.succeeded).toHaveBeenCalledOnce();
      expect(retry.publish.failed).not.toHaveBeenCalled();
      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(harness.send.mock.calls[1]?.[0].prompt).toContain('"batchId":"retry-batch"');
      expect(harness.sendAttachments).not.toHaveBeenCalled();
      expect(harness.log).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { count: MAX_ATTACHMENT_ANNOTATIONS + 1, note: 'note', error: /between/ },
    { count: 40, note: 'n'.repeat(4096), error: /exceeds/ },
  ])('rejects out-of-bounds snapshots before send ($count annotations)', async ({ count, note, error }) => {
    const harness = createHarness();
    application = await harness.start();
    await harness.canvas().open(canvasContext());
    const annotations = Array.from({ length: count }, (_, index) => ({
      ...batchAnnotations()[0]!,
      id: `point-${index}`,
      note,
    }));
    expect(() =>
      actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID)(actionContext(FIX_ANNOTATION_BATCH_ACTION_ID, annotations)),
    ).toThrow(error);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendAttachments).not.toHaveBeenCalled();
  });

  it('rejects a closed room handler even after the same canvas instance is reopened', async () => {
    const harness = createHarness();
    application = await harness.start();
    await harness.canvas().open(canvasContext());
    const oldHandler = actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID);
    await harness.canvas().onClose?.(canvasContext());
    expect(() => oldHandler(actionContext(FIX_ANNOTATION_BATCH_ACTION_ID))).toThrow(
      'Canvas room is no longer available.',
    );
    await harness.canvas().open(canvasContext());
    expect(() => oldHandler(actionContext(FIX_ANNOTATION_BATCH_ACTION_ID))).toThrow(
      'Canvas room is no longer available.',
    );
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendAttachments).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores a late send %s after its room closes and reopens', async outcome => {
    const harness = createHarness();
    const enqueue = deferred<string>();
    harness.send.mockReturnValueOnce(enqueue.promise);
    application = await harness.start();
    await harness.canvas().open(canvasContext());
    const context = actionContext(FIX_ANNOTATION_BATCH_ACTION_ID);
    await actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID)(context);
    await harness.canvas().onClose?.(canvasContext());
    await harness.canvas().open(canvasContext());
    if (outcome === 'resolve') {
      enqueue.resolve('late-message');
    } else {
      enqueue.reject(new Error('late failure'));
    }
    await enqueue.promise.catch(() => undefined);
    expect(context.publish.failed).not.toHaveBeenCalled();
    expect(context.publish.succeeded).not.toHaveBeenCalled();
    expect(harness.log).not.toHaveBeenCalled();
    expect(harness.sendAttachments).not.toHaveBeenCalled();
  });

  it('checks that the session is bound before sending', async () => {
    const joining = deferred<CopilotExtensionSession>();
    const harness = createHarness(joining.promise);
    const starting = harness.start();
    await Promise.resolve();
    await harness.canvas().open(canvasContext());
    try {
      expect(() =>
        actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID)(actionContext(FIX_ANNOTATION_BATCH_ACTION_ID)),
      ).toThrow('Copilot session is not ready.');
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.sendAttachments).not.toHaveBeenCalled();
    } finally {
      joining.resolve(harness.session);
      application = await starting;
    }
  });

  it('bounds pending sends and disconnect, refuses new sends, and ignores late failure after shutdown', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const enqueue = deferred<string>();
    const disconnect = deferred<void>();
    harness.send.mockReturnValueOnce(enqueue.promise);
    harness.disconnect.mockReturnValueOnce(disconnect.promise);
    application = await harness.start();
    await harness.canvas().open(canvasContext());
    const handler = actionHandler(FIX_ANNOTATION_BATCH_ACTION_ID);
    const context = actionContext(FIX_ANNOTATION_BATCH_ACTION_ID);
    await handler(context);
    const shutdown = application.shutdown({ disconnectSession: true });
    expect(application.shutdown()).toBe(shutdown);
    expect(() => handler(actionContext(FIX_ANNOTATION_BATCH_ACTION_ID))).toThrow('Canvas room is no longer available.');
    await vi.advanceTimersByTimeAsync(30);
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(dependencies.disposeModel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    await shutdown;
    expect(dependencies.disposeModel).toHaveBeenCalledOnce();
    expect(dependencies.host.close).toHaveBeenCalledOnce();
    expect(dependencies.room.close).toHaveBeenCalledOnce();

    enqueue.reject(new Error('late send failure'));
    disconnect.reject(new Error('late disconnect failure'));
    await Promise.allSettled([enqueue.promise, disconnect.promise]);
    expect(context.publish.failed).not.toHaveBeenCalled();
    expect(context.publish.succeeded).not.toHaveBeenCalled();
    expect(harness.log).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.sendAttachments).not.toHaveBeenCalled();
  });
});

function createHarness(joining?: Promise<CopilotExtensionSession>) {
  const send = vi.fn<CopilotExtensionSession['send']>().mockResolvedValue('queued-message');
  const sendAttachments = vi
    .fn<CopilotExtensionSession['rpc']['extensions']['sendAttachmentsToMessage']>()
    .mockResolvedValue(undefined);
  const log = vi.fn<CopilotExtensionSession['log']>().mockResolvedValue(undefined);
  const disconnect = vi.fn<CopilotExtensionSession['disconnect']>().mockResolvedValue(undefined);
  const session: CopilotExtensionSession = {
    workspacePath: undefined,
    send,
    log,
    disconnect,
    rpc: { extensions: { sendAttachmentsToMessage: sendAttachments } },
  };
  let canvas: CanvasOptions | undefined;
  const sdk: CopilotSdkBoundary = {
    createCanvas(options) {
      canvas = options;
      return {
        declaration: { id: options.id, displayName: options.displayName, description: options.description },
        open: options.open,
        onClose: options.onClose,
      };
    },
    joinSession: (_config: JoinSessionConfig) => joining ?? Promise.resolve(session),
  };
  return {
    session,
    send,
    sendAttachments,
    log,
    disconnect,
    start: () =>
      startCopilotExtension({
        sdk,
        viewerAssets: new Map(),
        shutdownTimings: { fixSendDrainTimeoutMs: 30, disconnectTimeoutMs: 30 },
      }),
    canvas(): CanvasOptions {
      if (!canvas) {
        throw new Error('Canvas not registered.');
      }
      return canvas;
    },
  };
}

function actionHandler(id: string): HostActionHandler {
  const handler = dependencies.actions.get(id);
  if (!handler) {
    throw new Error(`Action ${id} not registered.`);
  }
  return handler;
}

function actionContext(actionId: string, annotations = batchAnnotations()): HostActionHandlerContext {
  return {
    requestId: 'request-1',
    actionId,
    modelVersion: 'model-7',
    annotationRevision: 9,
    annotationIds: annotations.map(annotation => annotation.id),
    annotations,
    input: { batchId: 'batch-1' },
    publish: { running: vi.fn(), failed: vi.fn(), succeeded: vi.fn() },
  };
}

function batchAnnotations(): WireAnnotation[] {
  const base = { modelVersion: 'model-7', partLabel: 'body#1', clientId: 'transport-only-client' };
  return [
    { ...base, id: 'point', kind: 'point', note: 'raise this point', worldCoord: [1, 2, 3] },
    { ...base, id: 'region', kind: 'region', note: 'round the region', worldCoord: [4, 5, 6], triCount: 12 },
    {
      ...base,
      id: 'sketch',
      kind: 'sketch',
      note: 'follow this curve',
      worldCoord: [7, 8, 9],
      viewPlane: 'front',
      planeOrigin: [0, 0, 0],
      strokes: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
  ];
}

function canvasContext() {
  return {
    sessionId: 'session-1',
    extensionId: 'project:manifold',
    canvasId: MANIFOLD_CANVAS_ID,
    instanceId: 'canvas-1',
    host: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
