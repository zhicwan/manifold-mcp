import {
  createHostActionInvocation,
  createHostActionStatus,
  MAX_HOST_ACTION_MESSAGE_LENGTH,
  type HostActionDescriptor,
  type HostActionInvocationMessage,
  type HostActionStatusMessage,
  type HostActionsManifestMessage,
  type JsonValue,
} from '@manifold3d/protocol/wire/host-actions.js';
import type { HelloMessage } from '@manifold3d/protocol/wire/model.js';
import type { ConnectionStatus } from '../transport/ws-client.js';

export type HostActionsProtocolState = 'awaiting-manifest' | 'ready' | 'error';

export interface HostActionsSnapshot {
  actions: readonly HostActionDescriptor[];
  /** Request-scoped status records keyed by requestId. */
  statuses: Readonly<Record<string, HostActionStatusMessage>>;
  requestOrder: readonly string[];
  latestStatus: HostActionStatusMessage | null;
  clientId: string | null;
  connected: boolean;
  protocolState: HostActionsProtocolState;
}

export interface HostActionInvocationContext {
  modelVersion: string;
  annotationRevision: number;
}

export interface HostActionInvokeOptions {
  /** Explicit bounded subset. Omit to let the server use the full committed snapshot. */
  annotationIds?: readonly string[];
  input?: JsonValue;
}

export interface HostActionsClientOptions {
  send(message: unknown): void;
  isOpen(): boolean;
  flushAnnotations(): boolean;
  getInvocationContext(): HostActionInvocationContext;
  createRequestId?: () => string;
}

export interface HostActionAvailability {
  connected: boolean;
  protocolReady: boolean;
  hasModel: boolean;
  annotationCount: number;
  pending: boolean;
}

type Listener = () => void;

const INITIAL_SNAPSHOT: HostActionsSnapshot = {
  actions: [],
  statuses: {},
  requestOrder: [],
  latestStatus: null,
  clientId: null,
  connected: false,
  protocolState: 'awaiting-manifest',
};

export class HostActionsClient {
  private readonly listeners = new Set<Listener>();
  private readonly retainedInvocations = new Map<string, HostActionInvocationMessage>();
  private readonly terminalWaiters = new Map<
    string,
    {
      resolve(status: HostActionStatusMessage): void;
      reject(error: Error): void;
    }
  >();
  private snapshot: HostActionsSnapshot = INITIAL_SNAPSHOT;

  constructor(private readonly options: HostActionsClientOptions) {}

  getSnapshot = (): HostActionsSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setConnectionStatus(status: ConnectionStatus): void {
    const connected = status === 'connected';
    const protocolState =
      status === 'protocol-error' ? 'error' : connected ? this.snapshot.protocolState : 'awaiting-manifest';
    this.update({ ...this.snapshot, connected, protocolState });
  }

  setProtocolError(): void {
    this.update({ ...this.snapshot, protocolState: 'error' });
  }

  receiveHello(message: HelloMessage): void {
    const resumed = message.resumed === true && this.snapshot.clientId === message.clientId;
    if (!resumed) {
      this.retainedInvocations.clear();
      for (const waiter of this.terminalWaiters.values()) {
        waiter.reject(new Error('Viewer Host client identity changed before the request completed.'));
      }
      this.terminalWaiters.clear();
      this.update({
        ...this.snapshot,
        statuses: {},
        requestOrder: [],
        latestStatus: null,
        clientId: message.clientId,
      });
      return;
    }
    this.update({ ...this.snapshot, clientId: message.clientId });
    if (resumed) {
      this.retransmitNonterminalInvocations();
    }
  }

  receiveManifest(manifest: HostActionsManifestMessage): void {
    const actionIds = new Set(manifest.actions.map(action => action.id));
    const statuses = Object.fromEntries(
      Object.entries(this.snapshot.statuses).filter(([, status]) => actionIds.has(status.actionId)),
    );
    const requestOrder = this.snapshot.requestOrder.filter(requestId => statuses[requestId] !== undefined);
    const latestStatus = latestStatusInOrder(statuses, requestOrder);
    this.update({
      ...this.snapshot,
      actions: manifest.actions,
      statuses,
      requestOrder,
      latestStatus,
      connected: this.options.isOpen(),
      protocolState: 'ready',
    });
  }

  receiveStatus(status: HostActionStatusMessage): void {
    if (status.state === 'succeeded' || status.state === 'failed') {
      this.retainedInvocations.delete(status.requestId);
      const waiter = this.terminalWaiters.get(status.requestId);
      if (waiter) {
        this.terminalWaiters.delete(status.requestId);
        waiter.resolve(status);
      }
    }
    this.update({
      ...this.snapshot,
      statuses: { ...this.snapshot.statuses, [status.requestId]: status },
      requestOrder: [
        ...this.snapshot.requestOrder.filter(requestId => requestId !== status.requestId),
        status.requestId,
      ],
      latestStatus: status,
    });
  }

  invoke(actionId: string, options: HostActionInvokeOptions = {}): string | undefined {
    const descriptor = this.snapshot.actions.find(action => action.id === actionId);
    if (!descriptor || !this.options.isOpen() || this.snapshot.protocolState !== 'ready') {
      return undefined;
    }
    const requestId = this.options.createRequestId?.() ?? createRequestId();
    try {
      if (!this.options.flushAnnotations()) {
        this.failLocally(requestId, actionId, 'Could not synchronize annotations before invoking the action.');
        return requestId;
      }
      const context = this.options.getInvocationContext();
      const invocation = createHostActionInvocation({
        requestId,
        actionId,
        modelVersion: context.modelVersion,
        annotationRevision: context.annotationRevision,
        ...(options.annotationIds !== undefined ? { annotationIds: [...options.annotationIds] } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
      });
      const retainedInvocation = structuredClone(invocation);
      this.retainedInvocations.set(requestId, retainedInvocation);
      const optimistic = createHostActionStatus({
        requestId,
        actionId,
        state: 'accepted',
        message: 'Sending…',
      });
      this.receiveStatus(optimistic);
      this.options.send(retainedInvocation);
      return requestId;
    } catch (error) {
      this.failLocally(requestId, actionId, errorMessage(error));
      return requestId;
    }
  }

  invokeAndWait(actionId: string, options: HostActionInvokeOptions = {}): Promise<HostActionStatusMessage> {
    const requestId = this.invoke(actionId, options);
    if (!requestId) {
      return Promise.reject(new Error(`Host action "${actionId}" is unavailable.`));
    }
    const current = this.snapshot.statuses[requestId];
    if (current && (current.state === 'succeeded' || current.state === 'failed')) {
      return Promise.resolve(current);
    }
    return new Promise<HostActionStatusMessage>((resolve, reject) => {
      this.terminalWaiters.set(requestId, { resolve, reject });
    });
  }

  dispose(): void {
    this.retainedInvocations.clear();
    for (const waiter of this.terminalWaiters.values()) {
      waiter.reject(new Error('Host actions client was disposed before the request completed.'));
    }
    this.terminalWaiters.clear();
    this.listeners.clear();
    this.snapshot = INITIAL_SNAPSHOT;
  }

  private failLocally(requestId: string, actionId: string, message: string): void {
    this.receiveStatus(
      createHostActionStatus({
        requestId,
        actionId,
        state: 'failed',
        message: message.slice(0, MAX_HOST_ACTION_MESSAGE_LENGTH),
      }),
    );
  }

  private retransmitNonterminalInvocations(): void {
    try {
      if (!this.options.flushAnnotations()) {
        return;
      }
      for (const invocation of this.retainedInvocations.values()) {
        this.options.send(invocation);
      }
    } catch {
      // Keep the validated invocation for the next resumed reconnect.
    }
  }

  private update(next: HostActionsSnapshot): void {
    if (
      next.connected === this.snapshot.connected &&
      next.protocolState === this.snapshot.protocolState &&
      next.actions === this.snapshot.actions &&
      next.statuses === this.snapshot.statuses &&
      next.requestOrder === this.snapshot.requestOrder &&
      next.latestStatus === this.snapshot.latestStatus &&
      next.clientId === this.snapshot.clientId
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function getLatestHostActionStatus(
  snapshot: HostActionsSnapshot,
  actionId: string,
): HostActionStatusMessage | undefined {
  for (let index = snapshot.requestOrder.length - 1; index >= 0; index -= 1) {
    const requestId = snapshot.requestOrder[index];
    const status = requestId === undefined ? undefined : snapshot.statuses[requestId];
    if (status?.actionId === actionId) {
      return status;
    }
  }
  return undefined;
}

export function hasPendingHostActionRequest(snapshot: HostActionsSnapshot, actionId: string): boolean {
  return Object.values(snapshot.statuses).some(
    status => status.actionId === actionId && (status.state === 'accepted' || status.state === 'running'),
  );
}

export function hostActionDisabledReason(
  descriptor: HostActionDescriptor,
  availability: HostActionAvailability,
): string | undefined {
  if (descriptor.disabledReason) {
    return descriptor.disabledReason;
  }
  if (!availability.connected) {
    return 'Viewer Host is disconnected.';
  }
  if (!availability.protocolReady) {
    return 'Viewer Host actions are not ready.';
  }
  if (descriptor.requires.includes('model') && !availability.hasModel) {
    return 'This action requires a model.';
  }
  if (descriptor.requires.includes('annotations') && availability.annotationCount === 0) {
    return 'This action requires annotations.';
  }
  if (availability.pending) {
    return 'This action is already running.';
  }
  return undefined;
}

function latestStatusInOrder(
  statuses: Readonly<Record<string, HostActionStatusMessage>>,
  requestOrder: readonly string[],
): HostActionStatusMessage | null {
  const requestId = requestOrder.at(-1);
  return requestId === undefined ? null : (statuses[requestId] ?? null);
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
