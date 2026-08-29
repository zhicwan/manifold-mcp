import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { createAnnotationsMessage, type WireAnnotation } from '../packages/protocol/src/wire/annotations.js';
import { createHostActionInvocation } from '../packages/protocol/src/wire/host-actions.js';
import { createResumeTokenAckMessage, type ViewerModelFrame } from '../packages/protocol/src/wire/model.js';
import {
  createInMemoryViewerAssetProvider,
  MAX_CLIENT_TEXT_BYTES,
  MAX_UNACKNOWLEDGED_RESUME_TOKENS,
  MAX_VIEWER_ASSET_MANIFEST_BYTES,
  startViewerHost,
  type HostActionPublisher,
  type ViewerHost,
  type ViewerRoom,
} from '../packages/viewer-host/src/viewer-host.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Viewer Host rooms', () => {
  let host: ViewerHost;

  beforeEach(async () => {
    host = await startViewerHost({
      assetRoot: join(repoRoot, 'packages', 'viewer'),
      preferredPort: 0,
      logger: { error: () => undefined, warn: () => undefined },
    });
  });

  afterEach(async () => {
    await host.close();
  });

  it('authenticates HTTP and WS room access and sends security headers', async () => {
    const room = host.createRoom();
    const good = await fetch(room.url);
    expect(good.status).toBe(200);
    expect(good.headers.get('referrer-policy')).toBe('no-referrer');
    expect(good.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(good.headers.get('access-control-allow-origin')).toBeNull();

    const badUrl = new URL(room.url);
    const segments = badUrl.pathname.split('/');
    segments[3] = `${segments[3]}bad`;
    badUrl.pathname = segments.join('/');
    expect((await fetch(badUrl)).status).toBe(404);

    const wrongOrigin = await attemptWebSocket(`${room.url.replace(/^http/, 'ws')}ws`, 'http://evil.example.com');
    expect(wrongOrigin).not.toBe('open');
    const badToken = await attemptWebSocket(`${badUrl.href.replace(/^http/, 'ws')}ws`, host.origin);
    expect(badToken).not.toBe('open');
  });

  it('allows only validated explicit frame ancestor origins when configured', async () => {
    const embeddedHost = await startViewerHost({
      assetRoot: join(repoRoot, 'packages', 'viewer'),
      preferredPort: 0,
      frameAncestors: ["'self'", 'https://canvas.example.com'],
      logger: { error: () => undefined, warn: () => undefined },
    });
    try {
      const response = await fetch(embeddedHost.createRoom().url);
      expect(response.headers.get('content-security-policy')).toContain(
        "frame-ancestors 'self' https://canvas.example.com",
      );
    } finally {
      await embeddedHost.close();
    }
    await expect(
      startViewerHost({
        assetRoot: join(repoRoot, 'packages', 'viewer'),
        preferredPort: 0,
        frameAncestors: ['https://canvas.example.com; script-src *'],
      }),
    ).rejects.toThrow(/exact HTTP/);
    await expect(
      startViewerHost({
        assetRoot: join(repoRoot, 'packages', 'viewer'),
        preferredPort: 0,
        frameAncestors: ['http://*'],
      }),
    ).rejects.toThrow(/exact HTTP/);
    await expect(
      startViewerHost({
        assetRoot: join(repoRoot, 'packages', 'viewer'),
        preferredPort: 0,
        frameAncestors: ['https://*.example.com'],
      }),
    ).rejects.toThrow(/exact HTTP/);
  });

  it('serves a bounded in-memory asset manifest and gates the wildcard embedding exception', async () => {
    const index = Buffer.from('<!doctype html><title>embedded</title>', 'utf8');
    const embeddedHost = await startViewerHost({
      assetProvider: createInMemoryViewerAssetProvider(
        new Map([
          ['index.html', { bytes: index, contentType: 'text/html; charset=utf-8' }],
          ['assets/app.js', { bytes: Buffer.from('export {};'), contentType: 'text/javascript; charset=utf-8' }],
        ]),
      ),
      preferredPort: 0,
      allowAnyFrameAncestor: true,
      logger: { error: () => undefined, warn: () => undefined },
    });
    try {
      const room = embeddedHost.createRoom();
      const response = await fetch(room.url);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(index);
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors *');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect((await fetch(new URL('assets/app.js', room.url))).status).toBe(200);
      expect((await fetch(new URL('assets/missing.js', room.url))).status).toBe(404);
    } finally {
      await embeddedHost.close();
    }

    expect(() =>
      createInMemoryViewerAssetProvider(
        new Map([
          [
            'index.html',
            {
              bytes: new Uint8Array(MAX_VIEWER_ASSET_MANIFEST_BYTES + 1),
            },
          ],
        ]),
      ),
    ).toThrow(/exceeds/);
    await expect(
      startViewerHost({
        assetRoot: join(repoRoot, 'packages', 'viewer'),
        preferredPort: 0,
        allowAnyFrameAncestor: true,
        frameAncestors: ['https://canvas.example.com'],
      }),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('rejects oversized WebSocket frames at the server payload limit', async () => {
    const room = host.createRoom();
    const client = await openRoom(room);
    const closed = new Promise<number>(resolve => client.socket.once('close', code => resolve(code)));
    client.socket.send('x'.repeat(MAX_CLIENT_TEXT_BYTES + 1));
    expect(await closed).toBe(1009);
  });

  it('isolates models and annotations across multiple authenticated rooms', async () => {
    const roomA = host.createRoom();
    const roomB = host.createRoom();
    roomA.pushModel(syntheticModel('room A'));
    roomB.pushModel(syntheticModel('room B'));
    const a = await openRoom(roomA);
    const b = await openRoom(roomB);
    try {
      const versionA = roomA.getAnnotations().modelVersion;
      const versionB = roomB.getAnnotations().modelVersion;
      expect(versionA).not.toBe(versionB);
      a.socket.send(JSON.stringify(createAnnotationsMessage(versionA, 1, [annotation('a1', versionA, 'A')])));
      b.socket.send(JSON.stringify(createAnnotationsMessage(versionB, 4, [annotation('b1', versionB, 'B')])));
      await eventually(() => roomA.getAnnotations().items.length === 1 && roomB.getAnnotations().items.length === 1);

      expect(roomA.getLastModel()?.description).toBe('room A');
      expect(roomB.getLastModel()?.description).toBe('room B');
      expect(roomA.getAnnotations()).toMatchObject({ revision: 1, items: [{ id: 'a1', note: 'A' }] });
      expect(roomB.getAnnotations()).toMatchObject({ revision: 4, items: [{ id: 'b1', note: 'B' }] });
    } finally {
      a.socket.terminate();
      b.socket.terminate();
    }
  });

  it('publishes accepted annotation commits with only changed item ids', async () => {
    const room = host.createRoom();
    room.pushModel(syntheticModel('annotation commits'));
    const commits: Array<{
      revision: number;
      changedAnnotationIds: string[];
      items: WireAnnotation[];
    }> = [];
    const unsubscribe = room.subscribeAnnotationCommits(commit => {
      commits.push(commit);
    });
    const client = await openRoom(room);
    try {
      const version = room.getAnnotations().modelVersion;
      client.socket.send(
        JSON.stringify(
          createAnnotationsMessage(version, 1, [
            annotation('saved', version, ''),
            annotation('unchanged', version, 'keep'),
          ]),
        ),
      );
      await eventually(() => commits.length === 1);
      expect(commits[0]).toMatchObject({
        revision: 1,
        changedAnnotationIds: ['saved', 'unchanged'],
      });

      client.socket.send(
        JSON.stringify(
          createAnnotationsMessage(version, 2, [
            annotation('saved', version, 'latest note'),
            annotation('unchanged', version, 'keep'),
          ]),
        ),
      );
      await eventually(() => commits.length === 2);
      expect(commits[1]).toMatchObject({
        revision: 2,
        changedAnnotationIds: ['saved'],
        items: expect.arrayContaining([expect.objectContaining({ id: 'saved', note: 'latest note' })]),
      });

      unsubscribe();
      client.socket.send(
        JSON.stringify(createAnnotationsMessage(version, 3, [annotation('saved', version, 'after unsubscribe')])),
      );
      await eventually(() => room.getAnnotations().revision === 3);
      expect(commits).toHaveLength(2);
    } finally {
      client.socket.terminate();
    }
  });

  it('replays the current model and empty action manifest to a newly connected room client', async () => {
    const room = host.createRoom();
    room.pushModel(syntheticModel('replayed'));
    const client = await openRoom(room);
    try {
      expect(await client.messages.waitFor(message => message.kind === 'host_actions_manifest')).toMatchObject({
        actions: [],
      });

      expect(await client.messages.waitFor(message => message.kind === 'model_version')).toMatchObject({
        modelVersion: room.getAnnotations().modelVersion,
      });
      expect(await client.messages.waitFor(message => message.kind === 'mesh')).toMatchObject({
        description: 'replayed',
      });
    } finally {
      client.socket.terminate();
    }
  });

  it('resumes one stable annotation bucket, rotates tokens, and preserves deletion', async () => {
    const room = host.createRoom();
    room.pushModel(syntheticModel('resume'));
    const first = await openRoom(room);
    const firstHello = await first.messages.waitFor(message => message.kind === 'hello');
    const firstToken = requiredString(firstHello.resumeToken);
    const clientId = requiredString(firstHello.clientId);
    const version = room.getAnnotations().modelVersion;
    first.socket.send(JSON.stringify(createResumeTokenAckMessage(firstToken)));
    first.socket.send(JSON.stringify(createAnnotationsMessage(version, 1, [annotation('kept', version, 'kept')])));
    await eventually(() => room.getAnnotations().items.length === 1);
    await closeSocket(first.socket);

    await interruptRoomResume(room, firstToken);
    const resumed = await openRoom(room, firstToken);
    const resumedHello = await resumed.messages.waitFor(message => message.kind === 'hello');
    expect(resumedHello).toMatchObject({ clientId, resumed: true, annotationRevision: 1 });
    const rotatedToken = requiredString(resumedHello.resumeToken);
    expect(rotatedToken).not.toBe(firstToken);
    expect(room.getAnnotations().items.map(item => item.id)).toEqual(['kept']);

    resumed.socket.send(JSON.stringify(createResumeTokenAckMessage(rotatedToken)));
    resumed.socket.send(JSON.stringify(createAnnotationsMessage(version, 2, [])));
    await eventually(() => room.getAnnotations().items.length === 0);

    const invalidatedOldToken = await openRoom(room, firstToken);
    const invalidatedHello = await invalidatedOldToken.messages.waitFor(message => message.kind === 'hello');
    expect(invalidatedHello).toMatchObject({ resumed: false });
    expect(invalidatedHello.clientId).not.toBe(clientId);
    invalidatedOldToken.socket.terminate();

    await closeSocket(resumed.socket);
    const afterDeletion = await openRoom(room, rotatedToken);
    try {
      expect(await afterDeletion.messages.waitFor(message => message.kind === 'hello')).toMatchObject({
        clientId,
        resumed: true,
      });
      expect(room.getAnnotations().items).toEqual([]);
    } finally {
      afterDeletion.socket.terminate();
    }
  });

  it('assigns a new identity for invalid or expired resume tokens', async () => {
    const room = host.createRoom({ annotationGraceMs: 25 });
    const first = await openRoom(room);
    const firstHello = await first.messages.waitFor(message => message.kind === 'hello');
    const firstId = requiredString(firstHello.clientId);
    const firstToken = requiredString(firstHello.resumeToken);
    await closeSocket(first.socket);

    const invalid = await openRoom(room, 'invalid-token');
    const invalidHello = await invalid.messages.waitFor(message => message.kind === 'hello');
    expect(invalidHello.resumed).toBe(false);
    expect(invalidHello.clientId).not.toBe(firstId);
    invalid.socket.terminate();

    await new Promise<void>(resolve => setTimeout(resolve, 50));
    const expired = await openRoom(room, firstToken);
    try {
      const expiredHello = await expired.messages.waitFor(message => message.kind === 'hello');
      expect(expiredHello.resumed).toBe(false);
      expect(expiredHello.clientId).not.toBe(firstId);
    } finally {
      expired.socket.terminate();
    }
  });

  it('bounds unacknowledged resume-token aliases per stable client', async () => {
    const room = host.createRoom();
    const first = await openRoom(room);
    const hello = await first.messages.waitFor(message => message.kind === 'hello');
    const oldestToken = requiredString(hello.resumeToken);
    const clientId = requiredString(hello.clientId);
    let token = oldestToken;
    await closeSocket(first.socket);

    for (let index = 0; index < MAX_UNACKNOWLEDGED_RESUME_TOKENS; index += 1) {
      const resumed = await openRoom(room, token);
      const resumedHello = await resumed.messages.waitFor(message => message.kind === 'hello');
      expect(resumedHello).toMatchObject({ clientId, resumed: true });
      token = requiredString(resumedHello.resumeToken);
      await closeSocket(resumed.socket);
    }

    const evictedAlias = await openRoom(room, oldestToken);
    try {
      const evictedHello = await evictedAlias.messages.waitFor(message => message.kind === 'hello');
      expect(evictedHello).toMatchObject({ resumed: false });
      expect(evictedHello.clientId).not.toBe(clientId);
    } finally {
      evictedAlias.socket.terminate();
    }
  });

  it('rejects stale and future action revisions instead of racing the handler', async () => {
    const room = host.createRoom();
    const handler = vi.fn();
    room.registerAction(
      {
        id: 'check-model',
        label: 'Check model',
        icon: 'check',
        slot: 'toolbar',
        tone: 'default',
        requires: ['model'],
      },
      handler,
    );
    room.pushModel(syntheticModel('revision test'));
    const client = await openRoom(room);
    try {
      const version = room.getAnnotations().modelVersion;
      client.socket.send(JSON.stringify(createAnnotationsMessage(version, 2, [])));
      await eventually(() => room.getAnnotations().revision === 2);

      client.socket.send(
        JSON.stringify(
          createHostActionInvocation({
            requestId: 'stale-request',
            actionId: 'check-model',
            modelVersion: version,
            annotationRevision: 1,
          }),
        ),
      );
      client.socket.send(
        JSON.stringify(
          createHostActionInvocation({
            requestId: 'future-request',
            actionId: 'check-model',
            modelVersion: version,
            annotationRevision: 3,
          }),
        ),
      );

      expect(
        await client.messages.waitFor(
          message => message.kind === 'host_action_status' && message.requestId === 'stale-request',
        ),
      ).toMatchObject({ state: 'failed', message: expect.stringMatching(/stale/) });
      expect(
        await client.messages.waitFor(
          message => message.kind === 'host_action_status' && message.requestId === 'future-request',
        ),
      ).toMatchObject({ state: 'failed', message: expect.stringMatching(/newer/) });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      client.socket.terminate();
    }
  });

  it('executes request IDs once, resolves annotations from the committed snapshot, and replays status', async () => {
    const room = host.createRoom();
    const contexts: Array<{ annotations: readonly WireAnnotation[]; input: unknown }> = [];
    const handler = vi.fn(context => {
      contexts.push({ annotations: context.annotations, input: context.input });
      return { status: 'succeeded' as const, message: 'done' };
    });
    room.registerAction(
      {
        id: 'apply-note',
        label: 'Apply note',
        icon: 'wand',
        slot: 'annotation-footer',
        tone: 'primary',
        requires: ['model', 'annotations'],
      },
      handler,
    );
    room.pushModel(syntheticModel('idempotency'));
    const client = await openRoom(room);
    try {
      const version = room.getAnnotations().modelVersion;
      client.socket.send(
        JSON.stringify(createAnnotationsMessage(version, 1, [annotation('trusted', version, 'real note')])),
      );
      await eventually(() => room.getAnnotations().items.length === 1);
      const invocation = createHostActionInvocation({
        requestId: 'same-request',
        actionId: 'apply-note',
        modelVersion: version,
        annotationRevision: 1,
        annotationIds: ['trusted'],
        input: { annotation: { id: 'trusted', note: 'fake note' } },
      });
      client.socket.send(JSON.stringify(invocation));
      await client.messages.waitFor(
        message =>
          message.kind === 'host_action_status' &&
          message.requestId === 'same-request' &&
          message.state === 'succeeded',
      );
      client.socket.send(JSON.stringify(invocation));
      await eventually(
        () =>
          client.messages.items.filter(
            message =>
              message.kind === 'host_action_status' &&
              message.requestId === 'same-request' &&
              message.state === 'succeeded',
          ).length >= 2,
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(contexts[0]?.annotations).toMatchObject([{ id: 'trusted', note: 'real note' }]);
      expect(contexts[0]?.input).toEqual({ annotation: { id: 'trusted', note: 'fake note' } });
    } finally {
      client.socket.terminate();
    }
  });

  it('namespaces identical request IDs per stable client and keeps statuses private', async () => {
    const room = host.createRoom();
    const handler = vi.fn(() => ({ status: 'succeeded' as const, message: 'done' }));
    room.registerAction(
      {
        id: 'per-client',
        label: 'Per client',
        icon: 'check',
        slot: 'toolbar',
        tone: 'default',
        requires: ['model'],
      },
      handler,
    );
    room.pushModel(syntheticModel('client namespaces'));
    const clientA = await openRoom(room);
    const clientB = await openRoom(room);
    try {
      const version = room.getAnnotations().modelVersion;
      clientA.socket.send(JSON.stringify(createAnnotationsMessage(version, 0, [])));
      clientB.socket.send(JSON.stringify(createAnnotationsMessage(version, 0, [])));
      const invocation = createHostActionInvocation({
        requestId: 'shared-request',
        actionId: 'per-client',
        modelVersion: version,
        annotationRevision: 0,
      });
      clientA.socket.send(JSON.stringify(invocation));
      clientB.socket.send(JSON.stringify(invocation));
      await clientA.messages.waitFor(
        message =>
          message.kind === 'host_action_status' &&
          message.requestId === 'shared-request' &&
          message.state === 'succeeded',
      );
      await clientB.messages.waitFor(
        message =>
          message.kind === 'host_action_status' &&
          message.requestId === 'shared-request' &&
          message.state === 'succeeded',
      );
      await eventually(() => handler.mock.calls.length === 2);
      expect(
        clientA.messages.items.filter(
          message => message.kind === 'host_action_status' && message.requestId === 'shared-request',
        ),
      ).toHaveLength(2);
      expect(
        clientB.messages.items.filter(
          message => message.kind === 'host_action_status' && message.requestId === 'shared-request',
        ),
      ).toHaveLength(2);
    } finally {
      clientA.socket.terminate();
      clientB.socket.terminate();
    }
  });

  it('returns an existing accepted status when a resumed client retransmits without re-executing', async () => {
    const room = host.createRoom();
    let publisher: HostActionPublisher | undefined;
    const handler = vi.fn((context: { publish: HostActionPublisher }) => {
      publisher = context.publish;
      return { status: 'accepted' as const, operationId: 'accepted-operation' };
    });
    room.registerAction(
      {
        id: 'accepted-replay',
        label: 'Accepted replay',
        icon: 'play',
        slot: 'toolbar',
        tone: 'default',
        requires: ['model'],
      },
      handler,
    );
    room.pushModel(syntheticModel('accepted replay'));
    const first = await openRoom(room);
    const hello = await first.messages.waitFor(message => message.kind === 'hello');
    const resumeToken = requiredString(hello.resumeToken);
    const clientId = requiredString(hello.clientId);
    first.socket.send(JSON.stringify(createResumeTokenAckMessage(resumeToken)));
    const version = room.getAnnotations().modelVersion;
    first.socket.send(JSON.stringify(createAnnotationsMessage(version, 0, [])));
    const invocation = createHostActionInvocation({
      requestId: 'accepted-before-reconnect',
      actionId: 'accepted-replay',
      modelVersion: version,
      annotationRevision: 0,
    });
    first.socket.send(JSON.stringify(invocation));
    await first.messages.waitFor(
      message =>
        message.kind === 'host_action_status' &&
        message.requestId === 'accepted-before-reconnect' &&
        message.operationId === 'accepted-operation',
    );
    await closeSocket(first.socket);

    const resumed = await openRoom(room, resumeToken);
    try {
      expect(await resumed.messages.waitFor(message => message.kind === 'hello')).toMatchObject({
        clientId,
        resumed: true,
      });
      resumed.socket.send(JSON.stringify(invocation));
      await eventually(
        () =>
          resumed.messages.items.filter(
            message =>
              message.kind === 'host_action_status' &&
              message.requestId === 'accepted-before-reconnect' &&
              message.state === 'accepted',
          ).length >= 2,
      );
      expect(handler).toHaveBeenCalledTimes(1);
      publisher?.succeeded('complete');
    } finally {
      resumed.socket.terminate();
    }
  });

  it('replays a terminal action status missed by a resumed client', async () => {
    const room = host.createRoom();
    let publisher: HostActionPublisher | undefined;
    const handler = vi.fn((context: { publish: HostActionPublisher }) => {
      publisher = context.publish;
      return { status: 'accepted' as const, operationId: 'resume-operation' };
    });
    room.registerAction(
      {
        id: 'resume-status',
        label: 'Resume status',
        icon: 'play',
        slot: 'toolbar',
        tone: 'default',
        requires: ['model'],
      },
      handler,
    );
    room.pushModel(syntheticModel('status replay'));
    const first = await openRoom(room);
    const hello = await first.messages.waitFor(message => message.kind === 'hello');
    const resumeToken = requiredString(hello.resumeToken);
    const clientId = requiredString(hello.clientId);
    const version = room.getAnnotations().modelVersion;
    first.socket.send(JSON.stringify(createAnnotationsMessage(version, 0, [])));
    const invocation = createHostActionInvocation({
      requestId: 'missed-terminal',
      actionId: 'resume-status',
      modelVersion: version,
      annotationRevision: 0,
    });
    first.socket.send(JSON.stringify(invocation));
    await first.messages.waitFor(
      message =>
        message.kind === 'host_action_status' &&
        message.requestId === 'missed-terminal' &&
        message.operationId === 'resume-operation',
    );
    await closeSocket(first.socket);
    publisher?.succeeded('completed while disconnected');

    const resumed = await openRoom(room, resumeToken);
    try {
      expect(await resumed.messages.waitFor(message => message.kind === 'hello')).toMatchObject({
        clientId,
        resumed: true,
      });
      expect(
        await resumed.messages.waitFor(
          message =>
            message.kind === 'host_action_status' &&
            message.requestId === 'missed-terminal' &&
            message.state === 'succeeded',
        ),
      ).toMatchObject({ message: 'completed while disconnected' });
      resumed.socket.send(JSON.stringify(invocation));
      await eventually(
        () =>
          resumed.messages.items.filter(
            message =>
              message.kind === 'host_action_status' &&
              message.requestId === 'missed-terminal' &&
              message.state === 'succeeded',
          ).length >= 2,
      );
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      resumed.socket.terminate();
    }
  });

  it('publishes async status privately and turns handler exceptions into failed status', async () => {
    const room = host.createRoom();
    let publisher: HostActionPublisher | undefined;
    room.registerAction(
      {
        id: 'async-action',
        label: 'Async action',
        icon: 'play',
        slot: 'toolbar',
        tone: 'default',
        requires: ['model'],
      },
      context => {
        publisher = context.publish;
        return { status: 'accepted', operationId: 'operation-1', message: 'queued' };
      },
    );
    room.registerAction(
      {
        id: 'throwing-action',
        label: 'Throwing action',
        icon: 'bot',
        slot: 'toolbar',
        tone: 'danger',
        requires: ['model'],
      },
      () => {
        throw new Error('handler exploded');
      },
    );
    room.pushModel(syntheticModel('async'));
    const clientA = await openRoom(room);
    const clientB = await openRoom(room);
    try {
      const version = room.getAnnotations().modelVersion;
      clientA.socket.send(JSON.stringify(createAnnotationsMessage(version, 0, [])));
      clientB.socket.send(JSON.stringify(createAnnotationsMessage(version, 0, [])));
      await eventually(() => room.getAnnotations().revision === 0);
      clientA.socket.send(
        JSON.stringify(
          createHostActionInvocation({
            requestId: 'async-request',
            actionId: 'async-action',
            modelVersion: version,
            annotationRevision: 0,
          }),
        ),
      );
      expect(
        await clientA.messages.waitFor(
          message =>
            message.kind === 'host_action_status' &&
            message.requestId === 'async-request' &&
            message.operationId === 'operation-1',
        ),
      ).toMatchObject({ state: 'accepted', message: 'queued' });
      publisher?.running('working');
      expect(
        await clientA.messages.waitFor(
          message =>
            message.kind === 'host_action_status' &&
            message.requestId === 'async-request' &&
            message.state === 'running',
        ),
      ).toMatchObject({ message: 'working' });
      expect(
        clientB.messages.items.some(
          message => message.kind === 'host_action_status' && message.requestId === 'async-request',
        ),
      ).toBe(false);
      publisher?.succeeded('complete');
      expect(
        await clientA.messages.waitFor(
          message =>
            message.kind === 'host_action_status' &&
            message.requestId === 'async-request' &&
            message.state === 'succeeded',
        ),
      ).toMatchObject({ message: 'complete' });

      clientA.socket.send(
        JSON.stringify(
          createHostActionInvocation({
            requestId: 'throw-request',
            actionId: 'throwing-action',
            modelVersion: version,
            annotationRevision: 0,
          }),
        ),
      );
      expect(
        await clientA.messages.waitFor(
          message =>
            message.kind === 'host_action_status' &&
            message.requestId === 'throw-request' &&
            message.state === 'failed',
        ),
      ).toMatchObject({ message: 'handler exploded' });
    } finally {
      clientA.socket.terminate();
      clientB.socket.terminate();
    }
  });
});

class TextMessageCollector {
  readonly items: Array<Record<string, unknown>> = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        return;
      }
      try {
        this.items.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        for (const listener of this.listeners) {
          listener();
        }
      } catch {
        // Tests intentionally ignore non-JSON text frames.
      }
    });
  }

  async waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const find = () => this.items.find(predicate);
    const current = find();
    if (current) {
      return current;
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for message; received ${JSON.stringify(this.items)}`));
      }, 5_000);
      const check = () => {
        const match = find();
        if (!match) {
          return;
        }
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(match);
      };
      this.listeners.add(check);
    });
  }
}

async function openRoom(
  room: ViewerRoom,
  resumeToken?: string,
): Promise<{ socket: WebSocket; messages: TextMessageCollector }> {
  const socketUrl = new URL(`${room.url.replace(/^http/, 'ws')}ws`);
  if (resumeToken !== undefined) {
    socketUrl.searchParams.set('resume', resumeToken);
  }
  const socket = new WebSocket(socketUrl, {
    headers: { Origin: new URL(room.url).origin, Host: new URL(room.url).host },
  });
  const messages = new TextMessageCollector(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>(resolve => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

async function interruptRoomResume(room: ViewerRoom, resumeToken: string): Promise<void> {
  const socketUrl = new URL(`${room.url.replace(/^http/, 'ws')}ws`);
  socketUrl.searchParams.set('resume', resumeToken);
  const socket = new WebSocket(socketUrl, {
    headers: { Origin: new URL(room.url).origin, Host: new URL(room.url).host },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => socket.terminate());
    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
}

async function attemptWebSocket(url: string, origin: string): Promise<'open' | 'rejected'> {
  return new Promise(resolve => {
    const parsed = new URL(url);
    const socket = new WebSocket(url, {
      headers: { Origin: origin, Host: parsed.host },
      handshakeTimeout: 3_000,
    });
    const finish = (result: 'open' | 'rejected'): void => {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      resolve(result);
    };
    socket.once('open', () => finish('open'));
    socket.once('unexpected-response', () => finish('rejected'));
    socket.once('error', () => finish('rejected'));
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition.');
    }

    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected a string, received ${String(value)}.`);
  }
  return value;
}

function annotation(id: string, modelVersion: string, note: string): WireAnnotation {
  return {
    id,
    modelVersion,
    kind: 'point',
    partLabel: 'point#1',
    note,
    worldCoord: [0, 0, 0],
  };
}

function syntheticModel(description: string): ViewerModelFrame {
  return {
    description,
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
