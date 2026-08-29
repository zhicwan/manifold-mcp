import { describe, expect, it } from 'vitest';

import {
  HOST_ACTION_PROTOCOL_VERSION,
  MAX_HOST_ACTION_INPUT_BYTES,
  createHostActionInvocation,
  createHostActionStatus,
  createHostActionsManifest,
  isHostActionInvocation,
  isHostActionStatus,
  isHostActionsManifest,
  isSafeJsonValue,
  parseHostActionInvocation,
  type HostActionDescriptor,
} from '../packages/protocol/src/wire/host-actions.js';

const descriptor: HostActionDescriptor = {
  id: 'send-feedback',
  label: 'Send feedback',
  icon: 'message',
  slot: 'annotation-footer',
  tone: 'primary',
  requires: ['model', 'annotations'],
};

describe('host action wire protocol', () => {
  it('accepts versioned safe descriptors, invocations, and statuses', () => {
    const manifest = createHostActionsManifest([descriptor]);
    const invocation = createHostActionInvocation({
      requestId: 'request-1',
      actionId: descriptor.id,
      modelVersion: 'v1',
      annotationRevision: 3,
      annotationIds: ['ann-1'],
      input: { prompt: 'Please revise', count: 1, flags: [true, null] },
    });
    const status = createHostActionStatus({
      requestId: 'request-1',
      actionId: descriptor.id,
      state: 'running',
      operationId: 'operation-1',
      message: 'Working',
    });

    expect(manifest.protocolVersion).toBe(HOST_ACTION_PROTOCOL_VERSION);
    expect(isHostActionsManifest(manifest)).toBe(true);
    expect(isHostActionInvocation(invocation)).toBe(true);
    expect(isHostActionStatus(status)).toBe(true);
  });

  it('rejects executable/remote descriptor fields and unknown enums', () => {
    expect(
      isHostActionsManifest({ ...createHostActionsManifest([]), actions: [{ ...descriptor, url: 'https://x' }] }),
    ).toBe(false);
    expect(
      isHostActionsManifest({ ...createHostActionsManifest([]), actions: [{ ...descriptor, icon: 'custom-svg' }] }),
    ).toBe(false);
    expect(
      isHostActionsManifest({
        ...createHostActionsManifest([]),
        actions: [{ ...descriptor, render: '<button onclick="x()">x</button>' }],
      }),
    ).toBe(false);
  });

  it('rejects unsafe JSON, dangerous keys, cycles, and oversized input', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(isSafeJsonValue(cycle)).toBe(false);
    expect(isSafeJsonValue({ value: Number.NaN })).toBe(false);
    expect(isSafeJsonValue(Object.create({ inherited: true }))).toBe(false);
    expect(isSafeJsonValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);

    expect(() =>
      parseHostActionInvocation({
        kind: 'host_action_invoke',
        protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
        requestId: 'request-1',
        actionId: descriptor.id,
        modelVersion: 'v1',
        annotationRevision: 0,
        input: 'x'.repeat(MAX_HOST_ACTION_INPUT_BYTES + 1),
      }),
    ).toThrow(/safe JSON/);
  });

  it('rejects missing versions, room identity, duplicate ids, and invalid revisions', () => {
    expect(isHostActionInvocation({ kind: 'host_action_invoke' })).toBe(false);
    expect(
      isHostActionInvocation({
        ...createHostActionInvocation({
          requestId: 'request-1',
          actionId: descriptor.id,
          modelVersion: 'v1',
          annotationRevision: 0,
        }),
        roomId: 'untrusted-room',
      }),
    ).toBe(false);
    expect(
      isHostActionInvocation({
        ...createHostActionInvocation({
          requestId: 'request-1',
          actionId: descriptor.id,
          modelVersion: 'v1',
          annotationRevision: 0,
        }),
        annotationRevision: -1,
      }),
    ).toBe(false);
    expect(isHostActionsManifest({ ...createHostActionsManifest([]), actions: [descriptor, descriptor] })).toBe(false);
  });
});
