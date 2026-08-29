import type { CanvasOptions, JoinSessionConfig } from '@github/copilot-sdk/extension';
import { ModelingEngine, ModelingSession, type CommittedModel } from '@manifold3d/modeling/modeling.js';
import { toViewerModelFrame } from '@manifold3d/modeling/runner/model-artifact.js';
import { Runner } from '@manifold3d/modeling/runner/host.js';
import {
  createInMemoryViewerAssetProvider,
  startViewerHost,
  type ViewerAnnotationCommit,
  type ViewerAssetManifest,
  type ViewerHost,
  type ViewerRoom,
} from '@manifold3d/viewer-host/viewer-host.js';

import {
  annotationPayloadAsJsonValue,
  buildAnnotationAttachment as createAnnotationAttachment,
} from './annotation-attachment.js';
import type { CopilotExtensionSession, CopilotSdkBoundary } from './sdk-boundary.js';
import { createExtensionTools } from './tools.js';

export const MANIFOLD_CANVAS_ID = 'manifold3d-viewer';
export const MANIFOLD_CANVAS_DISPLAY_NAME = 'Manifold 3D Viewer';
export const DEFAULT_SESSION_DISCONNECT_TIMEOUT_MS = 500;
export const DEFAULT_ATTACHMENT_DRAIN_TIMEOUT_MS = 250;
const LIVE_ANNOTATION_SETTLE_MS = 25;

interface RoomBinding {
  instanceId: string;
  room: ViewerRoom;
  cleanup: Array<() => void>;
  attachmentQueue: Promise<void>;
  liveAnnotations: Map<string, LiveAnnotationBinding>;
  closed: boolean;
}

interface LiveAnnotationBinding {
  annotationId: string;
  clientId: string | undefined;
  token: string;
  state: 'absent' | 'queued' | 'pushed';
}

export interface StartCopilotExtensionOptions {
  sdk: CopilotSdkBoundary;
  viewerAssets: ViewerAssetManifest;
  workerFilename?: string | URL;
  manifoldWasmBytes?: Uint8Array;
  typescriptLibDeclarations?: string;
  modelingSession?: ModelingSession;
  preferredPort?: number;
  shutdownTimings?: {
    disconnectTimeoutMs?: number;
    attachmentDrainTimeoutMs?: number;
  };
}

export interface ShutdownOptions {
  disconnectSession?: boolean;
}

export interface CopilotExtensionApplication {
  readonly session: CopilotExtensionSession;
  readonly hostOrigin: string;
  readonly liveRoomCount: number;
  shutdown(options?: ShutdownOptions): Promise<void>;
}

export async function startCopilotExtension(
  options: StartCopilotExtensionOptions,
): Promise<CopilotExtensionApplication> {
  const modelingSession =
    options.modelingSession ??
    new ModelingSession(
      new ModelingEngine(
        new Runner({
          ...(options.workerFilename !== undefined ? { workerFilename: options.workerFilename } : {}),
          ...(options.manifoldWasmBytes !== undefined
            ? {
                workerData: {
                  role: 'model-worker',
                  wasmBinary: options.manifoldWasmBytes,
                  ...(options.typescriptLibDeclarations !== undefined
                    ? { typescriptLibDeclarations: options.typescriptLibDeclarations }
                    : {}),
                },
              }
            : {}),
        }),
      ),
    );
  let host: ViewerHost;
  try {
    host = await startViewerHost({
      assetProvider: createInMemoryViewerAssetProvider(options.viewerAssets),
      preferredPort: options.preferredPort ?? 0,
      host: '127.0.0.1',
      allowAnyFrameAncestor: true,
    });
  } catch (error) {
    await modelingSession.dispose();
    throw error;
  }
  const controller = new ExtensionController(host, modelingSession, {
    disconnectTimeoutMs: options.shutdownTimings?.disconnectTimeoutMs ?? DEFAULT_SESSION_DISCONNECT_TIMEOUT_MS,
    attachmentDrainTimeoutMs: options.shutdownTimings?.attachmentDrainTimeoutMs ?? DEFAULT_ATTACHMENT_DRAIN_TIMEOUT_MS,
  });
  const canvas = options.sdk.createCanvas(controller.canvasOptions());
  const tools = createExtensionTools({
    modelingSession,
    publishModel: model => controller.publishModel(model),
    getSession: () => controller.getSession(),
  });

  let session: CopilotExtensionSession;
  const onEvent: NonNullable<JoinSessionConfig['onEvent']> = event => {
    if (event.type === 'session.shutdown') {
      controller.observeSessionShutdown();
    }
  };
  try {
    session = await options.sdk.joinSession({
      canvases: [canvas],
      tools,
      hooks: {
        onUserPromptTransformed: input => controller.resolveLiveAnnotationContext(input.transformedPrompt),
      },
      onEvent,
    });
  } catch (error) {
    await controller.shutdown();
    throw error;
  }
  controller.bindSession(session);
  if (controller.isShuttingDown) {
    const cleanup = await Promise.allSettled([controller.disconnectJoinedSession(session), controller.shutdown()]);
    const errors = rejectedReasons(cleanup);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Copilot session shut down while the Extension was joining.');
    }
    throw new Error('Copilot session shut down while the Extension was joining.');
  }

  return {
    session,
    hostOrigin: host.origin,
    get liveRoomCount(): number {
      return controller.liveRoomCount;
    },
    shutdown: shutdownOptions => controller.shutdown(shutdownOptions),
  };
}

class ExtensionController {
  private readonly rooms = new Map<string, RoomBinding>();
  private readonly attachmentOperations = new Set<Promise<void>>();
  private session: CopilotExtensionSession | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly host: ViewerHost,
    private readonly modelingSession: ModelingSession,
    private readonly shutdownTimings: {
      disconnectTimeoutMs: number;
      attachmentDrainTimeoutMs: number;
    },
  ) {}

  get liveRoomCount(): number {
    return this.rooms.size;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  bindSession(session: CopilotExtensionSession): void {
    if (this.session) {
      throw new Error('Copilot session is already bound.');
    }
    this.session = session;
  }

  getSession(): CopilotExtensionSession {
    if (!this.session) {
      throw new Error('Copilot session is not ready.');
    }
    if (this.shuttingDown) {
      throw new Error('Copilot extension is shutting down.');
    }
    return this.session;
  }

  observeSessionShutdown(): void {
    if (this.shuttingDown) {
      return;
    }
    void this.shutdown().catch(error => {
      process.stderr.write(`[manifold3d-extension] session shutdown failed: ${errorMessage(error)}\n`);
    });
  }

  async disconnectJoinedSession(session: CopilotExtensionSession): Promise<void> {
    const outcome = await settleCallWithin(() => session.disconnect(), this.shutdownTimings.disconnectTimeoutMs);
    if (outcome.status === 'rejected') {
      throw outcome.reason;
    }
    if (outcome.status === 'timed-out') {
      process.stderr.write('[manifold3d-extension] joined session disconnect timed out; cleanup continued.\n');
    }
  }

  canvasOptions(): CanvasOptions {
    return {
      id: MANIFOLD_CANVAS_ID,
      displayName: MANIFOLD_CANVAS_DISPLAY_NAME,
      description: 'Inspect the current manifold-3d model and send selected annotations back to Copilot.',
      open: context => this.openCanvas(context.instanceId),
      onClose: context => this.closeCanvas(context.instanceId),
    };
  }

  publishModel(model: CommittedModel): void {
    if (this.shuttingDown) {
      throw new Error('Cannot publish a model while the Copilot extension is shutting down.');
    }
    const frame = toViewerModelFrame(model.artifact);
    const snapshot = [...this.rooms.values()];
    for (const binding of snapshot) {
      if (binding.closed || this.rooms.get(binding.instanceId) !== binding) {
        continue;
      }
      try {
        binding.room.pushModel(frame);
      } catch (error) {
        if (binding.closed || this.rooms.get(binding.instanceId) !== binding) {
          continue;
        }
        throw error;
      }
    }
  }

  shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const errors: unknown[] = [];
      if (options.disconnectSession === true && this.session) {
        const disconnect = await settleCallWithin(
          () => this.session!.disconnect(),
          this.shutdownTimings.disconnectTimeoutMs,
        );
        if (disconnect.status === 'rejected') {
          errors.push(disconnect.reason);
        } else if (disconnect.status === 'timed-out') {
          process.stderr.write('[manifold3d-extension] session disconnect timed out; continuing local cleanup.\n');
        }
      }

      const pendingAttachments = await settlePromiseWithin(
        Promise.allSettled([...this.attachmentOperations]),
        this.shutdownTimings.attachmentDrainTimeoutMs,
      );
      if (pendingAttachments.status === 'fulfilled') {
        errors.push(...rejectedReasons(pendingAttachments.value));
      } else if (pendingAttachments.status === 'timed-out') {
        process.stderr.write(
          '[manifold3d-extension] pending annotation attachments exceeded the drain window; closing locally.\n',
        );
      }
      this.attachmentOperations.clear();

      const rooms = [...this.rooms.values()];
      this.rooms.clear();
      const closedRooms = await Promise.allSettled(
        rooms.map(async binding => {
          binding.closed = true;
          for (const cleanup of binding.cleanup.splice(0)) {
            cleanup();
          }
          await binding.room.close();
        }),
      );
      errors.push(...rejectedReasons(closedRooms));

      const resources = await Promise.allSettled([this.host.close(), this.modelingSession.dispose()]);
      errors.push(...rejectedReasons(resources));
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Copilot extension shutdown failed.');
      }
    })();
    return this.shutdownPromise;
  }

  private async openCanvas(instanceId: string): Promise<{ title: string; status: string; url: string }> {
    if (this.shuttingDown) {
      throw new Error('Cannot open a Canvas while the Copilot extension is shutting down.');
    }
    const existing = this.rooms.get(instanceId);
    if (existing) {
      return canvasOpenResult(existing.room.url);
    }

    const room = this.host.createRoom();
    const binding: RoomBinding = {
      instanceId,
      room,
      cleanup: [],
      attachmentQueue: Promise.resolve(),
      liveAnnotations: new Map(),
      closed: false,
    };
    this.rooms.set(instanceId, binding);
    try {
      binding.cleanup.push(
        room.subscribeAnnotationCommits(commit => {
          this.queueAnnotationAttachment(binding, commit);
        }),
      );
      const current = this.modelingSession.getCurrentModel();
      if (current) {
        room.pushModel(toViewerModelFrame(current.artifact));
      }
      return canvasOpenResult(room.url);
    } catch (error) {
      this.rooms.delete(instanceId);
      binding.closed = true;
      for (const cleanup of binding.cleanup.splice(0)) {
        cleanup();
      }
      await room.close();
      throw error;
    }
  }

  private async closeCanvas(instanceId: string): Promise<void> {
    const binding = this.rooms.get(instanceId);
    if (!binding) {
      return;
    }
    this.rooms.delete(instanceId);
    binding.closed = true;
    for (const cleanup of binding.cleanup.splice(0)) {
      cleanup();
    }
    await binding.room.close();
  }

  private queueAnnotationAttachment(binding: RoomBinding, commit: ViewerAnnotationCommit): void {
    const changedIds = new Set(commit.changedAnnotationIds);
    const pending = commit.items.flatMap(annotation => {
      if (!changedIds.has(annotation.id) || annotation.note.trim().length === 0) {
        return [];
      }
      const key = annotationBindingKey(annotation.id, annotation.clientId);
      let live = binding.liveAnnotations.get(key);
      if (!live) {
        live = {
          annotationId: annotation.id,
          clientId: annotation.clientId,
          token: crypto.randomUUID(),
          state: 'absent',
        };
        binding.liveAnnotations.set(key, live);
      }
      if (live.state !== 'absent') {
        return [];
      }
      live.state = 'queued';
      return [
        {
          live,
          title: annotationAttachmentTitle(annotation.partLabel),
          snapshot: annotationPayloadAsJsonValue(
            createAnnotationAttachment({
              modelVersion: commit.modelVersion,
              annotationRevision: commit.revision,
              annotations: [annotation],
            }).payload,
          ),
        },
      ];
    });
    if (pending.length === 0) {
      return;
    }

    const operation = binding.attachmentQueue.then(async () => {
      if (!this.canPublishTo(binding)) {
        for (const item of pending) {
          item.live.state = 'absent';
        }
        return;
      }
      await this.getSession().rpc.extensions.sendAttachmentsToMessage({
        instanceId: binding.instanceId,
        attachments: pending.map(item => ({
          type: 'extension_context',
          title: item.title,
          payload: {
            mode: 'live',
            liveToken: item.live.token,
            snapshot: item.snapshot,
          },
        })),
      });
      for (const item of pending) {
        item.live.state = 'pushed';
      }
    });
    const observed = operation.catch(async error => {
      for (const item of pending) {
        item.live.state = 'absent';
      }
      if (!this.shuttingDown) {
        try {
          await this.getSession().log(`Could not attach saved Manifold annotations: ${errorMessage(error)}`, {
            level: 'warning',
          });
        } catch {
          // Logging failures must not poison the attachment queue.
        }
      }
    });
    binding.attachmentQueue = observed;
    this.attachmentOperations.add(observed);
    void observed.then(
      () => this.attachmentOperations.delete(observed),
      () => this.attachmentOperations.delete(observed),
    );
  }

  async resolveLiveAnnotationContext(
    transformedPrompt: string,
  ): Promise<{ modifiedTransformedPrompt: string } | undefined> {
    const matched: Array<{ room: RoomBinding; annotation: LiveAnnotationBinding }> = [];
    for (const binding of this.rooms.values()) {
      for (const [key, live] of binding.liveAnnotations) {
        const markerPresent = transformedPrompt.includes(live.token);
        if (live.state === 'pushed' && !markerPresent) {
          binding.liveAnnotations.delete(key);
          continue;
        }
        if (markerPresent) {
          matched.push({ room: binding, annotation: live });
        }
      }
    }
    if (matched.length === 0) {
      return undefined;
    }

    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, LIVE_ANNOTATION_SETTLE_MS));
    const contexts: string[] = [];
    let resolvedPrompt = transformedPrompt;
    let removedLiveContext = false;
    for (const { room: binding, annotation: live } of matched) {
      if (binding.closed || this.rooms.get(binding.instanceId) !== binding) {
        continue;
      }
      const withoutLiveContext = removeLiveExtensionContext(resolvedPrompt, live.token);
      removedLiveContext ||= withoutLiveContext !== resolvedPrompt;
      resolvedPrompt = withoutLiveContext;
      const snapshot = binding.room.getAnnotations();
      const annotation = snapshot.items.find(item => item.id === live.annotationId && item.clientId === live.clientId);
      live.state = 'absent';
      if (!annotation || annotation.note.trim().length === 0) {
        binding.liveAnnotations.delete(annotationBindingKey(live.annotationId, live.clientId));
        continue;
      }
      try {
        const attachment = createAnnotationAttachment({
          modelVersion: snapshot.modelVersion,
          annotationRevision: snapshot.revision,
          annotations: [annotation],
        });
        contexts.push(liveAnnotationContextXml(binding.instanceId, live.annotationId, attachment.payload));
      } catch (error) {
        contexts.push(
          liveAnnotationContextXml(binding.instanceId, live.annotationId, {
            version: 1,
            source: 'manifold3d-viewer',
            modelVersion: snapshot.modelVersion,
            annotationRevision: snapshot.revision,
            error: `Live annotations could not be serialized: ${errorMessage(error)}`,
          }),
        );
      }
    }
    if (contexts.length === 0) {
      return removedLiveContext ? { modifiedTransformedPrompt: resolvedPrompt.trimEnd() } : undefined;
    }
    return {
      modifiedTransformedPrompt: `${resolvedPrompt.trimEnd()}\n\n${contexts.join('\n\n')}`,
    };
  }

  private canPublishTo(binding: RoomBinding): boolean {
    return !this.shuttingDown && !binding.closed && this.rooms.get(binding.instanceId) === binding;
  }
}

function canvasOpenResult(url: string): { title: string; status: string; url: string } {
  return {
    title: MANIFOLD_CANVAS_DISPLAY_NAME,
    status: 'Connected to the current modeling session',
    url,
  };
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function liveAnnotationContextXml(instanceId: string, annotationId: string, payload: unknown): string {
  const json = JSON.stringify(payload);
  return [
    `<manifold_live_annotation instance_id="${escapeXmlAttribute(instanceId)}" annotation_id="${escapeXmlAttribute(annotationId)}" encoding="json">`,
    'This snapshot was resolved from the live Viewer when the message was submitted.',
    'It supersedes the earlier payload for this annotation.',
    escapeXmlText(json),
    '</manifold_live_annotation>',
  ].join('\n');
}

function annotationBindingKey(annotationId: string, clientId: string | undefined): string {
  return `${clientId ?? ''}\u0000${annotationId}`;
}

function annotationAttachmentTitle(partLabel: string): string {
  return `Manifold annotation · ${partLabel}`.slice(0, 80);
}

function removeLiveExtensionContext(transformedPrompt: string, liveToken: string): string {
  return transformedPrompt.replace(/<extension_context\b[^>]*>[\s\S]*?<\/extension_context>/g, block =>
    block.includes(liveToken) ? '' : block,
  );
}

function escapeXmlText(value: string): string {
  return value.replace(/[&<>]/g, character => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return '&gt;';
    }
  });
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

type BoundedSettlement<T> =
  | PromiseSettledResult<T>
  | {
      status: 'timed-out';
    };

function settleCallWithin<T>(operation: () => Promise<T>, timeoutMs: number): Promise<BoundedSettlement<T>> {
  return settlePromiseWithin(Promise.resolve().then(operation), timeoutMs);
}

async function settlePromiseWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedSettlement<T>> {
  const observed = promise.then(
    value => ({ status: 'fulfilled', value }) as const,
    reason => ({ status: 'rejected', reason: reason as unknown }) as const,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ status: 'timed-out' }>(resolve => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
