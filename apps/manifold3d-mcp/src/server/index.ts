#!/usr/bin/env node
/**
 * Entrypoint: starts the MCP server on stdio immediately. The preview
 * HTTP/WebSocket server (and the browser open) is deferred until the first
 * successful `execute_script` — until then the user sees nothing on disk
 * or in their browser, which is the polite behaviour for a server an MCP
 * client may have spawned eagerly.
 *
 * Logs only to stderr — stdout is reserved for MCP protocol frames.
 */
import { launchPreview } from './preview/launch-browser.js';
import { createPreviewLifecycle } from './preview/preview-lifecycle.js';
import type { ModelingSession } from '@manifold3d/modeling/modeling.js';
import { createInMemoryViewerAssetProvider, type ViewerAssetManifest } from '@manifold3d/viewer-host/viewer-host.js';
import { startPreviewServer } from './preview/preview-server.js';
import { startMcpServer, type McpServerHandle } from './mcp/mcp-server.js';

export async function startMcpApplication({
  modelingSession,
  viewerAssets,
  version,
}: {
  modelingSession: ModelingSession;
  viewerAssets: ViewerAssetManifest;
  version: string;
}): Promise<void> {
  const preview = createPreviewLifecycle({
    start: () =>
      startPreviewServer({
        preferredPort: 3737,
        assetProvider: createInMemoryViewerAssetProvider(viewerAssets),
        ...(process.env.NODE_ENV === 'development'
          ? { additionalOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'] }
          : {}),
      }),
    launch: (url, signal) => launchPreview(url, { signal }),
    log: message => process.stderr.write(`[manifold3d-mcp] ${message}\n`),
  });
  let mcpServer: McpServerHandle | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    preview.cancelBrowser();
    process.stderr.write(`[manifold3d-mcp] received ${signal}, shutting down\n`);
    shutdownPromise = (async () => {
      const errors: unknown[] = [];
      try {
        await mcpServer?.drain();
      } catch (error) {
        errors.push(error);
      }
      const settled = await Promise.allSettled([mcpServer?.close(), preview.close(), modelingSession.dispose()]);
      errors.push(
        ...settled
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason as unknown),
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'MCP shutdown failed.');
      }
    })();
    return shutdownPromise;
  };
  const handleSignal = (signal: string): void => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(`[manifold3d-mcp] shutdown failed: ${message}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  try {
    mcpServer = await startMcpServer({
      version,
      modelingSession,
      getPreview: preview.getPreview,
      peekPreview: preview.peekPreview,
      onModelPublished: preview.modelPublished,
    });
    process.stdin.once('end', () => handleSignal('stdin EOF'));
    process.stdin.once('close', () => handleSignal('stdin closed'));
    if (process.stdin.readableEnded) {
      handleSignal('stdin EOF');
    }
  } catch (error) {
    try {
      await shutdown('startup failure');
    } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], 'MCP startup and cleanup both failed.', {
        cause: shutdownError,
      });
    }
    throw error;
  }
}
