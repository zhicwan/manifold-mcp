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
import { ModelingEngine, ModelingSession } from '@manifold3d/modeling/modeling.js';
import { startPreviewServer, type PreviewServerHandle } from '@manifold3d/viewer-host/preview/preview-server.js';
import { startMcpServer, type McpServerHandle } from './mcp/mcp-server.js';

async function main(): Promise<void> {
  const modelingSession = new ModelingSession(new ModelingEngine());
  let previewPromise: Promise<PreviewServerHandle> | undefined;
  let preview: PreviewServerHandle | undefined;
  let mcpServer: McpServerHandle | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const getPreview = (): Promise<PreviewServerHandle> => {
    if (!previewPromise) {
      previewPromise = (async () => {
        const handle = await startPreviewServer();
        preview = handle;
        process.stderr.write(`[manifold3d-mcp] preview ready at ${handle.url}\n`);
        // Open the preview. Prefers a chromeless `--app` window when the
        // user's default browser is Chromium; otherwise a normal tab. Best
        // effort — ignores failure (headless / no browser). Skipped entirely
        // when MANIFOLD_MCP_NO_OPEN is set (tests / headless CI) so we don't
        // spawn a browser that would 404 once the server shuts down.
        await launchPreview(handle.url);
        return handle;
      })().catch(err => {
        // Reset so the next call can retry.
        previewPromise = undefined;
        throw err;
      });
    }
    return previewPromise;
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    process.stderr.write(`[manifold3d-mcp] received ${signal}, shutting down\n`);
    shutdownPromise = (async () => {
      const errors: unknown[] = [];
      try {
        await mcpServer?.drain();
      } catch (error) {
        errors.push(error);
      }
      const settled = await Promise.allSettled([
        mcpServer?.close(),
        (async () => {
          const handle = preview ?? (previewPromise ? await previewPromise : undefined);
          if (handle) {
            await handle.close();
          }
        })(),
        modelingSession.dispose(),
      ]);
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
    mcpServer = await startMcpServer({ modelingSession, getPreview, peekPreview: () => preview });
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

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[manifold3d-mcp] fatal: ${msg}\n`);
  process.exit(1);
});
