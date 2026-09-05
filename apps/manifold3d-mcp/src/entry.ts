import { Buffer } from 'node:buffer';
import { isMainThread, workerData } from 'node:worker_threads';

import { ModelingEngine, ModelingSession } from '@manifold3d/modeling/modeling.js';
import { Runner } from '@manifold3d/modeling/runner/host.js';
import { startModelingWorker } from '@manifold3d/modeling/runner/worker.js';
import {
  applicationVersion,
  embeddedManifoldWasmBase64,
  embeddedTypeScriptLibBase64,
  embeddedViewerAssets,
} from 'virtual:manifold-resources';

import { startMcpApplication } from './server/index.js';

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
  const runner = new Runner({
    workerFilename: import.meta.url,
    workerData: {
      role: 'model-worker',
      wasmBinary: Buffer.from(embeddedManifoldWasmBase64, 'base64'),
      typescriptLibDeclarations: Buffer.from(embeddedTypeScriptLibBase64, 'base64').toString('utf8'),
    },
  });
  await startMcpApplication({
    modelingSession: new ModelingSession(new ModelingEngine(runner)),
    viewerAssets: embeddedViewerAssets,
    version: applicationVersion,
  });
}

dispatch().catch((error: unknown) => {
  process.stderr.write(
    `[manifold3d-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
