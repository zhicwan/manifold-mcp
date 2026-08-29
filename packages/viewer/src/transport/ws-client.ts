import {
  assertModelBinaryFrame,
  createResumeTokenAckMessage,
  decodeViewerModel,
  parseHelloMessage,
  parseModelHeader,
  parseModelVersionMessage,
  ViewerProtocolError,
  type HelloMessage,
  type ModelHeader,
  type ViewerModel,
} from '@manifold3d/protocol/wire/model.js';
import {
  HostActionProtocolError,
  parseHostActionStatus,
  parseHostActionsManifest,
  type HostActionStatusMessage,
  type HostActionsManifestMessage,
} from '@manifold3d/protocol/wire/host-actions.js';

export type MeshHandler = (payload: ViewerModel) => void;
export type ModelVersionHandler = (modelVersion: string) => void;
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'protocol-error';
export type StatusHandler = (status: ConnectionStatus) => void;
export type ProtocolErrorHandler = (error: ViewerProtocolError) => void;
export type HostActionsManifestHandler = (manifest: HostActionsManifestMessage) => void;
export type HostActionStatusHandler = (status: HostActionStatusMessage) => void;
export type HelloHandler = (message: HelloMessage) => void;

export const DEFAULT_RESUME_IDENTITY = 'default';
const RESUME_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface MeshFeedHandle {
  /** Send a JSON text frame to the server. No-op if WS not open. */
  send(message: unknown): void;
  /** True iff WebSocket is in OPEN state. */
  isOpen(): boolean;
  /**
   * Permanently stop the feed: cancels any pending reconnect timer,
   * gates future onclose handlers from firing reconnects, and closes
   * the active socket. Safe to call multiple times. After close() the
   * handle is inert.
   */
  close(): void;
}

export interface ConnectOptions {
  onMesh: MeshHandler;
  /** Stable per-ViewerApp storage namespace. Defaults to "default". */
  resumeIdentity?: string;
  onModelVersion?: ModelVersionHandler;
  onHostActionsManifest?: HostActionsManifestHandler;
  onHostActionStatus?: HostActionStatusHandler;
  onHello?: HelloHandler;
  /** Reports malformed JSON, unsupported versions, and inconsistent binary frames. */
  onError?: ProtocolErrorHandler;
  /**
   * Fired every time the WebSocket transitions into the OPEN state,
   * including after auto-reconnect. Use it to re-push any client state
   * the server should know about (e.g. the marks subsystem re-flushes
   * its annotation snapshot here so edits made while disconnected are
   * not silently lost).
   */
  onOpen?: () => void;
  /**
   * Fired whenever the WebSocket connection state changes.
   * 'connecting' is reported the moment open() starts (including each
   * reconnect attempt); 'connected' on successful onopen; 'disconnected'
   * on close/error. Used by the Viewer status indicator.
   * Repeats of the same status are suppressed.
   */
  onStatusChange?: StatusHandler;
}

export interface ModelFrameReceiver {
  receiveText(text: string): void;
  receiveBinary(buffer: ArrayBuffer): void;
  reset(): void;
}

/**
 * Stateful model frame decoder. Kept separate from WebSocket lifecycle code
 * so header/buffer validation is deterministic and directly testable.
 */
export function createModelFrameReceiver(
  callbacks: Pick<
    ConnectOptions,
    'onMesh' | 'onModelVersion' | 'onHostActionsManifest' | 'onHostActionStatus' | 'onHello' | 'onError'
  >,
): ModelFrameReceiver {
  let pendingHeader: ModelHeader | null = null;
  let pendingVerts: ArrayBuffer | null = null;
  let pendingTris: ArrayBuffer | null = null;

  const reset = (): void => {
    pendingHeader = null;
    pendingVerts = null;
    pendingTris = null;
  };

  const report = (error: unknown): void => {
    const protocolError =
      error instanceof ViewerProtocolError
        ? error
        : new ViewerProtocolError(error instanceof Error ? error.message : String(error));
    if (callbacks.onError) {
      callbacks.onError(protocolError);
    } else {
      console.error('[viewer protocol]', protocolError);
    }
  };

  const emit = (triFeatureIds?: ArrayBuffer): void => {
    if (!pendingHeader || !pendingVerts || !pendingTris) {
      return;
    }
    try {
      callbacks.onMesh(
        decodeViewerModel(pendingHeader, {
          vertProperties: pendingVerts,
          triVerts: pendingTris,
          ...(triFeatureIds !== undefined ? { triFeatureIds } : {}),
        }),
      );
    } catch (error) {
      report(error);
    } finally {
      reset();
    }
  };

  return {
    receiveText(text: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        report(new ViewerProtocolError('Preview server sent malformed JSON.'));
        reset();
        return;
      }

      const kind =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { kind?: unknown }).kind
          : undefined;
      if (kind === 'mesh') {
        if (pendingHeader) {
          report(new ViewerProtocolError('Preview server started a new model before completing the previous frame.'));
          reset();
        }
        try {
          pendingHeader = parseModelHeader(parsed);
        } catch (error) {
          report(error);
          reset();
        }
        return;
      }
      if (kind === 'model_version') {
        try {
          callbacks.onModelVersion?.(parseModelVersionMessage(parsed).modelVersion);
        } catch (error) {
          report(error);
        }
        return;
      }
      if (kind === 'hello') {
        try {
          callbacks.onHello?.(parseHelloMessage(parsed));
        } catch (error) {
          report(error);
        }
        return;
      }
      if (kind === 'host_actions_manifest') {
        try {
          callbacks.onHostActionsManifest?.(parseHostActionsManifest(parsed));
        } catch (error) {
          report(error instanceof HostActionProtocolError ? new ViewerProtocolError(error.message) : error);
        }
        return;
      }
      if (kind === 'host_action_status') {
        try {
          callbacks.onHostActionStatus?.(parseHostActionStatus(parsed));
        } catch (error) {
          report(error instanceof HostActionProtocolError ? new ViewerProtocolError(error.message) : error);
        }
      }
    },
    receiveBinary(buffer: ArrayBuffer): void {
      if (!pendingHeader) {
        report(new ViewerProtocolError('Preview server sent a binary model frame without a valid header.'));
        return;
      }

      try {
        if (!pendingVerts) {
          assertModelBinaryFrame(pendingHeader, 'vertProperties', buffer);
          pendingVerts = buffer;
          return;
        }
        if (!pendingTris) {
          assertModelBinaryFrame(pendingHeader, 'triVerts', buffer);
          pendingTris = buffer;
          if (!pendingHeader.hasTriFeatureIds) {
            emit();
          }
          return;
        }
        assertModelBinaryFrame(pendingHeader, 'triFeatureIds', buffer);
        emit(buffer);
      } catch (error) {
        report(error);
        reset();
      }
    },
    reset,
  };
}

/**
 * Reconnect tuning:
 *   - Exponential base 2 backoff starting at 1s, capped at 30s.
 *   - ±25% jitter applied to each delay so a fleet of viewers reopened
 *     simultaneously (e.g. server restart) doesn't thunder the socket.
 *   - Pause attempts entirely when the tab is hidden (visibilitychange);
 *     fire one immediate retry the moment it comes back to foreground.
 *   - After RECONNECT_MAX_ATTEMPTS consecutive failures we stop trying.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.25;
const RECONNECT_MAX_ATTEMPTS = 100;

/**
 * Open a WebSocket to /ws and invoke `onMesh` whenever the server
 * delivers a complete model, and `onModelVersion` whenever the server
 * announces a new model version. Auto-reconnects with backoff + jitter.
 */
export function connectMeshFeed(opts: ConnectOptions): MeshFeedHandle {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let closed = false;
  let reconnectAttempts = 0;
  let lastStatus: ConnectionStatus | null = null;
  const storageKey = resumeStorageKey(location.href, opts.resumeIdentity);
  let resumeToken = readResumeToken(storageKey);
  let receiver: ModelFrameReceiver | null = null;

  const setStatus = (status: ConnectionStatus): void => {
    if (closed || lastStatus === status) {
      return;
    }
    lastStatus = status;
    opts.onStatusChange?.(status);
  };

  const computeBackoff = (attempt: number): number => {
    const exp = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    const jitter = exp * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(exp + jitter));
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(open, computeBackoff(reconnectAttempts));
  };

  const open = (): void => {
    if (closed || socket !== null) {
      return;
    }
    reconnectTimer = undefined;
    receiver?.reset();
    setStatus('connecting');
    const ws = new WebSocket(buildViewerWebSocketUrl(location.href, resumeToken));
    const connectionReceiver = createModelFrameReceiver({
      ...opts,
      onHello(message): void {
        resumeToken = message.resumeToken;
        writeResumeToken(storageKey, message.resumeToken);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(createResumeTokenAckMessage(message.resumeToken)));
        }
        opts.onHello?.(message);
      },
    });
    receiver = connectionReceiver;
    socket = ws;
    ws.binaryType = 'arraybuffer';
    const isCurrentConnection = (): boolean => !closed && socket === ws && receiver === connectionReceiver;
    const detachHandlers = (): void => {
      ws.onmessage = null;
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
    };
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (!isCurrentConnection()) {
        return;
      }
      if (typeof event.data === 'string') {
        connectionReceiver.receiveText(event.data);
      } else {
        connectionReceiver.receiveBinary(event.data);
      }
    };
    ws.onopen = () => {
      if (!isCurrentConnection()) {
        detachHandlers();
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        return;
      }
      reconnectAttempts = 0;
      setStatus('connected');
      opts.onOpen?.();
    };
    ws.onclose = () => {
      if (!isCurrentConnection()) {
        connectionReceiver.reset();
        detachHandlers();
        return;
      }
      socket = null;
      receiver = null;
      connectionReceiver.reset();
      detachHandlers();
      setStatus('disconnected');
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (isCurrentConnection()) {
        ws.close();
      }
    };
  };

  const onVisibilityChange = (): void => {
    if (closed) {
      return;
    }
    if (document.visibilityState === 'visible' && socket === null) {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      try {
        open();
      } catch (error) {
        closed = true;
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        throw error;
      }
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  open();

  return {
    send(message: unknown): void {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    isOpen(): boolean {
      return socket !== null && socket.readyState === WebSocket.OPEN;
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const activeSocket = socket;
      const activeReceiver = receiver;
      socket = null;
      receiver = null;
      activeReceiver?.reset();
      if (activeSocket) {
        activeSocket.onmessage = null;
        activeSocket.onopen = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        try {
          activeSocket.close();
        } catch {
          // Ignore close races.
        }
      }
    },
  };
}

export function buildViewerWebSocketUrl(pageUrl: string, resumeToken?: string): string {
  const url = new URL('./ws', pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  if (resumeToken !== undefined) {
    url.searchParams.set('resume', resumeToken);
  }
  url.hash = '';
  return url.href;
}

export function resumeStorageKey(pageUrl: string, resumeIdentity = DEFAULT_RESUME_IDENTITY): string {
  const identity = validateResumeIdentity(resumeIdentity);
  const url = new URL(pageUrl);
  const slash = url.pathname.lastIndexOf('/');
  const roomPath = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, slash + 1);
  return `manifold3d-viewer:resume:${url.origin}${roomPath}:${identity}`;
}

export function validateResumeIdentity(resumeIdentity: string): string {
  if (!RESUME_IDENTITY_PATTERN.test(resumeIdentity)) {
    throw new TypeError('Viewer resumeIdentity must be 1-64 URL-safe namespace characters.');
  }
  return resumeIdentity;
}

export function readResumeToken(
  key: string,
  storage: Pick<Storage, 'getItem'> | undefined = safeSessionStorage(),
): string | undefined {
  if (!storage) {
    return undefined;
  }
  try {
    const value = storage.getItem(key);
    return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeResumeToken(
  key: string,
  value: string,
  storage: Pick<Storage, 'setItem'> | undefined = safeSessionStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in sandboxed/private browsing contexts.
  }
}

function safeSessionStorage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}
