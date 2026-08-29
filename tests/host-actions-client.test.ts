import { describe, expect, it } from 'vitest';

import { createAnnotationsMessage } from '../packages/protocol/src/wire/annotations.js';
import {
  createHostActionStatus,
  createHostActionsManifest,
  type HostActionDescriptor,
} from '../packages/protocol/src/wire/host-actions.js';
import {
  HostActionsClient,
  getLatestHostActionStatus,
  hasPendingHostActionRequest,
  hostActionDisabledReason,
} from '../packages/viewer/src/host-actions/client.js';

const action: HostActionDescriptor = {
  id: 'review-model',
  label: 'Review model',
  icon: 'check',
  slot: 'toolbar',
  tone: 'default',
  requires: ['model', 'annotations'],
};

describe('HostActionsClient', () => {
  it('flushes the revisioned annotation snapshot before sending an invocation', () => {
    const sent: unknown[] = [];
    const annotations = createAnnotationsMessage('v1', 7, []);
    const client = new HostActionsClient({
      send: message => sent.push(message),
      isOpen: () => true,
      flushAnnotations: () => {
        sent.push(annotations);
        return true;
      },
      getInvocationContext: () => ({
        modelVersion: 'v1',
        annotationRevision: 7,
      }),
      createRequestId: () => 'request-1',
    });
    client.setConnectionStatus('connected');
    client.receiveManifest(createHostActionsManifest([action]));

    expect(client.invoke(action.id)).toBe('request-1');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(annotations);
    expect(sent[1]).toMatchObject({
      kind: 'host_action_invoke',
      requestId: 'request-1',
      modelVersion: 'v1',
      annotationRevision: 7,
    });
    expect(sent[1]).not.toHaveProperty('annotationIds');
  });

  it('derives disabled states from connection, protocol, preconditions, and pending status', () => {
    const ready = {
      connected: true,
      protocolReady: true,
      hasModel: true,
      annotationCount: 1,
      pending: false,
    };
    expect(hostActionDisabledReason(action, ready)).toBeUndefined();
    expect(hostActionDisabledReason(action, { ...ready, connected: false })).toMatch(/disconnected/);
    expect(hostActionDisabledReason(action, { ...ready, protocolReady: false })).toMatch(/not ready/);
    expect(hostActionDisabledReason(action, { ...ready, hasModel: false })).toMatch(/requires a model/);
    expect(hostActionDisabledReason(action, { ...ready, annotationCount: 0 })).toMatch(/requires annotations/);
    expect(hostActionDisabledReason(action, { ...ready, pending: true })).toMatch(/already running/);
    expect(hostActionDisabledReason({ ...action, disabledReason: 'Disabled by host' }, ready)).toBe('Disabled by host');
  });

  it('tracks accepted, running, succeeded, and failed status broadcasts', () => {
    const client = new HostActionsClient({
      send: () => undefined,
      isOpen: () => true,
      flushAnnotations: () => true,
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
    });
    client.receiveManifest(createHostActionsManifest([action]));

    for (const state of ['accepted', 'running', 'succeeded', 'failed'] as const) {
      const status = createHostActionStatus({
        requestId: `request-${state}`,
        actionId: action.id,
        state,
        message: state,
      });
      client.receiveStatus(status);
      expect(client.getSnapshot().statuses[status.requestId]).toEqual(status);
      expect(client.getSnapshot().latestStatus).toEqual(status);
    }
  });

  it('waits for the terminal status of the exact invoked request', async () => {
    const client = new HostActionsClient({
      send: () => undefined,
      isOpen: () => true,
      flushAnnotations: () => true,
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
      createRequestId: () => 'wait-request',
    });
    client.receiveManifest(createHostActionsManifest([action]));

    const terminal = client.invokeAndWait(action.id);
    client.receiveStatus(
      createHostActionStatus({
        requestId: 'other-request',
        actionId: action.id,
        state: 'succeeded',
      }),
    );
    let settled = false;
    void terminal.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const expected = createHostActionStatus({
      requestId: 'wait-request',
      actionId: action.id,
      state: 'succeeded',
    });
    client.receiveStatus(expected);
    await expect(terminal).resolves.toEqual(expected);
  });

  it('returns immediate local failures and rejects pending waits on disposal', async () => {
    const localFailure = new HostActionsClient({
      send: () => undefined,
      isOpen: () => true,
      flushAnnotations: () => false,
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
      createRequestId: () => 'local-failure',
    });
    localFailure.receiveManifest(createHostActionsManifest([action]));
    await expect(localFailure.invokeAndWait(action.id)).resolves.toMatchObject({
      requestId: 'local-failure',
      state: 'failed',
    });

    const pending = createClient();
    pending.receiveManifest(createHostActionsManifest([action]));
    const wait = pending.invokeAndWait(action.id);
    pending.dispose();
    await expect(wait).rejects.toThrow(/disposed/);
  });

  it('tracks concurrent requests for one action and derives pending/latest state', () => {
    const client = createClient();
    client.receiveManifest(createHostActionsManifest([action]));
    const first = createHostActionStatus({
      requestId: 'request-1',
      actionId: action.id,
      state: 'running',
    });
    const second = createHostActionStatus({
      requestId: 'request-2',
      actionId: action.id,
      state: 'succeeded',
    });
    client.receiveStatus(first);
    client.receiveStatus(second);

    expect(Object.keys(client.getSnapshot().statuses)).toEqual(['request-1', 'request-2']);
    expect(getLatestHostActionStatus(client.getSnapshot(), action.id)).toEqual(second);
    expect(hasPendingHostActionRequest(client.getSnapshot(), action.id)).toBe(true);
    client.receiveStatus({ ...first, state: 'succeeded' });
    expect(hasPendingHostActionRequest(client.getSnapshot(), action.id)).toBe(false);
  });

  it('keeps resumed state for replay and clears stale optimistic state for a new identity', () => {
    const client = createClient();
    client.receiveManifest(createHostActionsManifest([action]));
    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-1',
      resumed: false,
    });
    client.receiveStatus(
      createHostActionStatus({
        requestId: 'optimistic',
        actionId: action.id,
        state: 'accepted',
        message: 'Sending…',
      }),
    );
    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-2',
      resumed: true,
    });
    expect(client.getSnapshot().statuses.optimistic).toBeDefined();
    client.receiveStatus(
      createHostActionStatus({
        requestId: 'optimistic',
        actionId: action.id,
        state: 'succeeded',
        message: 'replayed',
      }),
    );
    expect(client.getSnapshot().statuses.optimistic?.state).toBe('succeeded');

    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-2',
      resumeToken: 'token-3',
      resumed: false,
    });
    expect(client.getSnapshot().statuses).toEqual({});
    expect(client.getSnapshot().latestStatus).toBeNull();
  });

  it('rejects terminal waiters when reconnect cannot resume the client identity', async () => {
    const client = new HostActionsClient({
      send: () => undefined,
      isOpen: () => true,
      flushAnnotations: () => true,
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
      createRequestId: () => 'identity-request',
    });
    client.receiveHello({ kind: 'hello', protocolVersion: 1, clientId: 'client-1' });
    client.receiveManifest(createHostActionsManifest([action]));
    const terminal = client.invokeAndWait(action.id);

    client.receiveHello({ kind: 'hello', protocolVersion: 1, clientId: 'client-2' });

    await expect(terminal).rejects.toThrow(/identity changed/);
  });

  it('surfaces invocation construction and flush errors as failed status instead of throwing', () => {
    const sent: unknown[] = [];
    const client = new HostActionsClient({
      send: message => sent.push(message),
      isOpen: () => true,
      flushAnnotations: () => true,
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
      createRequestId: () => 'invalid-request',
    });
    client.receiveManifest(createHostActionsManifest([action]));
    expect(() =>
      client.invoke(action.id, { annotationIds: Array.from({ length: 129 }, (_, index) => `ann-${index}`) }),
    ).not.toThrow();
    expect(client.getSnapshot().statuses['invalid-request']).toMatchObject({
      state: 'failed',
      message: expect.stringMatching(/at most 128/),
    });
    expect(sent).toEqual([]);

    const flushFailure = new HostActionsClient({
      send: () => undefined,
      isOpen: () => true,
      flushAnnotations: () => {
        throw new Error('serialization failed');
      },
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
      createRequestId: () => 'flush-request',
    });
    flushFailure.receiveManifest(createHostActionsManifest([action]));
    expect(() => flushFailure.invoke(action.id)).not.toThrow();
    expect(flushFailure.getSnapshot().statuses['flush-request']).toMatchObject({
      state: 'failed',
      message: 'serialization failed',
    });
  });

  it('retransmits an invocation lost before server receipt with the same requestId after a safe flush', () => {
    const ordered: unknown[] = [];
    const client = new HostActionsClient({
      send: message => ordered.push(message),
      isOpen: () => true,
      flushAnnotations: () => {
        ordered.push('annotations-flushed');
        return true;
      },
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 4 }),
      createRequestId: () => 'lost-request',
    });
    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-1',
      resumed: false,
    });
    client.receiveManifest(createHostActionsManifest([action]));
    client.invoke(action.id);
    const original = ordered[1];
    ordered.length = 0;

    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-2',
      resumed: true,
    });
    expect(ordered).toEqual(['annotations-flushed', original]);
    expect(ordered[1]).toMatchObject({ requestId: 'lost-request' });
  });

  it('retransmits accepted requests but removes terminal requests from replay', () => {
    const sent: unknown[] = [];
    const client = new HostActionsClient({
      send: message => sent.push(message),
      isOpen: () => true,
      flushAnnotations: () => true,
      getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
      createRequestId: () => 'accepted-request',
    });
    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-1',
      resumed: false,
    });
    client.receiveManifest(createHostActionsManifest([action]));
    client.invoke(action.id);
    client.receiveStatus(
      createHostActionStatus({
        requestId: 'accepted-request',
        actionId: action.id,
        state: 'accepted',
      }),
    );
    sent.length = 0;
    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-2',
      resumed: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'accepted-request' });

    client.receiveStatus(
      createHostActionStatus({
        requestId: 'accepted-request',
        actionId: action.id,
        state: 'succeeded',
      }),
    );
    sent.length = 0;
    client.receiveHello({
      kind: 'hello',
      protocolVersion: 1,
      clientId: 'client-1',
      resumeToken: 'token-3',
      resumed: true,
    });
    expect(sent).toEqual([]);
  });
});

function createClient(): HostActionsClient {
  return new HostActionsClient({
    send: () => undefined,
    isOpen: () => true,
    flushAnnotations: () => true,
    getInvocationContext: () => ({ modelVersion: 'v1', annotationRevision: 0 }),
  });
}
