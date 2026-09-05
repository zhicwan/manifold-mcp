import type { PreviewServerHandle } from './preview-server.js';

interface PreviewLifecycleOptions {
  start(): Promise<PreviewServerHandle>;
  launch(url: string, signal: AbortSignal): Promise<void>;
  log(message: string): void;
}

/** Owns the lazy HTTP preview and its independent, one-time browser handoff. */
export function createPreviewLifecycle(options: PreviewLifecycleOptions) {
  const browser = new AbortController();
  let pending: Promise<PreviewServerHandle> | undefined;
  let preview: PreviewServerHandle | undefined;
  let launchStarted = false;
  let closePromise: Promise<void> | undefined;

  return {
    getPreview(): Promise<PreviewServerHandle> {
      if (closePromise) {
        return Promise.reject(new Error('Preview is closed.'));
      }
      if (!pending) {
        pending = options.start().then(
          handle => {
            preview = handle;
            options.log(`preview ready at ${handle.url}`);
            return handle;
          },
          (error: unknown) => {
            pending = undefined;
            throw error;
          },
        );
      }
      return pending;
    },
    peekPreview(): PreviewServerHandle | undefined {
      return preview;
    },
    modelPublished(): void {
      if (launchStarted || browser.signal.aborted || !preview) {
        return;
      }
      launchStarted = true;
      const url = preview.url;
      void Promise.resolve()
        .then(() => {
          if (!browser.signal.aborted) {
            return options.launch(url, browser.signal);
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (!browser.signal.aborted) {
            options.log(`browser launch failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    },
    cancelBrowser(): void {
      browser.abort();
    },
    close(): Promise<void> {
      if (!closePromise) {
        browser.abort();
        closePromise = (async () => {
          const handle = preview ?? (pending ? await pending : undefined);
          await handle?.close();
        })();
      }
      return closePromise;
    },
  };
}
