import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ModelingEngine, ModelingSession } from '@manifold3d/modeling/modeling.js';
import { Runner } from '@manifold3d/modeling/runner/host.js';
import type { ModelArtifact } from '../packages/modeling/src/runner/protocol.js';
import { emptyReport } from '../packages/modeling/src/validation/report.js';
import type { PreviewServerHandle } from '../apps/manifold3d-mcp/src/server/preview/preview-server.js';
import { startMcpServer } from '../apps/manifold3d-mcp/src/server/mcp/mcp-server.js';
import { createPreviewLifecycle } from '../apps/manifold3d-mcp/src/server/preview/preview-lifecycle.js';

const { handlers } = vi.hoisted(() => ({
  handlers: [] as Array<(request: CallToolRequest) => Promise<CallToolResult>>,
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler(_schema: unknown, handler: (request: CallToolRequest) => Promise<CallToolResult>) {
      handlers.push(handler);
    }
    connect() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  },
}));

const artifact: ModelArtifact = {
  numProp: 3,
  triangles: 0,
  vertices: 0,
  vertProperties: new ArrayBuffer(0),
  triVerts: new ArrayBuffer(0),
  triFeatureIds: new ArrayBuffer(0),
  features: [],
  volume: 0,
  surfaceArea: 0,
  genus: 0,
  bboxMin: [0, 0, 0],
  bboxMax: [0, 0, 0],
};

function handle(): PreviewServerHandle {
  return {
    url: 'http://127.0.0.1:3737/',
    pushModel: vi.fn(),
    getAnnotations: () => ({ protocolVersion: 1, modelVersion: 'none', revision: 0, items: [] }),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe('MCP preview lifecycle', () => {
  beforeEach(() => {
    handlers.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['pending', 'rejected'])(
    'commits, drains and shuts down independently of a %s browser launch',
    async mode => {
      const previewHandle = handle();
      const runner = new Runner();
      vi.spyOn(runner, 'run').mockResolvedValue({ report: emptyReport(), artifact });
      const dispose = vi.spyOn(runner, 'dispose').mockResolvedValue();
      const session = new ModelingSession(new ModelingEngine(runner));
      let committedAtLaunch: ModelArtifact | undefined;
      let publicationsAtLaunch = 0;
      const launch = vi.fn((_url: string, _signal: AbortSignal) => {
        committedAtLaunch = session.getCurrentModel()?.artifact;
        publicationsAtLaunch = vi.mocked(previewHandle.pushModel).mock.calls.length;
        return mode === 'pending' ? new Promise<void>(() => undefined) : Promise.reject(new Error('no desktop'));
      });
      const log = vi.fn();
      const preview = createPreviewLifecycle({ start: () => Promise.resolve(previewHandle), launch, log });
      const mcp = await startMcpServer({
        version: 'test',
        modelingSession: session,
        getPreview: preview.getPreview,
        peekPreview: preview.peekPreview,
        onModelPublished: preview.modelPublished,
      });
      try {
        const ready = await preview.getPreview();
        expect(ready).toBe(previewHandle);
        expect(launch).not.toHaveBeenCalled();
        const call = handlers[1]!;
        const result = await call({
          method: 'tools/call',
          params: { name: 'execute_script', arguments: { code: 'code' } },
        });
        expect(result.isError).not.toBe(true);
        await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
        expect(committedAtLaunch).toBe(artifact);
        expect(publicationsAtLaunch).toBe(1);
        if (mode === 'rejected') {
          await vi.waitFor(() => expect(log).toHaveBeenCalledWith('browser launch failed: no desktop'));
        }
        preview.modelPublished();
        expect(launch).toHaveBeenCalledTimes(1);
        preview.cancelBrowser();
        expect(launch.mock.calls[0]![1].aborted).toBe(true);
        await mcp.drain();
        await Promise.all([preview.close(), session.dispose()]);
        expect(previewHandle.close).toHaveBeenCalledTimes(1);
        expect(dispose).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.all([mcp.close(), preview.close(), session.dispose()]);
      }
    },
  );

  it('logs launch rejection without making a successful publication fail', async () => {
    const previewHandle = handle();
    const log = vi.fn();
    const preview = createPreviewLifecycle({
      start: () => Promise.resolve(previewHandle),
      launch: () => Promise.reject(new Error('no desktop')),
      log,
    });
    await preview.getPreview();
    preview.modelPublished();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('browser launch failed: no desktop'));
    expect(preview.peekPreview()).toBe(previewHandle);
    await preview.close();
  });

  it('suppresses queued launches and closes a preview whose startup finishes after cancellation', async () => {
    let finishStartup!: (handle: PreviewServerHandle) => void;
    const started = new Promise<PreviewServerHandle>(resolve => {
      finishStartup = resolve;
    });
    const launch = vi.fn(() => Promise.resolve());
    const previewHandle = handle();
    const preview = createPreviewLifecycle({ start: () => started, launch, log: vi.fn() });
    const ready = preview.getPreview();
    preview.cancelBrowser();
    const closed = preview.close();
    expect(preview.close()).toBe(closed);
    finishStartup(previewHandle);
    await ready;
    preview.modelPublished();
    await closed;
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    expect(previewHandle.close).toHaveBeenCalledTimes(1);
    await expect(preview.getPreview()).rejects.toThrow('Preview is closed');
  });

  it('does not launch from a publication notification queued immediately before shutdown', async () => {
    const launch = vi.fn(() => Promise.resolve());
    const preview = createPreviewLifecycle({ start: () => Promise.resolve(handle()), launch, log: vi.fn() });
    await preview.getPreview();
    preview.modelPublished();
    await preview.close();
    expect(launch).not.toHaveBeenCalled();
  });

  it('retries failed HTTP startup and shares failed close results', async () => {
    const previewHandle = handle();
    const failure = new Error('close failed');
    vi.mocked(previewHandle.close).mockRejectedValue(failure);
    const start = vi
      .fn<() => Promise<PreviewServerHandle>>()
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValue(previewHandle);
    const preview = createPreviewLifecycle({ start, launch: vi.fn(), log: vi.fn() });
    await expect(preview.getPreview()).rejects.toThrow('bind failed');
    await expect(preview.getPreview()).resolves.toBe(previewHandle);
    const closing = preview.close();
    expect(preview.close()).toBe(closing);
    await expect(closing).rejects.toBe(failure);
    expect(preview.close()).toBe(closing);
  });
});
