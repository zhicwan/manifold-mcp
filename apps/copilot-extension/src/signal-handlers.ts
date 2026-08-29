import process from 'node:process';

import type { CopilotExtensionApplication } from './composition.js';

export type ExtensionSignal = 'SIGINT' | 'SIGTERM';

export interface ExtensionSignalRuntime {
  once(signal: ExtensionSignal, listener: () => void): unknown;
  exit(code: number): unknown;
  stderr: {
    write(message: string): unknown;
  };
}

export function installExtensionSignalHandlers(
  application: Pick<CopilotExtensionApplication, 'shutdown'>,
  runtime: ExtensionSignalRuntime = process,
): void {
  const handle = createExtensionSignalHandler(application, runtime);
  runtime.once('SIGINT', () => handle('SIGINT'));
  runtime.once('SIGTERM', () => handle('SIGTERM'));
}

export function createExtensionSignalHandler(
  application: Pick<CopilotExtensionApplication, 'shutdown'>,
  runtime: Pick<ExtensionSignalRuntime, 'exit' | 'stderr'> = process,
): (signal: ExtensionSignal) => void {
  let handlingSignal = false;
  return signal => {
    if (handlingSignal) {
      return;
    }
    handlingSignal = true;
    // The parent sends SIGTERM while its own SDK endpoint is dying. Keep this
    // path local: bounded pending-send drain + rooms/host/modeling cleanup only.
    void application.shutdown().then(
      () => runtime.exit(0),
      error => {
        runtime.stderr.write(`[manifold3d-extension] ${signal} shutdown failed: ${errorMessage(error)}\n`);
        runtime.exit(1);
      },
    );
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
