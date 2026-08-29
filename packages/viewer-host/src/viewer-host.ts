import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { isAbsolute, join, normalize, relative, resolve as resolvePath } from 'node:path';
import type { Duplex } from 'node:stream';

import {
  ANNOTATIONS_PROTOCOL_VERSION,
  MAX_ANNOTATIONS_PAYLOAD_BYTES,
  parseAnnotationsMessage,
  type AnnotationsMessage,
  type WireAnnotation,
} from '@manifold3d/protocol/wire/annotations.js';
import {
  createHostActionStatus,
  createHostActionsManifest,
  extractHostActionRequestIdentity,
  MAX_HOST_ACTION_MESSAGE_LENGTH,
  MAX_HOST_ACTIONS,
  parseHostActionDescriptor,
  parseHostActionInvocation,
  type HostActionDescriptor,
  type HostActionInvocationMessage,
  type HostActionStatusMessage,
  type JsonValue,
} from '@manifold3d/protocol/wire/host-actions.js';
import {
  assertViewerModelFrame,
  createHelloMessage,
  createModelHeader,
  createModelVersionMessage,
  parseResumeTokenAckMessage,
  type ViewerModelFrame,
} from '@manifold3d/protocol/wire/model.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RawData } from 'ws';

const DEFAULT_ANNOTATION_GRACE_MS = 5_000;
const MAX_ACTION_REQUESTS = 1_024;
export const MAX_UNACKNOWLEDGED_RESUME_TOKENS = 4;
export const MAX_CLIENT_TEXT_BYTES = Math.max(MAX_ANNOTATIONS_PAYLOAD_BYTES, 64 * 1024);
export const MAX_VIEWER_ASSETS = 256;
export const MAX_VIEWER_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_VIEWER_ASSET_MANIFEST_BYTES = 32 * 1024 * 1024;
const ROOM_PATH_PREFIX = 'rooms';

export interface ViewerHostLogger {
  error(message: string): void;
  warn(message: string): void;
}

export interface ViewerAsset {
  bytes: Uint8Array;
  contentType?: string;
}

export interface ViewerAssetProvider {
  getAsset(relativePath: string): Promise<ViewerAsset | undefined>;
}

export type ViewerAssetManifest = ReadonlyMap<string, ViewerAsset>;

interface ViewerHostCommonOptions {
  preferredPort?: number;
  host?: string;
  annotationGraceMs?: number;
  additionalOrigins?: readonly string[];
  /**
   * Exact HTTP(S) ancestor origins, plus optional `'self'`, permitted to embed
   * the Viewer. Wildcard hostnames are rejected; use allowAnyFrameAncestor only
   * for the reviewed all-ancestors exception. Omitted/empty means
   * `frame-ancestors 'none'`.
   *
   * A Copilot Extension must supply the verified Canvas ancestor origin, or
   * deliberately choose another explicit policy after probing its host.
   */
  frameAncestors?: readonly string[];
  /**
   * Explicitly emit `frame-ancestors *`.
   *
   * This is a constrained exception for extension Canvas hosts whose parent
   * origin is not exposed by the SDK. Room URLs remain protected by an
   * unguessable credential, loopback-only binding, strict Host/Origin checks,
   * no-referrer, and no CORS response headers. MCP/default callers must leave
   * this false and retain `frame-ancestors 'none'`.
   */
  allowAnyFrameAncestor?: boolean;
  logger?: ViewerHostLogger;
}

export type ViewerHostOptions = ViewerHostCommonOptions &
  (
    | {
        assetRoot: string;
        assetProvider?: never;
      }
    | {
        assetProvider: ViewerAssetProvider;
        assetRoot?: never;
      }
  );

export interface ViewerRoomOptions {
  annotationGraceMs?: number;
}

export interface ViewerAnnotationSnapshot {
  protocolVersion: typeof ANNOTATIONS_PROTOCOL_VERSION;
  modelVersion: string;
  revision: number;
  items: WireAnnotation[];
}

export interface ViewerAnnotationCommit extends ViewerAnnotationSnapshot {
  /** Annotation ids whose serialized content changed in this accepted snapshot. */
  changedAnnotationIds: string[];
}

export type ViewerAnnotationCommitListener = (commit: ViewerAnnotationCommit) => void | Promise<void>;

export interface HostActionPublisher {
  running(message?: string): void;
  succeeded(message?: string): void;
  failed(message?: string): void;
}

export interface HostActionHandlerContext {
  requestId: string;
  actionId: string;
  modelVersion: string;
  annotationRevision: number;
  annotations: readonly WireAnnotation[];
  input?: JsonValue;
  publish: HostActionPublisher;
}

export type HostActionHandlerResult =
  | void
  | {
      status: 'accepted';
      operationId?: string;
      message?: string;
    }
  | {
      status: 'succeeded';
      message?: string;
    };

export type HostActionHandler = (
  context: HostActionHandlerContext,
) => HostActionHandlerResult | Promise<HostActionHandlerResult>;

interface RegisteredAction {
  descriptor: HostActionDescriptor;
  handler: HostActionHandler;
}

interface ClientAnnotationSnapshot {
  modelVersion: string;
  revision: number;
  items: Map<string, WireAnnotation>;
  fingerprint: string;
}

interface RoomClientState {
  id: string;
  currentResumeToken: string;
  resumeTokenAliases: string[];
  socket: WebSocket | undefined;
  snapshot: ClientAnnotationSnapshot | undefined;
  evictionTimer: NodeJS.Timeout | undefined;
  readonly actionRequests: Map<string, ActionRequestRecord>;
}

interface ActionRequestRecord {
  actionId: string;
  status: HostActionStatusMessage;
}

interface ParsedRoomPath {
  room: ViewerRoom;
  assetPath: string;
  resumeToken?: string;
}

export class ViewerHost {
  readonly port: number;
  readonly hostname: string;
  readonly origin: string;

  private readonly roomsByCredential = new Map<string, ViewerRoom>();
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly frameAncestors: readonly string[];
  private closed = false;

  private constructor(
    private readonly http: HttpServer,
    private readonly wss: WebSocketServer,
    private readonly assetProvider: ViewerAssetProvider,
    hostname: string,
    port: number,
    additionalOrigins: readonly string[],
    frameAncestors: readonly string[],
    private readonly defaultAnnotationGraceMs: number,
    private readonly logger: ViewerHostLogger,
  ) {
    this.hostname = hostname;
    this.port = port;
    this.origin = `http://${hostname}:${port}`;

    const hosts = new Set([`${hostname}:${port}`]);
    const origins = new Set([this.origin, ...additionalOrigins]);
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      hosts.add(`127.0.0.1:${port}`);
      hosts.add(`localhost:${port}`);
      origins.add(`http://127.0.0.1:${port}`);
      origins.add(`http://localhost:${port}`);
    }
    this.allowedHosts = hosts;
    this.allowedOrigins = origins;
    this.frameAncestors = frameAncestors;

    http.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  static async start(options: ViewerHostOptions): Promise<ViewerHost> {
    const hostname = options.host ?? '127.0.0.1';
    const frameAncestors = parseFrameAncestors(options.frameAncestors, options.allowAnyFrameAncestor === true);
    const assetProvider =
      'assetProvider' in options ? options.assetProvider : createFileViewerAssetProvider(options.assetRoot);
    const requestedPort = options.preferredPort === 0 ? 0 : await findFreePort(options.preferredPort ?? 3737, hostname);
    const logger = options.logger ?? stderrLogger;
    const holder: { instance?: ViewerHost } = {};
    const http = createServer((request, response) => {
      if (!holder.instance) {
        response.statusCode = 503;
        response.end('not ready');
        return;
      }
      void holder.instance.handleHttp(request, response).catch((error: unknown) => {
        logger.error(`[viewer-host] HTTP request failed: ${errorMessage(error)}`);
        if (!response.headersSent) {
          response.statusCode = 500;
        }
        response.end('internal server error');
      });
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_TEXT_BYTES });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(requestedPort, hostname, () => {
        http.off('error', reject);
        resolve();
      });
    });
    const address = http.address();
    if (!address || typeof address === 'string') {
      await closeHttp(http);
      throw new Error('Viewer Host did not expose a TCP address.');
    }
    const instance = new ViewerHost(
      http,
      wss,
      assetProvider,
      hostname,
      (address as AddressInfo).port,
      options.additionalOrigins ?? [],
      frameAncestors,
      options.annotationGraceMs ?? DEFAULT_ANNOTATION_GRACE_MS,
      logger,
    );
    holder.instance = instance;
    return instance;
  }

  createRoom(options: ViewerRoomOptions = {}): ViewerRoom {
    if (this.closed) {
      throw new Error('Cannot create a room after Viewer Host has closed.');
    }
    const roomId = randomToken(18);
    const credential = randomToken(32);
    const room = new ViewerRoom(
      this,
      roomId,
      credential,
      options.annotationGraceMs ?? this.defaultAnnotationGraceMs,
      this.logger,
    );
    this.roomsByCredential.set(roomCredentialKey(roomId, credential), room);
    return room;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const rooms = [...this.roomsByCredential.values()];
    this.roomsByCredential.clear();
    for (const room of rooms) {
      room.disposeFromHost();
    }
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    await closeHttp(this.http);
  }

  removeRoom(room: ViewerRoom): void {
    this.roomsByCredential.delete(roomCredentialKey(room.id, room.credential));
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response, this.origin, this.frameAncestors);
    if (!this.isAllowedHost(request.headers.host)) {
      response.statusCode = 403;
      response.end('forbidden');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end('method not allowed');
      return;
    }
    const parsed = this.parseRoomPath(request.url);
    if (!parsed) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    const { assetPath } = parsed;
    if (assetPath === 'ws') {
      response.statusCode = 426;
      response.end('websocket upgrade required');
      return;
    }
    const target = assetPath === '' || assetPath === 'index.html' ? 'index.html' : assetPath;
    if (!isSafeAssetPath(target)) {
      response.statusCode = 403;
      response.end('forbidden');
      return;
    }
    const asset = await this.assetProvider.getAsset(target);
    if (!asset) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.setHeader('Content-Type', asset.contentType ?? mime(target));
    response.setHeader('Content-Length', asset.bytes.byteLength);
    response.setHeader('Cache-Control', cacheControlFor(target));
    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength));
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const parsed = this.parseRoomPath(request.url);
    const origin = request.headers.origin;
    const host = request.headers.host;
    const reject = (reason: string): void => {
      this.logger.warn(
        `[viewer-host] rejected WS upgrade: ${reason} (origin=${origin ?? 'none'}, host=${host ?? 'none'})`,
      );
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    if (!parsed || parsed.assetPath !== 'ws') {
      reject('invalid room credential or route');
      return;
    }
    if (!this.isAllowedHost(host)) {
      reject('host not allow-listed (possible DNS rebinding)');
      return;
    }
    if (typeof origin !== 'string' || !this.allowedOrigins.has(origin)) {
      reject('origin not allow-listed');
      return;
    }
    this.wss.handleUpgrade(request, socket, head, webSocket => {
      parsed.room.acceptClient(webSocket, parsed.resumeToken);
    });
  }

  private parseRoomPath(rawUrl: string | undefined): ParsedRoomPath | undefined {
    if (!rawUrl || rawUrl.includes('%')) {
      return undefined;
    }
    const [pathname = '', query = ''] = rawUrl.split('?', 2);
    const normalized = normalize(pathname).replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/');
    if (segments[0] !== ROOM_PATH_PREFIX || segments.length < 3) {
      return undefined;
    }
    const roomId = segments[1];
    const credential = segments[2];
    if (!roomId || !credential) {
      return undefined;
    }
    const room = this.roomsByCredential.get(roomCredentialKey(roomId, credential));
    if (!room) {
      return undefined;
    }
    const searchParams = new URLSearchParams(query);
    const resumeValues = searchParams.getAll('resume');
    const resumeToken = resumeValues.length === 1 && isResumeToken(resumeValues[0]) ? resumeValues[0] : undefined;
    return {
      room,
      assetPath: segments.slice(3).join('/'),
      ...(resumeToken !== undefined ? { resumeToken } : {}),
    };
  }

  private isAllowedHost(host: string | undefined): boolean {
    return typeof host === 'string' && this.allowedHosts.has(host);
  }
}

export class ViewerRoom {
  readonly url: string;

  private readonly clientsById = new Map<string, RoomClientState>();
  private readonly clientsByResumeToken = new Map<string, RoomClientState>();
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly annotationCommitListeners = new Set<ViewerAnnotationCommitListener>();
  private lastModel: ViewerModelFrame | undefined;
  private modelVersion = 'none';
  private modelSequence = 0;
  private closed = false;

  constructor(
    private readonly host: ViewerHost,
    readonly id: string,
    readonly credential: string,
    private readonly annotationGraceMs: number,
    private readonly logger: ViewerHostLogger,
  ) {
    this.url = `${host.origin}/${ROOM_PATH_PREFIX}/${id}/${credential}/`;
  }

  pushModel(model: ViewerModelFrame): void {
    this.ensureOpen();
    assertViewerModelFrame(model);
    this.lastModel = model;
    this.modelSequence += 1;
    this.modelVersion = `v${Date.now().toString(36)}-${this.modelSequence.toString(36)}-${randomToken(4)}`;
    for (const client of this.clientsById.values()) {
      const snapshot = client.snapshot;
      if (!snapshot) {
        continue;
      }
      snapshot.modelVersion = this.modelVersion;
      snapshot.items.clear();
      snapshot.fingerprint = '[]';
    }
    for (const client of this.clientsById.values()) {
      const socket = client.socket;
      if (socket && socket.readyState === socket.OPEN) {
        sendModelVersion(socket, this.modelVersion);
        sendModel(socket, model);
      }
    }
  }

  /** Backwards-compatible alias for pushModel(). */
  push(model: ViewerModelFrame): void {
    this.pushModel(model);
  }

  getLastModel(): ViewerModelFrame | undefined {
    return this.lastModel;
  }

  /** @deprecated Use getLastModel(). */
  getLastMesh(): ViewerModelFrame | undefined {
    return this.lastModel;
  }

  getAnnotations(): ViewerAnnotationSnapshot {
    const items: WireAnnotation[] = [];
    let revision = 0;
    for (const client of this.clientsById.values()) {
      const snapshot = client.snapshot;
      if (!snapshot) {
        continue;
      }
      revision = Math.max(revision, snapshot.revision);
      for (const annotation of snapshot.items.values()) {
        items.push(cloneAnnotation(annotation));
      }
    }
    return {
      protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
      modelVersion: this.modelVersion,
      revision,
      items,
    };
  }

  subscribeAnnotationCommits(listener: ViewerAnnotationCommitListener): () => void {
    this.ensureOpen();
    this.annotationCommitListeners.add(listener);
    return () => {
      this.annotationCommitListeners.delete(listener);
    };
  }

  registerAction(descriptor: HostActionDescriptor, handler: HostActionHandler): () => void {
    this.ensureOpen();
    const parsed = parseHostActionDescriptor(descriptor);
    if (!this.actions.has(parsed.id) && this.actions.size >= MAX_HOST_ACTIONS) {
      throw new Error(`A Viewer room supports at most ${MAX_HOST_ACTIONS} host actions.`);
    }
    if (this.actions.has(parsed.id)) {
      throw new Error(`Host action "${parsed.id}" is already registered.`);
    }
    this.actions.set(parsed.id, { descriptor: parsed, handler });
    this.broadcastManifest();
    return () => {
      if (this.actions.delete(parsed.id)) {
        this.broadcastManifest();
      }
    };
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.host.removeRoom(this);
    this.disposeFromHost();
    return Promise.resolve();
  }

  acceptClient(socket: WebSocket, requestedResumeToken?: string): void {
    if (this.closed) {
      socket.close(1001, 'room closed');
      return;
    }
    const resumedClient =
      requestedResumeToken === undefined ? undefined : this.clientsByResumeToken.get(requestedResumeToken);
    const client: RoomClientState = resumedClient ?? {
      id: randomUUID(),
      currentResumeToken: '',
      resumeTokenAliases: [],
      socket: undefined,
      snapshot: undefined,
      evictionTimer: undefined,
      actionRequests: new Map(),
    };
    const resumed = resumedClient !== undefined;
    if (!resumed) {
      this.clientsById.set(client.id, client);
    }
    if (client.evictionTimer) {
      clearTimeout(client.evictionTimer);
      client.evictionTimer = undefined;
    }
    const previousSocket = client.socket;
    client.socket = socket;
    const issuedResumeToken = this.issueResumeToken(client, requestedResumeToken);
    if (previousSocket && previousSocket !== socket) {
      previousSocket.terminate();
    }

    socket.on('close', () => {
      if (client.socket !== socket || this.closed) {
        return;
      }
      client.socket = undefined;
      const timer = setTimeout(() => {
        if (client.socket) {
          return;
        }
        this.removeResumeTokenAliases(client);
        this.clientsById.delete(client.id);
        client.actionRequests.clear();
        client.snapshot = undefined;
        client.evictionTimer = undefined;
      }, this.annotationGraceMs);
      timer.unref?.();
      client.evictionTimer = timer;
    });
    socket.on('error', error => {
      this.logger.warn(`[viewer-host] room client socket error: ${error.message}`);
    });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.logger.warn('[viewer-host] rejected unexpected binary client frame.');
        return;
      }
      if (rawDataByteLength(raw) > MAX_CLIENT_TEXT_BYTES) {
        this.logger.warn(`[viewer-host] rejected client message larger than ${MAX_CLIENT_TEXT_BYTES} bytes.`);
        socket.close(1009, 'message too large');
        return;
      }
      this.handleClientText(client, socket, rawDataToString(raw));
    });

    socket.send(
      JSON.stringify(
        createHelloMessage(
          client.id,
          issuedResumeToken,
          resumed,
          resumed && client.snapshot ? client.snapshot.revision : undefined,
        ),
      ),
    );
    this.sendManifest(socket);
    for (const request of client.actionRequests.values()) {
      this.sendStatus(socket, request.status);
    }
    sendModelVersion(socket, this.modelVersion);
    if (this.lastModel) {
      sendModel(socket, this.lastModel);
    }
  }

  disposeFromHost(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.actions.clear();
    this.annotationCommitListeners.clear();
    for (const client of this.clientsById.values()) {
      if (client.evictionTimer) {
        clearTimeout(client.evictionTimer);
      }
      client.actionRequests.clear();
      client.snapshot = undefined;
      client.socket?.terminate();
      this.removeResumeTokenAliases(client);
    }
    this.clientsById.clear();
    this.clientsByResumeToken.clear();
    this.lastModel = undefined;
  }

  private handleClientText(client: RoomClientState, socket: WebSocket, text: string): void {
    if (client.socket !== socket) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.logger.warn('[viewer-host] rejected malformed client JSON.');
      return;
    }
    const kind =
      value && typeof value === 'object' && !Array.isArray(value) ? (value as { kind?: unknown }).kind : undefined;
    if (kind === 'annotations') {
      this.commitAnnotations(client, value);
      return;
    }
    if (kind === 'resume_token_ack') {
      try {
        const acknowledgement = parseResumeTokenAckMessage(value);
        this.acknowledgeResumeToken(client, acknowledgement.resumeToken);
      } catch (error) {
        this.logger.warn(`[viewer-host] rejected malformed resume token acknowledgement: ${errorMessage(error)}`);
      }
      return;
    }
    if (kind === 'host_action_invoke') {
      let invocation: HostActionInvocationMessage;
      try {
        invocation = parseHostActionInvocation(value);
      } catch (error) {
        const identity = extractHostActionRequestIdentity(value);
        const message = truncateMessage(errorMessage(error));
        if (identity) {
          if (client.socket) {
            this.sendStatus(client.socket, createHostActionStatus({ ...identity, state: 'failed', message }));
          }
        }
        this.logger.warn(`[viewer-host] rejected malformed host action invocation: ${message}`);
        return;
      }
      this.invokeAction(client, invocation);
      return;
    }
    if (typeof kind === 'string' && kind.startsWith('host_action')) {
      this.logger.warn(`[viewer-host] rejected unsupported host action message kind "${kind}".`);
    }
  }

  private commitAnnotations(client: RoomClientState, value: unknown): void {
    let message: AnnotationsMessage;
    try {
      message = parseAnnotationsMessage(value);
    } catch (error) {
      this.logger.warn(`[viewer-host] rejected malformed annotations: ${truncateMessage(errorMessage(error))}`);
      return;
    }
    if (message.modelVersion !== this.modelVersion) {
      this.logger.warn('[viewer-host] rejected annotations for a stale model version.');
      return;
    }
    const snapshot = client.snapshot;
    const revision = message.revision ?? (snapshot?.revision ?? -1) + 1;
    const fingerprint = JSON.stringify(message.items);
    if (snapshot && revision < snapshot.revision) {
      this.logger.warn('[viewer-host] rejected stale annotation revision.');
      return;
    }
    if (snapshot && revision === snapshot.revision) {
      if (fingerprint !== snapshot.fingerprint) {
        this.logger.warn('[viewer-host] rejected conflicting annotation snapshot at the committed revision.');
      }
      return;
    }
    const items = new Map<string, WireAnnotation>();
    const changedAnnotationIds: string[] = [];
    for (const annotation of message.items) {
      const next = { ...cloneAnnotation(annotation), clientId: client.id };
      items.set(annotation.id, next);
      const previous = snapshot?.items.get(annotation.id);
      if (!previous || annotationFingerprint(previous) !== annotationFingerprint(next)) {
        changedAnnotationIds.push(annotation.id);
      }
    }
    client.snapshot = {
      modelVersion: message.modelVersion,
      revision,
      items,
      fingerprint,
    };
    if (changedAnnotationIds.length > 0) {
      this.notifyAnnotationCommit({
        protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
        modelVersion: message.modelVersion,
        revision,
        items: [...items.values()].map(cloneAnnotation),
        changedAnnotationIds,
      });
    }
  }

  private notifyAnnotationCommit(commit: ViewerAnnotationCommit): void {
    for (const listener of this.annotationCommitListeners) {
      void Promise.resolve()
        .then(() => listener(structuredClone(commit)))
        .catch(error => {
          this.logger.warn(`[viewer-host] annotation commit listener failed: ${truncateMessage(errorMessage(error))}`);
        });
    }
  }

  private invokeAction(client: RoomClientState, invocation: HostActionInvocationMessage): void {
    const socket = client.socket;
    if (!socket) {
      return;
    }
    const prior = client.actionRequests.get(invocation.requestId);
    if (prior) {
      if (prior.actionId === invocation.actionId) {
        this.sendStatus(socket, prior.status);
      } else {
        this.sendFailure(client, invocation, 'requestId was already used for another action.');
      }
      return;
    }
    if (!this.reserveRequestCapacity(client)) {
      this.sendFailure(client, invocation, 'Too many host action requests are retained.');
      return;
    }
    const registration = this.actions.get(invocation.actionId);
    if (!registration) {
      this.sendFailure(client, invocation, 'Unknown host action.');
      return;
    }
    if (registration.descriptor.disabledReason) {
      this.sendFailure(client, invocation, registration.descriptor.disabledReason);
      return;
    }
    if (invocation.modelVersion !== this.modelVersion) {
      this.sendFailure(client, invocation, 'Action model version does not match the room.');
      return;
    }
    const snapshot = client.snapshot;
    if (!snapshot || snapshot.modelVersion !== this.modelVersion) {
      this.sendFailure(client, invocation, 'No committed annotation snapshot exists for this model.');
      return;
    }
    if (invocation.annotationRevision < snapshot.revision) {
      this.sendFailure(client, invocation, 'Action annotation revision is stale.');
      return;
    }
    if (invocation.annotationRevision > snapshot.revision) {
      this.sendFailure(client, invocation, 'Action annotation revision is newer than the committed snapshot.');
      return;
    }
    if (registration.descriptor.requires.includes('model') && !this.lastModel) {
      this.sendFailure(client, invocation, 'This action requires a model.');
      return;
    }
    const annotationIds = invocation.annotationIds ?? [...snapshot.items.keys()];
    const annotations: WireAnnotation[] = [];
    for (const id of annotationIds) {
      const annotation = snapshot.items.get(id);
      if (!annotation) {
        this.sendFailure(client, invocation, `Annotation "${id}" is not in the committed snapshot.`);
        return;
      }
      annotations.push(cloneAnnotation(annotation));
    }
    if (registration.descriptor.requires.includes('annotations') && annotations.length === 0) {
      this.sendFailure(client, invocation, 'This action requires annotations.');
      return;
    }

    const accepted = createHostActionStatus({
      requestId: invocation.requestId,
      actionId: invocation.actionId,
      state: 'accepted',
    });
    const record: ActionRequestRecord = { actionId: invocation.actionId, status: accepted };
    client.actionRequests.set(invocation.requestId, record);
    this.sendClientStatus(client, accepted);

    const publish: HostActionPublisher = {
      running: message => this.publishStatus(client, record, 'running', message),
      succeeded: message => this.publishStatus(client, record, 'succeeded', message),
      failed: message => this.publishStatus(client, record, 'failed', message),
    };
    const context: HostActionHandlerContext = {
      requestId: invocation.requestId,
      actionId: invocation.actionId,
      modelVersion: invocation.modelVersion,
      annotationRevision: invocation.annotationRevision,
      annotations,
      ...(invocation.input !== undefined ? { input: structuredClone(invocation.input) } : {}),
      publish,
    };
    void Promise.resolve()
      .then(() => registration.handler(context))
      .then(result => {
        if (isTerminal(record.status.state)) {
          return;
        }
        if (result && result.status === 'accepted') {
          const next = createHostActionStatus({
            requestId: record.status.requestId,
            actionId: record.actionId,
            state: record.status.state === 'running' ? 'running' : 'accepted',
            ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
            ...(result.message !== undefined ? { message: result.message } : {}),
          });
          record.status = next;
          this.sendClientStatus(client, next);
          return;
        }
        this.publishStatus(client, record, 'succeeded', result?.message);
      })
      .catch((error: unknown) => {
        if (!isTerminal(record.status.state)) {
          this.publishStatus(client, record, 'failed', truncateMessage(errorMessage(error)));
        }
      });
  }

  private publishStatus(
    client: RoomClientState,
    record: ActionRequestRecord,
    state: 'running' | 'succeeded' | 'failed',
    message?: string,
  ): void {
    if (isTerminal(record.status.state)) {
      return;
    }
    try {
      const status = createHostActionStatus({
        requestId: record.status.requestId,
        actionId: record.actionId,
        state,
        ...(record.status.operationId !== undefined ? { operationId: record.status.operationId } : {}),
        ...(message !== undefined ? { message } : {}),
      });
      record.status = status;
      this.sendClientStatus(client, status);
    } catch (error) {
      const status = createHostActionStatus({
        requestId: record.status.requestId,
        actionId: record.actionId,
        state: 'failed',
        message: truncateMessage(errorMessage(error)),
      });
      record.status = status;
      this.sendClientStatus(client, status);
    }
  }

  private sendFailure(
    client: RoomClientState,
    invocation: Pick<HostActionInvocationMessage, 'requestId' | 'actionId'>,
    message: string,
  ): void {
    const status = createHostActionStatus({
      requestId: invocation.requestId,
      actionId: invocation.actionId,
      state: 'failed',
      message: truncateMessage(message),
    });
    if (!client.actionRequests.has(invocation.requestId) && client.actionRequests.size < MAX_ACTION_REQUESTS) {
      client.actionRequests.set(invocation.requestId, { actionId: invocation.actionId, status });
    }
    this.sendClientStatus(client, status);
  }

  private reserveRequestCapacity(client: RoomClientState): boolean {
    if (client.actionRequests.size < MAX_ACTION_REQUESTS) {
      return true;
    }
    for (const [requestId, record] of client.actionRequests) {
      if (isTerminal(record.status.state)) {
        client.actionRequests.delete(requestId);
        return true;
      }
    }
    return false;
  }

  private broadcastManifest(): void {
    if (this.closed) {
      return;
    }
    for (const client of this.clientsById.values()) {
      if (client.socket) {
        this.sendManifest(client.socket);
      }
    }
  }

  private sendManifest(socket: WebSocket): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    const manifest = createHostActionsManifest([...this.actions.values()].map(action => action.descriptor));
    socket.send(JSON.stringify(manifest));
  }

  private sendClientStatus(client: RoomClientState, status: HostActionStatusMessage): void {
    if (client.socket) {
      this.sendStatus(client.socket, status);
    }
  }

  private sendStatus(socket: WebSocket, status: HostActionStatusMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(status));
    }
  }

  private issueResumeToken(client: RoomClientState, presentedToken?: string): string {
    let token: string;
    do {
      token = randomToken(32);
    } while (this.clientsByResumeToken.has(token));
    client.currentResumeToken = token;
    client.resumeTokenAliases.push(token);
    this.clientsByResumeToken.set(token, client);

    while (client.resumeTokenAliases.length > MAX_UNACKNOWLEDGED_RESUME_TOKENS) {
      const removableIndex = client.resumeTokenAliases.findIndex(alias => alias !== token && alias !== presentedToken);
      if (removableIndex < 0) {
        break;
      }
      const [removed] = client.resumeTokenAliases.splice(removableIndex, 1);
      if (removed !== undefined) {
        this.clientsByResumeToken.delete(removed);
      }
    }
    return token;
  }

  private acknowledgeResumeToken(client: RoomClientState, token: string): void {
    if (client.currentResumeToken !== token) {
      this.logger.warn('[viewer-host] rejected acknowledgement for a non-current resume token.');
      return;
    }
    for (const alias of client.resumeTokenAliases) {
      if (alias !== token) {
        this.clientsByResumeToken.delete(alias);
      }
    }
    client.resumeTokenAliases = [token];
    this.clientsByResumeToken.set(token, client);
  }

  private removeResumeTokenAliases(client: RoomClientState): void {
    for (const alias of client.resumeTokenAliases) {
      this.clientsByResumeToken.delete(alias);
    }
    client.resumeTokenAliases = [];
    client.currentResumeToken = '';
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Viewer room is closed.');
    }
  }
}

export async function startViewerHost(options: ViewerHostOptions): Promise<ViewerHost> {
  return ViewerHost.start(options);
}

export function createInMemoryViewerAssetProvider(manifest: ViewerAssetManifest): ViewerAssetProvider {
  if (manifest.size === 0 || manifest.size > MAX_VIEWER_ASSETS) {
    throw new Error(`Viewer asset manifest must contain between 1 and ${MAX_VIEWER_ASSETS} assets.`);
  }
  const assets = new Map<string, ViewerAsset>();
  let totalBytes = 0;
  for (const [path, asset] of manifest) {
    if (!isSafeAssetPath(path)) {
      throw new Error(`Viewer asset manifest path is unsafe: ${path}`);
    }
    if (!(asset.bytes instanceof Uint8Array)) {
      throw new Error(`Viewer asset "${path}" bytes must be a Uint8Array.`);
    }
    if (asset.bytes.byteLength > MAX_VIEWER_ASSET_BYTES) {
      throw new Error(`Viewer asset "${path}" exceeds ${MAX_VIEWER_ASSET_BYTES} bytes.`);
    }
    const contentType = asset.contentType === undefined ? undefined : parseContentType(asset.contentType, path);
    totalBytes += asset.bytes.byteLength;
    if (totalBytes > MAX_VIEWER_ASSET_MANIFEST_BYTES) {
      throw new Error(`Viewer asset manifest exceeds ${MAX_VIEWER_ASSET_MANIFEST_BYTES} bytes.`);
    }
    assets.set(path, {
      bytes: Buffer.from(asset.bytes),
      ...(contentType !== undefined ? { contentType } : {}),
    });
  }
  if (!assets.has('index.html')) {
    throw new Error('Viewer asset manifest must contain index.html.');
  }
  return {
    getAsset(relativePath): Promise<ViewerAsset | undefined> {
      const asset = assets.get(relativePath);
      return Promise.resolve(
        asset
          ? {
              bytes: asset.bytes,
              ...(asset.contentType !== undefined ? { contentType: asset.contentType } : {}),
            }
          : undefined,
      );
    },
  };
}

function sendModelVersion(socket: WebSocket, modelVersion: string): void {
  socket.send(JSON.stringify(createModelVersionMessage(modelVersion)));
}

function sendModel(socket: WebSocket, model: ViewerModelFrame): void {
  const header = createModelHeader(model);
  socket.send(JSON.stringify(header));
  socket.send(Buffer.from(model.vertProperties), { binary: true });
  socket.send(Buffer.from(model.triVerts), { binary: true });
  if (header.hasTriFeatureIds) {
    socket.send(Buffer.from(model.triFeatureIds), { binary: true });
  }
}

function cloneAnnotation(annotation: WireAnnotation): WireAnnotation {
  return structuredClone(annotation);
}

function annotationFingerprint(annotation: WireAnnotation): string {
  const { clientId: _clientId, ...content } = annotation;
  return JSON.stringify(content);
}

function isTerminal(state: HostActionStatusMessage['state']): boolean {
  return state === 'succeeded' || state === 'failed';
}

function truncateMessage(message: string): string {
  return message.slice(0, MAX_HOST_ACTION_MESSAGE_LENGTH);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function roomCredentialKey(roomId: string, credential: string): string {
  return `${roomId}:${credential}`;
}

function createFileViewerAssetProvider(assetRoot: string): ViewerAssetProvider {
  const root = resolvePath(assetRoot);
  return {
    async getAsset(relativePath): Promise<ViewerAsset | undefined> {
      if (!isSafeAssetPath(relativePath)) {
        return undefined;
      }
      const filePath = join(root, relativePath);
      const rel = relative(root, filePath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return undefined;
      }
      try {
        const metadata = await stat(filePath);
        if (!metadata.isFile()) {
          return undefined;
        }
        return {
          bytes: await readFile(filePath),
          contentType: mime(filePath),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return undefined;
        }
        throw error;
      }
    },
  };
}

function isSafeAssetPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function parseContentType(value: string, path: string): string {
  if (value.length === 0 || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw new Error(`Viewer asset "${path}" contentType is invalid.`);
  }
  return value;
}

function cacheControlFor(relativePath: string): string {
  if (relativePath === 'index.html' || relativePath === '') {
    return 'no-store';
  }
  if (relativePath.startsWith('assets/') || relativePath.startsWith('assets\\')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=300';
}

export const _testCacheControlFor = cacheControlFor;

function setSecurityHeaders(response: ServerResponse, origin: string, frameAncestors: readonly string[]): void {
  const webSocketOrigin = origin.replace(/^http/, 'ws');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self)');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      `frame-ancestors ${frameAncestors.join(' ')}`,
      "form-action 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      `connect-src 'self' ${webSocketOrigin}`,
      "worker-src 'self' blob:",
    ].join('; '),
  );
}

function parseFrameAncestors(values: readonly string[] | undefined, allowAny: boolean): readonly string[] {
  if (allowAny) {
    if (values && values.length > 0) {
      throw new Error('allowAnyFrameAncestor cannot be combined with frameAncestors.');
    }
    return ['*'];
  }
  if (!values || values.length === 0) {
    return ["'none'"];
  }
  const parsed = values.map((value, index) => {
    if (value === "'self'") {
      return value;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`frameAncestors[${index}] must be 'self' or an exact HTTP(S) origin.`);
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hostname.includes('*') ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(`frameAncestors[${index}] must be 'self' or an exact HTTP(S) origin.`);
    }
    return url.origin;
  });
  return [...new Set(parsed)];
}

function isResumeToken(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function mime(path: string): string {
  if (path.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (path.endsWith('.js') || path.endsWith('.mjs')) {
    return 'text/javascript; charset=utf-8';
  }
  if (path.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (path.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (path.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (path.endsWith('.png')) {
    return 'image/png';
  }
  if (path.endsWith('.woff2')) {
    return 'font/woff2';
  }
  return 'application/octet-stream';
}

async function findFreePort(start: number, host: string): Promise<number> {
  for (let port = start; port < start + 50; port += 1) {
    if (await isFree(port, host)) {
      return port;
    }
  }
  throw new Error(`No free port in range ${start}-${start + 50}`);
}

function isFree(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function closeHttp(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawDataByteLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
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

const stderrLogger: ViewerHostLogger = {
  error(message) {
    process.stderr.write(`${message}\n`);
  },
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};
