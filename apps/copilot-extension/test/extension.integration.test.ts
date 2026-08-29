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
import { createHostActionInvocation } from '@manifold3d/protocol/wire/host-actions.js';
import {
  ATTACH_ANNOTATION_BATCH_ACTION_ID,
  ATTACH_LOCATION_SELECTION_ACTION_ID,
  FIX_ANNOTATION_BATCH_ACTION_ID,
  FIX_ANNOTATION_BATCH_PROMPT,
  MANIFOLD_CANVAS_ID,
  startCopilotExtension,
  type CopilotExtensionApplication,
} from '../src/composition.js';
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

  it('registers transactional actions and pushes one static pill per batch or location selection', async () => {
    const harness = createHarness();
    application = await startCopilotExtension(harness.startOptions);
    const canvas = harness.canvas();
    expect(canvas.id).toBe(MANIFOLD_CANVAS_ID);
    expect(harness.joinConfig()?.hooks?.onUserPromptTransformed).toBeUndefined();

    const firstOpen = await canvas.open(openContext('canvas-a'));
    const reopened = await canvas.open(openContext('canvas-a'));
    expect(reopened.url).toBe(firstOpen.url);

    const clientA = await openRoom(requiredUrl(firstOpen.url));
    try {
      const execute = harness.tool('manifold_execute_script');
      expect(
        await execute.handler?.(
          { code: 'result = Manifold.cube(1);', description: 'first' },
          invocation('manifold_execute_script'),
        ),
      ).toMatchObject({ resultType: 'success' });
      expect((await clientA.messages.waitFor(message => message.kind === 'mesh')).description).toBe('first');

      const secondOpen = await canvas.open(openContext('canvas-b'));
      expect(secondOpen.url).not.toBe(firstOpen.url);
      const clientB = await openRoom(requiredUrl(secondOpen.url));
      try {
        expect(await clientB.messages.waitFor(message => message.kind === 'mesh')).toMatchObject({
          description: 'first',
        });
        const actionManifest = await clientA.messages.waitFor(message => message.kind === 'host_actions_manifest');
        expect(actionManifest.actions).toEqual([
          expect.objectContaining({
            id: ATTACH_ANNOTATION_BATCH_ACTION_ID,
            slot: 'annotation-batch',
          }),
          expect.objectContaining({
            id: FIX_ANNOTATION_BATCH_ACTION_ID,
            slot: 'annotation-batch',
          }),
          expect.objectContaining({
            id: ATTACH_LOCATION_SELECTION_ACTION_ID,
            slot: 'selection-gesture',
          }),
        ]);

        const versionA = requiredString(
          (
            await clientA.messages.waitFor(
              message => message.kind === 'model_version' && message.modelVersion !== 'none',
            )
          ).modelVersion,
        );
        const versionB = requiredString(
          (
            await clientB.messages.waitFor(
              message => message.kind === 'model_version' && message.modelVersion !== 'none',
            )
          ).modelVersion,
        );
        expect(versionA).not.toBe(versionB);
        clientA.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionA, 4, [
              pointAnnotation('annotation-a', versionA, 'move this point'),
              regionAnnotation('annotation-region', versionA, 'round this region'),
              pointAnnotation('location-a', versionA, ''),
            ]),
          ),
        );
        clientB.socket.send(
          JSON.stringify(
            createAnnotationsMessage(versionB, 2, [pointAnnotation('annotation-b', versionB, 'room B note')]),
          ),
        );
        await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 25));
        expect(harness.sendAttachments).not.toHaveBeenCalled();

        await invokeAction(clientA, {
          requestId: 'attach-batch-a',
          actionId: ATTACH_ANNOTATION_BATCH_ACTION_ID,
          modelVersion: versionA,
          annotationRevision: 4,
          annotationIds: ['annotation-a', 'annotation-region'],
          input: { batchId: 'batch-a' },
        });
        expect(harness.sendAttachments).toHaveBeenCalledTimes(1);
        expect(harness.sendAttachments).toHaveBeenLastCalledWith({
          instanceId: 'canvas-a',
          attachments: [
            {
              type: 'extension_context',
              title: 'Manifold annotation batch · batch-a',
              payload: {
                version: 2,
                source: 'manifold3d-viewer',
                mode: 'annotation-batch',
                batchId: 'batch-a',
                modelVersion: versionA,
                annotationRevision: 4,
                annotations: [
                  {
                    id: 'annotation-a',
                    partLabel: 'point#1',
                    note: 'move this point',
                    selection: { kind: 'point', worldCoord: [1, 2, 3] },
                  },
                  {
                    id: 'annotation-region',
                    partLabel: 'region#1',
                    note: 'round this region',
                    selection: { kind: 'region', worldCoord: [4, 5, 6], triangleCount: 12 },
                  },
                ],
              },
            },
          ],
        });

        await invokeAction(clientA, {
          requestId: 'attach-location-a',
          actionId: ATTACH_LOCATION_SELECTION_ACTION_ID,
          modelVersion: versionA,
          annotationRevision: 4,
          annotationIds: ['location-a'],
        });
        expect(harness.sendAttachments).toHaveBeenCalledTimes(2);
        expect(harness.sendAttachments).toHaveBeenLastCalledWith({
          instanceId: 'canvas-a',
          attachments: [
            {
              type: 'extension_context',
              title: 'Manifold location · point#1',
              payload: {
                version: 2,
                source: 'manifold3d-viewer',
                mode: 'location-selection',
                modelVersion: versionA,
                annotationRevision: 4,
                annotations: [
                  {
                    id: 'location-a',
                    partLabel: 'point#1',
                    selection: { kind: 'point', worldCoord: [1, 2, 3] },
                  },
                ],
              },
            },
          ],
        });

        await invokeAction(clientB, {
          requestId: 'attach-batch-b',
          actionId: ATTACH_ANNOTATION_BATCH_ACTION_ID,
          modelVersion: versionB,
          annotationRevision: 2,
          annotationIds: ['annotation-b'],
          input: { batchId: 'batch-b' },
        });
        expect(harness.sendAttachments).toHaveBeenCalledTimes(3);
        expect(harness.sendAttachments.mock.calls[2]?.[0]).toMatchObject({
          instanceId: 'canvas-b',
          attachments: [
            {
              payload: {
                batchId: 'batch-b',
                modelVersion: versionB,
                annotations: [{ id: 'annotation-b', note: 'room B note' }],
              },
            },
          ],
        });

        await canvas.onClose?.(closeContext('canvas-a'));
        expect((await fetch(requiredUrl(firstOpen.url))).status).toBe(404);
        expect((await fetch(requiredUrl(secondOpen.url))).status).toBe(200);
      } finally {
        clientB.socket.terminate();
      }
    } finally {
      clientA.socket.terminate();
    }
  });

  it('pushes a fix pill before enqueueing once and replays idempotent statuses', async () => {
    const sendResult = deferred<string>();
    const sequence: string[] = [];
    const harness = createHarness({
      sendAttachments: () => {
        sequence.push('attachment');
        return Promise.resolve();
      },
      send: options => {
        sequence.push('send');
        expect(options).toEqual({ mode: 'enqueue', prompt: FIX_ANNOTATION_BATCH_PROMPT });
        return sendResult.promise;
      },
    });
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-fix'));
    const client = await openRoom(requiredUrl(opened.url));
    try {
      await harness
        .tool('manifold_execute_script')
        .handler?.({ code: 'result = Manifold.cube(1);', description: 'first' }, invocation('manifold_execute_script'));
      const version = requiredString(
        (await client.messages.waitFor(message => message.kind === 'model_version' && message.modelVersion !== 'none'))
          .modelVersion,
      );
      client.socket.send(
        JSON.stringify(createAnnotationsMessage(version, 1, [pointAnnotation('fix-me', version, 'make it taller')])),
      );
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
      const request = createHostActionInvocation({
        requestId: 'fix-request',
        actionId: FIX_ANNOTATION_BATCH_ACTION_ID,
        modelVersion: version,
        annotationRevision: 1,
        annotationIds: ['fix-me'],
        input: { batchId: 'fix-batch' },
      });
      client.socket.send(JSON.stringify(request));
      await client.messages.waitFor(
        message =>
          message.kind === 'host_action_status' &&
          message.requestId === request.requestId &&
          message.state === 'running',
      );
      await eventually(() => harness.send.mock.calls.length === 1);
      expect(sequence).toEqual(['attachment', 'send']);
      expect(harness.sendAttachments).toHaveBeenCalledTimes(1);

      client.socket.send(JSON.stringify(request));
      await client.messages.waitForCount(
        message => message.kind === 'host_action_status' && message.requestId === request.requestId,
        3,
      );
      expect(harness.sendAttachments).toHaveBeenCalledTimes(1);
      expect(harness.send).toHaveBeenCalledTimes(1);

      sendResult.resolve('assistant-message');
      await client.messages.waitFor(
        message =>
          message.kind === 'host_action_status' &&
          message.requestId === request.requestId &&
          message.state === 'succeeded',
      );
      client.socket.send(JSON.stringify(request));
      await client.messages.waitForCount(
        message =>
          message.kind === 'host_action_status' &&
          message.requestId === request.requestId &&
          message.state === 'succeeded',
        2,
      );
      expect(harness.sendAttachments).toHaveBeenCalledTimes(1);
      expect(harness.send).toHaveBeenCalledTimes(1);
    } finally {
      client.socket.terminate();
    }
  });

  it('reports validation and SDK failures without transformed-prompt or unhandled-rejection paths', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let attachmentAttempts = 0;
    const harness = createHarness({
      sendAttachments: () => {
        attachmentAttempts += 1;
        return attachmentAttempts === 1 ? Promise.reject(new Error('attachment failed')) : Promise.resolve();
      },
      send: () => Promise.reject(new Error('send failed')),
      log: () => Promise.reject(new Error('logging failed')),
    });
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-failures'));
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
        JSON.stringify(
          createAnnotationsMessage(version, 2, [
            pointAnnotation('noted', version, 'keep this note'),
            pointAnnotation('empty', version, ''),
          ]),
        ),
      );
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));

      await expectFailedAction(client, {
        requestId: 'missing-batch-id',
        actionId: ATTACH_ANNOTATION_BATCH_ACTION_ID,
        modelVersion: version,
        annotationRevision: 2,
        annotationIds: ['noted'],
      });
      await expectFailedAction(client, {
        requestId: 'missing-annotation-ids',
        actionId: ATTACH_ANNOTATION_BATCH_ACTION_ID,
        modelVersion: version,
        annotationRevision: 2,
        input: { batchId: 'batch' },
      });
      await expectFailedAction(client, {
        requestId: 'bad-location-count',
        actionId: ATTACH_LOCATION_SELECTION_ACTION_ID,
        modelVersion: version,
        annotationRevision: 2,
        annotationIds: ['noted', 'empty'],
      });
      await expectFailedAction(client, {
        requestId: 'location-with-note',
        actionId: ATTACH_LOCATION_SELECTION_ACTION_ID,
        modelVersion: version,
        annotationRevision: 2,
        annotationIds: ['noted'],
      });
      await expectFailedAction(client, {
        requestId: 'stale-revision',
        actionId: ATTACH_ANNOTATION_BATCH_ACTION_ID,
        modelVersion: version,
        annotationRevision: 1,
        annotationIds: ['noted'],
        input: { batchId: 'batch' },
      });
      await expectFailedAction(client, {
        requestId: 'attachment-failure',
        actionId: ATTACH_ANNOTATION_BATCH_ACTION_ID,
        modelVersion: version,
        annotationRevision: 2,
        annotationIds: ['noted'],
        input: { batchId: 'batch' },
      });
      await expectFailedAction(client, {
        requestId: 'send-failure',
        actionId: FIX_ANNOTATION_BATCH_ACTION_ID,
        modelVersion: version,
        annotationRevision: 2,
        annotationIds: ['noted'],
        input: { batchId: 'fix-batch' },
      });

      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 25));
      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(harness.joinConfig()?.hooks?.onUserPromptTransformed).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      client.socket.terminate();
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
    await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
    application = undefined;
  });

  it('closes resources on session.shutdown without disconnecting the already-ending SDK session', async () => {
    const harness = createHarness();
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-session-shutdown'));
    harness.emitSessionShutdown();
    harness.emitSessionShutdown();

    await eventually(() => harness.runner.disposeCalls === 1 && harness.renderer.disposeCalls === 1);
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
        fixSendDrainTimeoutMs: 25,
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

  it('bounds pending fix sends and explicit disconnect, then ignores late settlement', async () => {
    const pendingSend = deferred<string>();
    const pendingDisconnect = deferred<void>();
    const sequence: string[] = [];
    const harness = createHarness({
      sendAttachments: () => {
        sequence.push('attachment');
        return Promise.resolve();
      },
      send: () => {
        sequence.push('fix-send');
        return pendingSend.promise;
      },
      disconnect: () => {
        sequence.push('disconnect');
        return pendingDisconnect.promise;
      },
      onRunnerDispose: () => sequence.push('modeling-dispose'),
      shutdownTimings: {
        disconnectTimeoutMs: 30,
        fixSendDrainTimeoutMs: 30,
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
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
      client.socket.send(
        JSON.stringify(
          createHostActionInvocation({
            requestId: 'pending-fix',
            actionId: FIX_ANNOTATION_BATCH_ACTION_ID,
            modelVersion: version,
            annotationRevision: 1,
            annotationIds: ['pending'],
            input: { batchId: 'pending-batch' },
          }),
        ),
      );
      await eventually(() => harness.send.mock.calls.length === 1);

      const startedAt = performance.now();
      await application.shutdown({ disconnectSession: true });
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(50);
      expect(elapsedMs).toBeLessThan(500);
      expect(sequence.slice(0, 2)).toEqual(['attachment', 'fix-send']);
      expect(sequence.indexOf('disconnect')).toBeGreaterThanOrEqual(0);
      expect(sequence.indexOf('disconnect')).toBeLessThan(sequence.indexOf('modeling-dispose'));
      expect(harness.runner.disposeCalls).toBe(1);
      expect(harness.renderer.disposeCalls).toBe(1);

      pendingSend.reject(new Error('late send failure'));
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
        fixSendDrainTimeoutMs: 25,
      },
    });
    application = await startCopilotExtension(harness.startOptions);
    const opened = await harness.canvas().open(openContext('canvas-disconnect-error'));

    await expect(application.shutdown({ disconnectSession: true })).rejects.toThrow(/shutdown failed/);
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.runner.disposeCalls).toBe(1);
    expect(harness.renderer.disposeCalls).toBe(1);
    await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
    application = undefined;
  });

  it('uses local-only bounded cleanup for parent signals without SDK disconnect', async () => {
    const pendingSend = deferred<string>();
    const harness = createHarness({
      send: () => pendingSend.promise,
      shutdownTimings: {
        disconnectTimeoutMs: 25,
        fixSendDrainTimeoutMs: 25,
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
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
      client.socket.send(
        JSON.stringify(
          createHostActionInvocation({
            requestId: 'signal-fix',
            actionId: FIX_ANNOTATION_BATCH_ACTION_ID,
            modelVersion: version,
            annotationRevision: 1,
            annotationIds: ['signal'],
            input: { batchId: 'signal-batch' },
          }),
        ),
      );
      await eventually(() => harness.send.mock.calls.length === 1);

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
      expect(harness.runner.disposeCalls).toBe(1);
      expect(harness.renderer.disposeCalls).toBe(1);
      await expect(fetch(requiredUrl(opened.url))).rejects.toThrow();
      pendingSend.reject(new Error('late signal send failure'));
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
      application = undefined;
    } finally {
      client.socket.terminate();
    }
  });
});

interface HarnessOptions {
  send?: (options: Parameters<CopilotExtensionSession['send']>[0]) => Promise<string>;
  sendAttachments?: (
    input: Parameters<CopilotExtensionSession['rpc']['extensions']['sendAttachmentsToMessage']>[0],
  ) => Promise<void>;
  log?: (...args: Parameters<CopilotExtensionSession['log']>) => Promise<void>;
  disconnect?: () => Promise<void>;
  joinSession?: (config: JoinSessionConfig, session: CopilotExtensionSession) => Promise<CopilotExtensionSession>;
  shutdownTimings?: {
    disconnectTimeoutMs?: number;
    fixSendDrainTimeoutMs?: number;
  };
  onRunnerDispose?: () => void;
}

function createHarness(options: HarnessOptions = {}) {
  const runner = new StubRunner(options.onRunnerDispose);
  const renderer = new StubRenderer();
  const modelingSession = new ModelingSession(new ModelingEngine(runner, renderer));
  const send = vi.fn((message: Parameters<CopilotExtensionSession['send']>[0]) =>
    options.send ? options.send(message) : Promise.resolve('assistant-message-42'),
  );
  const sendAttachments = vi.fn(
    (params: Parameters<CopilotExtensionSession['rpc']['extensions']['sendAttachmentsToMessage']>[0]) =>
      options.sendAttachments ? options.sendAttachments(params) : Promise.resolve(),
  );
  const log = vi.fn((...args: Parameters<CopilotExtensionSession['log']>) =>
    options.log ? options.log(...args) : Promise.resolve(),
  );
  const disconnect = vi.fn(() => (options.disconnect ? options.disconnect() : Promise.resolve()));
  const session: CopilotExtensionSession = {
    workspacePath: testWorkspace,
    send,
    log,
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
    log,
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
    joinConfig(): JoinSessionConfig | undefined {
      return joinConfig;
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
      artifact: artifact(request.description),
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

function regionAnnotation(id: string, modelVersion: string, note: string): WireAnnotation {
  return {
    id,
    modelVersion,
    kind: 'region',
    partLabel: 'region#1',
    note,
    worldCoord: [4, 5, 6],
    triCount: 12,
  };
}

async function invokeAction(
  client: RoomClient,
  input: Parameters<typeof createHostActionInvocation>[0],
): Promise<Record<string, unknown>> {
  const invocationMessage = createHostActionInvocation(input);
  client.socket.send(JSON.stringify(invocationMessage));
  return client.messages.waitFor(
    message =>
      message.kind === 'host_action_status' &&
      message.requestId === invocationMessage.requestId &&
      message.state === 'succeeded',
  );
}

async function expectFailedAction(
  client: RoomClient,
  input: Parameters<typeof createHostActionInvocation>[0],
): Promise<Record<string, unknown>> {
  const invocationMessage = createHostActionInvocation(input);
  client.socket.send(JSON.stringify(invocationMessage));
  return client.messages.waitFor(
    message =>
      message.kind === 'host_action_status' &&
      message.requestId === invocationMessage.requestId &&
      message.state === 'failed',
  );
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
