import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModelHeader, type ViewerModelFrame } from '../packages/protocol/src/wire/model.js';
import {
  buildViewerWebSocketUrl,
  connectMeshFeed,
  createModelFrameReceiver,
  readResumeToken,
  resumeStorageKey,
  validateResumeIdentity,
  writeResumeToken,
} from '../packages/viewer/src/transport/ws-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function modelFrame(): ViewerModelFrame {
  return {
    numProp: 3,
    triangles: 1,
    vertices: 3,
    vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
    triVerts: new Uint32Array([0, 1, 2]).buffer,
    triFeatureIds: new Uint32Array([0]).buffer,
    features: [
      {
        label: 'unknown#1',
        kind: 'unknown',
        params: {},
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      },
    ],
    volume: 0,
    surfaceArea: 0.5,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [1, 1, 0],
  };
}

describe('viewer WS model frame receiver', () => {
  it('derives the authenticated room WebSocket route from the loaded page URL', () => {
    expect(buildViewerWebSocketUrl('http://127.0.0.1:3737/rooms/id/token/')).toBe(
      'ws://127.0.0.1:3737/rooms/id/token/ws',
    );
    expect(buildViewerWebSocketUrl('https://viewer.test/rooms/id/token/index.html')).toBe(
      'wss://viewer.test/rooms/id/token/ws',
    );
    expect(buildViewerWebSocketUrl('https://viewer.test/rooms/id/token/', 'resume-token')).toBe(
      'wss://viewer.test/rooms/id/token/ws?resume=resume-token',
    );
  });

  it('uses room-bound resumable storage and tolerates unavailable storage', () => {
    expect(resumeStorageKey('https://viewer.test/rooms/id/token/index.html')).toBe(
      'manifold3d-viewer:resume:https://viewer.test/rooms/id/token/:default',
    );
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeResumeToken('room-key', 'resume-token', storage);
    expect(readResumeToken('room-key', storage)).toBe('resume-token');
    expect(
      readResumeToken('room-key', {
        getItem() {
          throw new Error('blocked');
        },
      }),
    ).toBeUndefined();
    expect(() =>
      writeResumeToken('room-key', 'resume-token', {
        setItem() {
          throw new Error('blocked');
        },
      }),
    ).not.toThrow();
  });

  it('namespaces resume persistence by a bounded stable Viewer identity', () => {
    const pageUrl = 'https://viewer.test/rooms/id/token/';
    expect(resumeStorageKey(pageUrl, 'left-pane')).toBe(
      'manifold3d-viewer:resume:https://viewer.test/rooms/id/token/:left-pane',
    );
    expect(resumeStorageKey(pageUrl, 'right-pane')).not.toBe(resumeStorageKey(pageUrl, 'left-pane'));
    expect(validateResumeIdentity('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => validateResumeIdentity('')).toThrow(/1-64/);
    expect(() => validateResumeIdentity('../shared')).toThrow(/URL-safe/);
    expect(() => validateResumeIdentity('a'.repeat(65))).toThrow(/1-64/);
  });

  it('reuses the same identity across feed reloads without putting it in the network URL', () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const values = new Map<string, string>();
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('location', { href: 'https://viewer.test/rooms/id/token/' });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('window', {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    const firstFeed = connectMeshFeed({
      resumeIdentity: 'panel-a',
      onMesh: () => undefined,
    });
    const firstSocket = sockets[0]!;
    firstSocket.open();
    firstSocket.receive(
      JSON.stringify({
        kind: 'hello',
        protocolVersion: 1,
        clientId: 'client-1',
        resumeToken: 'resume-xyz',
        resumed: false,
      }),
    );
    firstFeed.close();

    const reloadedFeed = connectMeshFeed({
      resumeIdentity: 'panel-a',
      onMesh: () => undefined,
    });
    const reloadedSocket = sockets[1]!;
    expect(reloadedSocket.url).toContain('resume=resume-xyz');
    expect(reloadedSocket.url).not.toContain('panel-a');
    reloadedFeed.close();

    const independentFeed = connectMeshFeed({
      resumeIdentity: 'panel-b',
      onMesh: () => undefined,
    });
    expect(sockets[2]!.url).not.toContain('resume=');
    independentFeed.close();
  });

  it('emits a model only after a consistent header and all declared buffers', () => {
    const frame = modelFrame();
    const onMesh = vi.fn();
    const onError = vi.fn();
    const receiver = createModelFrameReceiver({ onMesh, onError });

    receiver.receiveText(JSON.stringify(createModelHeader(frame)));
    receiver.receiveBinary(frame.vertProperties);
    receiver.receiveBinary(frame.triVerts);
    expect(onMesh).not.toHaveBeenCalled();
    receiver.receiveBinary(frame.triFeatureIds);

    expect(onError).not.toHaveBeenCalled();
    expect(onMesh).toHaveBeenCalledTimes(1);
    expect(onMesh.mock.calls[0]?.[0].triangles).toBe(1);
  });

  it('surfaces the rotating resumable hello message', () => {
    const onMesh = vi.fn();
    const onHello = vi.fn();
    const receiver = createModelFrameReceiver({ onMesh, onHello });
    receiver.receiveText(
      JSON.stringify({
        kind: 'hello',
        protocolVersion: 1,
        clientId: 'client-1',
        resumeToken: 'token-1',
        resumed: true,
      }),
    );
    expect(onHello).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1', resumeToken: 'token-1', resumed: true }),
    );
  });

  it('persists in memory and ACKs on the same socket even when sessionStorage writes fail', () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('location', { href: 'https://viewer.test/rooms/id/token/' });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    let reconnect: (() => void) | undefined;
    vi.stubGlobal('window', {
      setTimeout: (callback: () => void) => {
        reconnect = callback;
        return 1;
      },
      clearTimeout: () => undefined,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: () => 'old-token',
      setItem() {
        throw new Error('storage blocked');
      },
    });
    const onHello = vi.fn(() => {
      expect(sockets[0]?.sent).toHaveLength(1);
    });
    const feed = connectMeshFeed({ onMesh: () => undefined, onHello });
    const socket = sockets[0]!;
    expect(socket.url).toContain('resume=old-token');
    socket.open();
    socket.receive(
      JSON.stringify({
        kind: 'hello',
        protocolVersion: 1,
        clientId: 'client-1',
        resumeToken: 'new-token',
        resumed: true,
      }),
    );

    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      {
        kind: 'resume_token_ack',
        protocolVersion: 1,
        resumeToken: 'new-token',
      },
    ]);
    expect(onHello).toHaveBeenCalledOnce();
    socket.close();
    reconnect?.();
    expect(sockets[1]?.url).toContain('resume=new-token');
    feed.close();
  });

  it('surfaces malformed and unsupported headers instead of accepting kind alone', () => {
    const onMesh = vi.fn();
    const onError = vi.fn();
    const receiver = createModelFrameReceiver({ onMesh, onError });

    receiver.receiveText('{');
    receiver.receiveText(JSON.stringify({ kind: 'mesh' }));
    receiver.receiveText(
      JSON.stringify({
        ...createModelHeader(modelFrame()),
        protocolVersion: 2,
      }),
    );

    expect(onMesh).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[2]?.[0].message).toMatch(/Unsupported viewer protocolVersion/);
  });

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly sent: string[] = [];
    readyState = 0;
    closeCalls = 0;
    binaryType = 'blob';
    onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {}

    send(message: string): void {
      this.sent.push(message);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    receive(message: string): void {
      this.onmessage?.({ data: message } as MessageEvent<string>);
    }

    close(): void {
      this.closeCalls += 1;
      this.readyState = 3;
      this.onclose?.();
    }
  }

  it('detaches and gates every socket callback after close', () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('location', { href: 'https://viewer.test/rooms/id/token/' });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const scheduled = vi.fn();
    vi.stubGlobal('window', {
      setTimeout: scheduled,
      clearTimeout: vi.fn(),
    });
    const onMesh = vi.fn();
    const onModelVersion = vi.fn();
    const onHello = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const onStatusChange = vi.fn();
    const feed = connectMeshFeed({
      onMesh,
      onModelVersion,
      onHello,
      onOpen,
      onError,
      onStatusChange,
    });
    const socket = sockets[0]!;
    const lateMessage = socket.onmessage!;
    const lateOpen = socket.onopen!;
    const lateClose = socket.onclose!;
    const lateError = socket.onerror!;

    feed.close();
    lateMessage({
      data: JSON.stringify({ kind: 'model_version', protocolVersion: 1, modelVersion: 'late' }),
    } as MessageEvent<string>);
    lateMessage({ data: new ArrayBuffer(8) } as MessageEvent<ArrayBuffer>);
    lateOpen();
    lateClose();
    lateError();

    expect(socket.onmessage).toBeNull();
    expect(socket.onopen).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.closeCalls).toBe(1);
    expect(onMesh).not.toHaveBeenCalled();
    expect(onModelVersion).not.toHaveBeenCalled();
    expect(onHello).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenCalledWith('connecting');
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('ignores callbacks retained from a superseded socket', () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('location', { href: 'https://viewer.test/rooms/id/token/' });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    let reconnect: (() => void) | undefined;
    const scheduled = vi.fn((callback: () => void) => {
      reconnect = callback;
      return 1;
    });
    vi.stubGlobal('window', {
      setTimeout: scheduled,
      clearTimeout: vi.fn(),
    });
    const onModelVersion = vi.fn();
    const onHello = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const onStatusChange = vi.fn();
    const feed = connectMeshFeed({
      onMesh: vi.fn(),
      onModelVersion,
      onHello,
      onOpen,
      onError,
      onStatusChange,
    });
    const first = sockets[0]!;
    first.open();
    const oldMessage = first.onmessage!;
    const oldOpen = first.onopen!;
    const oldClose = first.onclose!;
    const oldError = first.onerror!;
    first.close();
    reconnect?.();
    const second = sockets[1]!;
    second.open();
    const statusesBeforeLateCallbacks = onStatusChange.mock.calls.slice();

    oldMessage({
      data: JSON.stringify({ kind: 'model_version', protocolVersion: 1, modelVersion: 'stale' }),
    } as MessageEvent<string>);
    oldOpen();
    oldClose();
    oldError();

    expect(feed.isOpen()).toBe(true);
    expect(onModelVersion).not.toHaveBeenCalled();
    expect(onHello).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onStatusChange.mock.calls).toEqual(statusesBeforeLateCallbacks);
    expect(scheduled).toHaveBeenCalledOnce();
    expect(first.closeCalls).toBe(1);
    feed.close();
  });

  it('surfaces a declared buffer length mismatch and resets the partial frame', () => {
    const frame = modelFrame();
    const onMesh = vi.fn();
    const onError = vi.fn();
    const receiver = createModelFrameReceiver({ onMesh, onError });

    receiver.receiveText(JSON.stringify(createModelHeader(frame)));
    receiver.receiveBinary(new Float32Array([0, 0, 0]).buffer);
    receiver.receiveBinary(frame.triVerts);

    expect(onMesh).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0].message).toMatch(/does not match the declared/);
    expect(onError.mock.calls[1]?.[0].message).toMatch(/without a valid header/);
  });
});
