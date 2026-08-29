/* global Module */
import { createHash } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { isMainThread, parentPort, Worker as NodeWorker, workerData } from 'node:worker_threads';

/*__MANIFOLD_MODULE_SOURCE__*/

const MANIFOLD_VERSION = '__MANIFOLD_VERSION__';
const EMBEDDED_WASM_BASE64 = '__MANIFOLD_WASM_BASE64__';

class Worker extends NodeWorker {
  constructor(filename, options) {
    const normalizedFilename =
      typeof filename === 'string' && filename.startsWith('file:') ? new URL(filename) : filename;
    super(normalizedFilename, options);
  }
}

const ASSET_MANIFEST = new Map([
  [
    '/index.html',
    {
      contentType: 'text/html; charset=utf-8',
      bytes: Buffer.from(
        '<!doctype html><html><head><meta charset="utf-8"><title>Extension spike</title><link rel="stylesheet" href="/style.css"></head><body><main id="app">embedded viewer</main><script type="module" src="/app.js"></script></body></html>',
        'utf8',
      ),
    },
  ],
  [
    '/app.js',
    {
      contentType: 'text/javascript; charset=utf-8',
      bytes: Buffer.from("document.querySelector('#app').dataset.ready = 'true';\n", 'utf8'),
    },
  ],
  [
    '/style.css',
    {
      contentType: 'text/css; charset=utf-8',
      bytes: Buffer.from(
        'body{margin:0;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font-family:var(--font-sans,sans-serif)}main{padding:16px}\n',
        'utf8',
      ),
    },
  ],
]);

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'NonErrorThrown',
    message: String(error),
  };
}

function exactAsset(pathname) {
  return ASSET_MANIFEST.get(pathname === '/' ? '/index.html' : pathname);
}

async function startAssetServer() {
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, {
          Allow: 'GET, HEAD',
          Connection: 'close',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('method not allowed');
        return;
      }

      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const asset = exactAsset(requestUrl.pathname);
      if (!asset) {
        response.writeHead(404, {
          Connection: 'close',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('not found');
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-store',
        Connection: 'close',
        'Content-Length': asset.bytes.byteLength,
        'Content-Type': asset.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : asset.bytes);
    } catch (error) {
      response.writeHead(500, {
        Connection: 'close',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ error: serializeError(error) }));
    }
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Loopback HTTP server did not expose a TCP address');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function requestBytes(url) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          statusCode: response.statusCode,
        });
      });
    });
    request.once('error', reject);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runModelWorker() {
  if (!parentPort) {
    throw new Error('model-worker role requires a worker_threads parentPort');
  }

  const diagnostics = [];
  const locateFileCalls = [];
  const wasmBinary = Buffer.from(EMBEDDED_WASM_BASE64, 'base64');
  assert(
    wasmBinary.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
    'Embedded manifold.wasm does not have the WebAssembly magic header',
  );

  const manifold = await Module({
    locateFile(path, prefix) {
      locateFileCalls.push({ path, prefix });
      if (path !== 'manifold.wasm') {
        throw new Error(`Unexpected Emscripten locateFile request: ${path}`);
      }
      return 'embedded://manifold.wasm';
    },
    print(text) {
      diagnostics.push({ level: 'stdout', text: String(text) });
    },
    printErr(text) {
      diagnostics.push({ level: 'stderr', text: String(text) });
    },
    wasmBinary,
  });

  manifold.setup();
  const solid = manifold.Manifold.cube([2, 3, 4], true);
  try {
    const mesh = solid.getMesh();
    const stats = {
      bounds: solid.boundingBox(),
      numTri: mesh.numTri,
      numVert: mesh.numVert,
      surfaceArea: solid.surfaceArea(),
      volume: solid.volume(),
    };

    assert(stats.numTri === 12, `Expected cube numTri=12, received ${stats.numTri}`);
    assert(stats.numVert === 8, `Expected cube numVert=8, received ${stats.numVert}`);
    assert(stats.volume === 24, `Expected cube volume=24, received ${stats.volume}`);
    assert(stats.surfaceArea === 52, `Expected cube surfaceArea=52, received ${stats.surfaceArea}`);

    parentPort.postMessage({
      diagnostics,
      embeddedWasmBytes: wasmBinary.byteLength,
      locateFileCalls,
      manifoldVersion: MANIFOLD_VERSION,
      ok: true,
      stats,
    });
  } finally {
    solid.delete();
  }
}

async function workerEntry() {
  try {
    await runModelWorker();
  } catch (error) {
    parentPort?.postMessage({
      error: serializeError(error),
      ok: false,
    });
  }
}

async function executeModelWorker() {
  const worker = new Worker(import.meta.url, {
    workerData: { role: 'model-worker' },
  });

  let timeout;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for the embedded Manifold worker'));
      }, 30_000);

      worker.once('error', reject);
      worker.once('exit', code => {
        if (code !== 0) {
          reject(new Error(`Embedded Manifold worker exited with code ${code}`));
        }
      });
      worker.once('message', message => {
        if (!message?.ok) {
          const details = message?.error?.stack ?? message?.error?.message ?? String(message);
          reject(new Error(`Embedded Manifold worker failed: ${details}`));
          return;
        }
        resolve(message);
      });
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
  return {
    ...result,
    cleanShutdown: true,
  };
}

async function verifyAssetServer(baseUrl) {
  const verified = [];
  for (const [pathname, asset] of ASSET_MANIFEST) {
    const response = await requestBytes(new URL(pathname.slice(1), baseUrl));
    assert(response.statusCode === 200, `${pathname} returned HTTP ${response.statusCode}`);
    assert(response.headers['content-type'] === asset.contentType, `${pathname} returned unexpected Content-Type`);
    assert(response.body.equals(asset.bytes), `${pathname} response differed byte-for-byte`);
    verified.push({
      bytes: asset.bytes.byteLength,
      path: pathname,
      sha256: createHash('sha256').update(response.body).digest('hex'),
    });
  }

  const rootResponse = await requestBytes(baseUrl);
  assert(rootResponse.statusCode === 200, `/ returned HTTP ${rootResponse.statusCode}`);
  assert(
    rootResponse.body.equals(ASSET_MANIFEST.get('/index.html').bytes),
    '/ did not serve the exact embedded /index.html bytes',
  );

  const missingResponse = await requestBytes(new URL('missing.bin', baseUrl));
  assert(missingResponse.statusCode === 404, 'Missing asset did not return HTTP 404');
  return verified;
}

async function runSelfTest() {
  let entry;
  let assets;
  let worker;
  try {
    entry = await startAssetServer();
    assets = await verifyAssetServer(entry.url);
    worker = await executeModelWorker();
  } finally {
    if (entry) {
      await closeServer(entry.server);
    }
  }
  return {
    assets,
    canvasSdkImported: false,
    cleanShutdown: !entry.server.listening && worker.cleanShutdown,
    http: {
      address: '127.0.0.1',
      byteForByteVerified: true,
    },
    singleFileWorker: true,
    worker,
  };
}

async function loadCopilotAdapter() {
  const sdk = await import('@github/copilot-sdk/extension');
  if (typeof sdk.joinSession !== 'function' || typeof sdk.createCanvas !== 'function') {
    throw new Error('@github/copilot-sdk/extension did not provide joinSession/createCanvas');
  }
  return {
    createCanvas: sdk.createCanvas,
    joinSession: sdk.joinSession,
  };
}

async function runExtensionMain(adapter) {
  const extensionAdapter = adapter ?? (await loadCopilotAdapter());
  const servers = new Map();
  const canvas = extensionAdapter.createCanvas({
    id: 'single-file-manifold-spike',
    displayName: 'Single-file Manifold spike',
    description: 'Serves an embedded representative viewer and runs embedded Manifold WASM in a worker.',
    open: async context => {
      let entry = servers.get(context.instanceId);
      if (!entry) {
        entry = await startAssetServer();
        servers.set(context.instanceId, entry);
      }
      return {
        title: 'Single-file Manifold spike',
        url: entry.url,
      };
    },
    onClose: async context => {
      const entry = servers.get(context.instanceId);
      if (entry) {
        servers.delete(context.instanceId);
        await closeServer(entry.server);
      }
    },
  });

  return extensionAdapter.joinSession({ canvases: [canvas] });
}

try {
  if (!isMainThread) {
    if (workerData?.role !== 'model-worker') {
      throw new Error(`Unknown worker role: ${String(workerData?.role)}`);
    }
    await workerEntry();
  } else if (process.argv.includes('--self-test')) {
    const result = await runSelfTest();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    await runExtensionMain();
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: serializeError(error) })}\n`);
  process.exitCode = 1;
}
