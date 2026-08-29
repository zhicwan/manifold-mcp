import { Buffer } from 'node:buffer';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Canvas, CanvasOptions, JoinSessionConfig } from '@github/copilot-sdk/extension';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import {
  ModelingEngine,
  ModelingSession,
  type ModelArtifact,
  type PreviewRenderer,
  type RenderResult,
  type RenderViewOptions,
} from '@manifold3d/modeling/modeling.js';
import { Runner, type RunnerOptions } from '@manifold3d/modeling/runner/host.js';
import type { RunRequest, RunResult } from '@manifold3d/modeling/runner/protocol.js';
import { emptyReport } from '@manifold3d/modeling/validation/report.js';
import { createAnnotationsMessage, type WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import { MANIFOLD_CANVAS_ID, startCopilotExtension, type CopilotExtensionApplication } from '../src/composition.js';
import type { CopilotExtensionSession, CopilotSdkBoundary, ExtensionToolResult } from '../src/sdk-boundary.js';
import { installExtensionSignalHandlers, type ExtensionSignalRuntime } from '../src/signal-handlers.js';

const testWorkspace = resolve('apps/copilot-extension/.test-workspace');

describe('production Copilot Extension composition', () => {
  let application: CopilotExtensionApplication | undefined;

  beforeEach(async () => {
    await rm(testWorkspace, { force: true, recursive: true });
    await mkdir(testWorkspace, { recursive: true });
  });

  afterEach(async () => {
    await application?.shutdown();
    application = undefined;
    await rm(testWorkspace, { force: true, recursive: true });
  });

  it('reuses Canvas instances, isolates rooms, and resolves one live pill to the latest saved snapshot', async () => {
    const harness = createHarness();
    application = await startCopilotExtension(harness.startOptions);
    const canvas = harness.canvas();
    expect(canvas.id).toBe(MANIFOLD_CANVAS_ID);

    const firstOpen = await canvas.open(openContext('canvas-a'));
    const reopened = await canvas.open(openContext('canvas-a'));
    expect(reopened.url).toBe(firstOpen.url);
    expect(application.liveRoomCount).toBe(1);

    const clientA = await openRoom(requiredUrl(firstOpen.url));
    try {
      const execute = harness.tool('manifold_execute_script');
      const firstExecution = await execute.handler?.(
        { code: 'result = Manifold.cube(1);', description: 'first' },
        invocation('manifold_execute_script'),
      );
      expect(firstExecution).toMatchObject({ resultType: 'success' });
      const firstMeshA = await clientA.messages.waitFor(message => message.kind === 'mesh');
      expect(firstMeshA.description).toBe('first');
      expect(harness.modelingSession.getCurrentModel()?.revision).toBe(1);

      const secondOpen = await canvas.open(openContext('canvas-b'));
      expect(secondOpen.url).not.toBe(firstOpen.url);
      expect(application.liveRoomCount).toBe(2);
      const clientB = await openRoom(requiredUrl(secondOpen.url));
      try {
        expect(await clientB.messages.waitFor(message => message.kind === 'mesh')).toMatchObject({
          description: 'first',
        });

        const versionA = requiredString(
          (
            await clientA.messages.waitFor(
              message => message.kind === 'model_version' && message.modelVersion !== 'none',
            )
          ).modelVersion,
        );
        const versionB = requiredString(
          (await clientB.messages.waitFor(message => message.kind === 'model_version')).modelVersion,
        );
        expect(versionA).not.toBe(versionB);
        clientA.socket.send(
          JSON.stringify(createAnnotationsMessage(versionA, 1, [pointAnnotation('annotation-a', versionA, '')])),
        );
        clientA.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionA, 2, [
              pointAnnotation('annotation-a', versionA, 'room A first draft', 'client-transport-a'),
            ]),
          ),
        );
        await eventually(() => harness.sendAttachments.mock.calls.length === 1);
        expect(harness.sendAttachments).toHaveBeenCalledTimes(1);
        expect(harness.sendAttachments).toHaveBeenCalledWith({
          instanceId: 'canvas-a',
          attachments: [
            {
              type: 'extension_context',
              title: 'Manifold annotation · point#1',
              payload: {
                mode: 'live',
                liveToken: expect.any(String),
                snapshot: {
                  version: 1,
                  source: 'manifold3d-viewer',
                  modelVersion: versionA,
                  annotationRevision: 2,
                  annotations: [
                    {
                      id: 'annotation-a',
                      partLabel: 'point#1',
                      note: 'room A first draft',
                      selection: {
                        kind: 'point',
                        worldCoord: [1, 2, 3],
                      },
                    },
                  ],
                },
              },
            },
          ],
        });
        const token = harness.sendAttachments.mock.calls[0]?.[0].attachments[0]?.payload;
        if (!token || typeof token !== 'object' || Array.isArray(token) || typeof token.liveToken !== 'string') {
          throw new Error('Expected a live annotation token.');
        }

        clientA.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionA, 3, [
              pointAnnotation('annotation-a', versionA, 'room A first draft', 'client-transport-a'),
              pointAnnotation('annotation-a2', versionA, 'room A second note', 'client-transport-a'),
            ]),
          ),
        );
        await eventually(() => harness.sendAttachments.mock.calls.length === 2);
        const secondToken = harness.sendAttachments.mock.calls[1]?.[0].attachments[0]?.payload;
        if (
          !secondToken ||
          typeof secondToken !== 'object' ||
          Array.isArray(secondToken) ||
          typeof secondToken.liveToken !== 'string'
        ) {
          throw new Error('Expected a second live annotation token.');
        }

        clientA.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionA, 4, [
              pointAnnotation('annotation-a', versionA, 'room A final note', 'client-transport-a'),
              pointAnnotation('annotation-a2', versionA, 'room A second note', 'client-transport-a'),
            ]),
          ),
        );
        const transformedPrompt = [
          `<extension_context>${JSON.stringify(token)}</extension_context>`,
          `<extension_context>${JSON.stringify(secondToken)}</extension_context>`,
        ].join('\n');
        const transformed = await harness.transformPrompt(transformedPrompt);
        expect(harness.sendAttachments).toHaveBeenCalledTimes(2);
        expect(transformed?.modifiedTransformedPrompt).toContain('room A final note');
        expect(transformed?.modifiedTransformedPrompt).toContain('room A second note');
        expect(transformed?.modifiedTransformedPrompt).toContain('"annotationRevision":4');
        expect(transformed?.modifiedTransformedPrompt).not.toContain('room A first draft');

        clientA.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionA, 5, [
              pointAnnotation('annotation-a', versionA, 'delete before send', 'client-transport-a'),
              pointAnnotation('annotation-a2', versionA, 'room A second note', 'client-transport-a'),
            ]),
          ),
        );
        await eventually(() => harness.sendAttachments.mock.calls.length === 3);
        const deletedToken = harness.sendAttachments.mock.calls[2]?.[0].attachments[0]?.payload;
        clientA.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionA, 6, [
              pointAnnotation('annotation-a2', versionA, 'room A second note', 'client-transport-a'),
            ]),
          ),
        );
        const afterDeletion = await harness.transformPrompt(
          `<extension_context>${JSON.stringify(deletedToken)}</extension_context>`,
        );
        expect(afterDeletion?.modifiedTransformedPrompt).not.toContain('delete before send');
        expect(afterDeletion?.modifiedTransformedPrompt).not.toContain('<extension_context>');

        clientB.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionB, 4, [
              pointAnnotation('annotation-b', versionB, 'room B note', 'client-transport-b'),
            ]),
          ),
        );
        await eventually(() => harness.sendAttachments.mock.calls.length === 4);
        const withoutLivePill = await harness.transformPrompt('ordinary user prompt');
        expect(withoutLivePill).toBeUndefined();

        await canvas.onClose?.(closeContext('canvas-a'));
        expect(application.liveRoomCount).toBe(1);
        expect((await fetch(requiredUrl(firstOpen.url))).status).toBe(404);
        expect((await fetch(requiredUrl(secondOpen.url))).status).toBe(200);

        const secondExecution = await execute.handler?.(
          { code: 'result = Manifold.cube(2);', description: 'second' },
          invocation('manifold_execute_script'),
        );
        expect(secondExecution).toMatchObject({ resultType: 'success' });
        await clientB.messages.waitFor(message => message.kind === 'mesh' && message.description === 'second');
        expect(harness.modelingSession.getCurrentModel()?.revision).toBe(2);
      } finally {
        clientB.socket.terminate();
      }
    } finally {
      clientA.socket.terminate();
    }
  });

  it('validates tool arguments, writes captures under the session workspace, and shuts down once', async () => {
    const harness = createHarness();
    application = await startCopilotExtension(harness.startOptions);
    const canvas = harness.canvas();
    const opened = await canvas.open(openContext('canvas-tools'));

    const invalid = (await harness
      .tool('manifold_validate_script')
      .handler?.({ code: '', unexpected: true }, invocation('manifold_validate_script'))) as ExtensionToolResult;
    expect(invalid).toMatchObject({ resultType: 'failure', error: expect.stringMatching(/unsupported|non-empty/) });

    await harness
      .tool('manifold_execute_script')
      .handler?.({ code: 'result = Manifold.cube(1);' }, invocation('manifold_execute_script'));
    const capture = (await harness
      .tool('manifold_capture_view')
      .handler?.(
        { view: 'front', width: 128, height: 128 },
        invocation('manifold_capture_view'),
      )) as ExtensionToolResult;
    expect(capture.resultType).toBe('success');
    const captureBody = JSON.parse(capture.textResultForLlm);
    expect(captureBody.filePath).toMatch(/^.*apps\/copilot-extension\/\.test-workspace\/files\/manifold3d-captures\//);
    expect(await readFile(captureBody.filePath, 'utf8')).toBe('png');

    const first = application.shutdown({ disconnectSession: true });
    const second = application.shutdown({ disconnectSession: true });
    expect(second).toBe(first);
    await first;
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.runner.disposeCalls).toBe(1);
    expect(harness.renderer.disposeCalls).toBe(1);
    expect(application.liveRoomCount).toBe(0);
    await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
    application = undefined;
  });

  it('closes resources on session.shutdown without disconnecting the already-ending SDK session', async () => {
    const harness = createHarness();
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-session-shutdown'));
    harness.emitSessionShutdown();
    harness.emitSessionShutdown();

    await eventually(
      () =>
        application!.liveRoomCount === 0 && harness.runner.disposeCalls === 1 && harness.renderer.disposeCalls === 1,
    );
    expect(harness.disconnect).not.toHaveBeenCalled();
    await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
    await application.shutdown();
    application = undefined;
  });

  it('observes session.shutdown before join resolves and never returns disposed resources', async () => {
    const join = deferred<CopilotExtensionSession>();
    const harness = createHarness({
      joinSession: () => join.promise,
      shutdownTimings: {
        disconnectTimeoutMs: 25,
        attachmentDrainTimeoutMs: 25,
      },
    });
    const starting = startCopilotExtension(harness.startOptions);
    await eventually(() => harness.joinConfigured());
    const opened = await harness.canvas().open(openContext('canvas-early-shutdown'));

    harness.emitSessionShutdown();
    await eventually(() => harness.runner.disposeCalls === 1 && harness.renderer.disposeCalls === 1);
    join.resolve(harness.session);

    await expect(starting).rejects.toThrow(/shut down while the Extension was joining/);
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
  });

  it('bounds explicit disconnect and pending attachment sends, then ignores late settlement', async () => {
    const pendingAttachment = deferred<void>();
    const pendingDisconnect = deferred<void>();
    const sequence: string[] = [];
    const harness = createHarness({
      sendAttachments: () => {
        sequence.push('attachment');
        return pendingAttachment.promise;
      },
      disconnect: () => {
        sequence.push('disconnect');
        return pendingDisconnect.promise;
      },
      onRunnerDispose: () => sequence.push('modeling-dispose'),
      shutdownTimings: {
        disconnectTimeoutMs: 30,
        attachmentDrainTimeoutMs: 30,
      },
    });
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-pending-send'));
    const client = await openRoom(requiredUrl(opened.url));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await harness
        .tool('manifold_execute_script')
        .handler?.({ code: 'result = Manifold.cube(1);' }, invocation('manifold_execute_script'));
      const version = requiredString(
        (await client.messages.waitFor(message => message.kind === 'model_version' && message.modelVersion !== 'none'))
          .modelVersion,
      );
      client.socket.send(
        JSON.stringify(createAnnotationsMessage(version, 1, [pointAnnotation('pending', version, 'wait')])),
      );
      await eventually(() => harness.sendAttachments.mock.calls.length === 1);

      const startedAt = performance.now();
      await application.shutdown({ disconnectSession: true });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(50);
      expect(elapsedMs).toBeLessThan(500);
      expect(sequence.indexOf('disconnect')).toBeGreaterThanOrEqual(0);
      expect(sequence.indexOf('disconnect')).toBeLessThan(sequence.indexOf('modeling-dispose'));
      expect(application.liveRoomCount).toBe(0);
      expect(harness.runner.disposeCalls).toBe(1);
      expect(harness.renderer.disposeCalls).toBe(1);

      pendingAttachment.reject(new Error('late attachment failure'));
      pendingDisconnect.reject(new Error('late disconnect failure'));
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 25));
      expect(unhandled).toEqual([]);
      application = undefined;
    } finally {
      process.off('unhandledRejection', onUnhandled);
      client.socket.terminate();
    }
  });

  it('closes local resources even when explicit SDK disconnect rejects', async () => {
    const harness = createHarness({
      disconnect: () => Promise.reject(new Error('disconnect failed')),
      shutdownTimings: {
        disconnectTimeoutMs: 25,
        attachmentDrainTimeoutMs: 25,
      },
    });
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-disconnect-error'));

    await expect(application.shutdown({ disconnectSession: true })).rejects.toThrow(/shutdown failed/);
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(application.liveRoomCount).toBe(0);
    expect(harness.runner.disposeCalls).toBe(1);
    expect(harness.renderer.disposeCalls).toBe(1);
    await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
    application = undefined;
  });

  it('uses local-only bounded cleanup for parent signals without SDK disconnect', async () => {
    const pendingAttachment = deferred<void>();
    const harness = createHarness({
      sendAttachments: () => pendingAttachment.promise,
      shutdownTimings: {
        disconnectTimeoutMs: 25,
        attachmentDrainTimeoutMs: 25,
      },
    });
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-signal'));
    const client = await openRoom(requiredUrl(opened.url));
    try {
      await harness
        .tool('manifold_execute_script')
        .handler?.({ code: 'result = Manifold.cube(1);' }, invocation('manifold_execute_script'));
      const version = requiredString(
        (await client.messages.waitFor(message => message.kind === 'model_version' && message.modelVersion !== 'none'))
          .modelVersion,
      );
      client.socket.send(
        JSON.stringify(createAnnotationsMessage(version, 1, [pointAnnotation('signal', version, 'signal')])),
      );
      await eventually(() => harness.sendAttachments.mock.calls.length === 1);

      const signalRuntime = createSignalRuntime();
      installExtensionSignalHandlers(application, signalRuntime.runtime);
      const startedAt = performance.now();
      signalRuntime.emit('SIGTERM');
      await eventually(() => signalRuntime.exit.mock.calls.length === 1);
      signalRuntime.emit('SIGINT');

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(signalRuntime.exit).toHaveBeenCalledWith(0);
      expect(signalRuntime.exit).toHaveBeenCalledTimes(1);
      expect(harness.disconnect).not.toHaveBeenCalled();
      expect(application.liveRoomCount).toBe(0);
      expect(harness.runner.disposeCalls).toBe(1);
      expect(harness.renderer.disposeCalls).toBe(1);
      await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
      pendingAttachment.reject(new Error('late signal attachment failure'));
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
      application = undefined;
    } finally {
      client.socket.terminate();
    }
  });
});

interface HarnessOptions {
  sendAttachments?: (
    input: Parameters<CopilotExtensionSession['rpc']['extensions']['sendAttachmentsToMessage']>[0],
  ) => Promise<void>;
  disconnect?: () => Promise<void>;
  joinSession?: (config: JoinSessionConfig, session: CopilotExtensionSession) => Promise<CopilotExtensionSession>;
  shutdownTimings?: {
    disconnectTimeoutMs?: number;
    attachmentDrainTimeoutMs?: number;
  };
  onRunnerDispose?: () => void;
}

function createHarness(options: HarnessOptions = {}) {
  const runner = new StubRunner(options.onRunnerDispose);
  const renderer = new StubRenderer();
  const modelingSession = new ModelingSession(new ModelingEngine(runner, renderer));
  const send = vi.fn(() => Promise.resolve('assistant-message-42'));
  const sendAttachments = vi.fn(
    (params: Parameters<CopilotExtensionSession['rpc']['extensions']['sendAttachmentsToMessage']>[0]) =>
      options.sendAttachments ? options.sendAttachments(params) : Promise.resolve(),
  );
  const disconnect = vi.fn(() => (options.disconnect ? options.disconnect() : Promise.resolve()));
  const session: CopilotExtensionSession = {
    sessionId: 'mock-session',
    workspacePath: testWorkspace,
    send,
    log: vi.fn(() => Promise.resolve()),
    disconnect,
    rpc: {
      extensions: {
        sendAttachmentsToMessage: sendAttachments,
      },
    },
  };
  let canvasOptions: CanvasOptions | undefined;
  let joinConfig: JoinSessionConfig | undefined;
  const sdk: CopilotSdkBoundary = {
    createCanvas(canvasDefinition) {
      canvasOptions = canvasDefinition;
      return {
        declaration: {
          id: canvasDefinition.id,
          displayName: canvasDefinition.displayName,
          description: canvasDefinition.description,
          ...(canvasDefinition.inputSchema !== undefined ? { inputSchema: canvasDefinition.inputSchema } : {}),
          actions: canvasDefinition.actions?.map(({ handler: _handler, ...action }) => action),
        },
        open: canvasDefinition.open,
        ...(canvasDefinition.onClose !== undefined ? { onClose: canvasDefinition.onClose } : {}),
      } as Canvas;
    },
    joinSession(config) {
      joinConfig = config;
      return options.joinSession ? options.joinSession(config, session) : Promise.resolve(session);
    },
  };

  return {
    modelingSession,
    runner,
    renderer,
    send,
    sendAttachments,
    disconnect,
    startOptions: {
      sdk,
      viewerAssets: new Map([
        ['index.html', { bytes: Buffer.from('<!doctype html><title>test</title>') }],
        ['assets/app.js', { bytes: Buffer.from('export {};'), contentType: 'text/javascript; charset=utf-8' }],
      ]),
      modelingSession,
      preferredPort: 0,
      ...(options.shutdownTimings !== undefined ? { shutdownTimings: options.shutdownTimings } : {}),
    },
    session,
    canvas(): CanvasOptions {
      if (!canvasOptions) {
        throw new Error('Canvas was not registered.');
      }
      return canvasOptions;
    },
    tool(name: string) {
      const tool = joinConfig?.tools?.find(candidate => candidate.name === name);
      if (!tool?.handler) {
        throw new Error(`Tool ${name} was not registered.`);
      }
      return tool;
    },
    async transformPrompt(transformedPrompt: string) {
      const hook = joinConfig?.hooks?.onUserPromptTransformed;
      if (!hook) {
        throw new Error('onUserPromptTransformed was not registered.');
      }
      return hook(
        {
          sessionId: 'mock-session',
          prompt: 'user prompt',
          transformedPrompt,
          timestamp: new Date(),
          workingDirectory: testWorkspace,
        },
        { sessionId: 'mock-session' },
      );
    },
    emitSessionShutdown(): void {
      const onEvent = joinConfig?.onEvent;
      if (!onEvent) {
        throw new Error('JoinSessionConfig.onEvent was not registered.');
      }
      onEvent({ type: 'session.shutdown' } as Parameters<typeof onEvent>[0]);
    },
    joinConfigured(): boolean {
      return joinConfig !== undefined;
    },
  };
}

class StubRunner extends Runner {
  disposeCalls = 0;

  constructor(private readonly onDispose?: () => void) {
    super();
  }

  override run(request: RunRequest, _options: RunnerOptions = {}): Promise<RunResult> {
    if (request.mode === 'validate') {
      return Promise.resolve({ report: emptyReport() });
    }
    return Promise.resolve({
      report: emptyReport(),
      mesh: artifact(request.description),
    });
  }

  override dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.onDispose?.();
    return Promise.resolve();
  }
}

class StubRenderer implements PreviewRenderer {
  disposeCalls = 0;

  renderView(_model: ModelArtifact, options: RenderViewOptions = {}): Promise<RenderResult> {
    return Promise.resolve({
      png: Buffer.from('png'),
      width: options.width ?? 1024,
      height: options.height ?? 1024,
    });
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

function artifact(description?: string): ModelArtifact {
  return {
    ...(description !== undefined ? { description } : {}),
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

function pointAnnotation(id: string, modelVersion: string, note: string, clientId?: string): WireAnnotation {
  return {
    id,
    modelVersion,
    kind: 'point',
    partLabel: 'point#1',
    note,
    worldCoord: [1, 2, 3],
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

function openContext(instanceId: string) {
  return {
    sessionId: 'mock-session',
    extensionId: 'project:manifold3d',
    canvasId: MANIFOLD_CANVAS_ID,
    instanceId,
    host: {},
  };
}

function closeContext(instanceId: string) {
  return {
    sessionId: 'mock-session',
    extensionId: 'project:manifold3d',
    canvasId: MANIFOLD_CANVAS_ID,
    instanceId,
    host: {},
  };
}

function invocation(toolName: string) {
  return {
    sessionId: 'mock-session',
    toolCallId: `${toolName}-call`,
    toolName,
    arguments: {},
  };
}

interface RoomClient {
  socket: WebSocket;
  messages: MessageCollector;
}

class MessageCollector {
  readonly items: Array<Record<string, unknown>> = [];
  private readonly listeners = new Set<() => void>();

  push(message: Record<string, unknown>): void {
    this.items.push(message);
    for (const listener of this.listeners) {
      listener();
    }
  }

  async waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const existing = this.items.find(predicate);
    if (existing) {
      return existing;
    }
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error('Timed out waiting for Viewer Host message.'));
      }, 10_000);
      const check = (): void => {
        const match = this.items.find(predicate);
        if (!match) {
          return;
        }
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolvePromise(match);
      };
      this.listeners.add(check);
    });
  }

  waitForCount(predicate: (message: Record<string, unknown>) => boolean, count: number): Promise<void> {
    if (this.items.filter(predicate).length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for ${count} Viewer Host messages.`));
      }, 10_000);
      const check = (): void => {
        if (this.items.filter(predicate).length < count) {
          return;
        }
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolvePromise();
      };
      this.listeners.add(check);
    });
  }
}

async function openRoom(url: string): Promise<RoomClient> {
  const messages = new MessageCollector();
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}ws`, { origin: new URL(url).origin });
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      return;
    }
    const parsed: unknown = JSON.parse(rawDataToString(data));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      messages.push(parsed as Record<string, unknown>);
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('open', resolvePromise);
    socket.once('error', reject);
  });
  await messages.waitFor(message => message.kind === 'hello');
  await messages.waitFor(message => message.kind === 'host_actions_manifest');
  return { socket, messages };
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

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for test state.');
    }
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
  }
}

function createSignalRuntime() {
  const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
  const exit = vi.fn((_code: number) => undefined);
  const stderr: string[] = [];
  const runtime: ExtensionSignalRuntime = {
    once(signal, listener) {
      listeners.set(signal, listener);
    },
    exit,
    stderr: {
      write(message) {
        stderr.push(message);
      },
    },
  };
  return {
    runtime,
    exit,
    stderr,
    emit(signal: 'SIGINT' | 'SIGTERM'): void {
      const listener = listeners.get(signal);
      if (!listener) {
        throw new Error(`No listener registered for ${signal}.`);
      }
      listener();
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveDeferred = resolvePromise;
    rejectDeferred = rejectPromise;
  });
  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred,
  };
}

function requiredUrl(value: string | undefined): string {
  if (!value) {
    throw new Error('Canvas did not return a URL.');
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a string.');
  }
  return value;
}
