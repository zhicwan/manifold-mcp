import { Buffer } from 'node:buffer';
import process from 'node:process';
import { isMainThread, workerData } from 'node:worker_threads';

import { startModelingWorker } from '@manifold3d/modeling/runner/worker.js';
import {
  embeddedManifoldWasmBase64,
  embeddedTypeScriptLibBase64,
  embeddedViewerAssets,
} from 'virtual:manifold-resources';

import { startCopilotExtension } from './composition.js';
import { runExtensionSelfTest } from './self-test.js';
import type { CopilotSdkBoundary } from './sdk-boundary.js';
import { installExtensionSignalHandlers } from './signal-handlers.js';

let sdkImported = false;

async function loadCopilotSdk(): Promise<CopilotSdkBoundary> {
  sdkImported = true;
  const sdk = await import('@github/copilot-sdk/extension');
  return {
    createCanvas: sdk.createCanvas,
    joinSession: sdk.joinSession,
  };
}

async function runMain(): Promise<void> {
  const sdk = await loadCopilotSdk();
  const wasmBinary = Buffer.from(embeddedManifoldWasmBase64, 'base64');
  const application = await startCopilotExtension({
    sdk,
    viewerAssets: embeddedViewerAssets,
    workerFilename: import.meta.url,
    manifoldWasmBytes: wasmBinary,
    typescriptLibDeclarations: Buffer.from(embeddedTypeScriptLibBase64, 'base64').toString('utf8'),
  });
  installExtensionSignalHandlers(application);
}

async function dispatch(): Promise<void> {
  if (!isMainThread) {
    if (
      workerData?.role !== 'model-worker' ||
      !(workerData.wasmBinary instanceof Uint8Array) ||
      typeof workerData.typescriptLibDeclarations !== 'string'
    ) {
      throw new Error('Invalid model-worker bootstrap data.');
    }
    await startModelingWorker({
      wasmBinary: workerData.wasmBinary,
      typescriptLibDeclarations: workerData.typescriptLibDeclarations,
    });
    return;
  }
  if (process.argv.includes('--self-test')) {
    const result = await runExtensionSelfTest({
      workerFilename: import.meta.url,
      wasmBinary: Buffer.from(embeddedManifoldWasmBase64, 'base64'),
      typescriptLibDeclarations: Buffer.from(embeddedTypeScriptLibBase64, 'base64').toString('utf8'),
      viewerAssets: embeddedViewerAssets,
      sdkImported: () => sdkImported,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  await runMain();
}

dispatch().catch(error => {
  process.stderr.write(`[manifold3d-extension] fatal: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
