import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(spikeDirectory, '.spike-output');
const generatedArtifact = resolve(outputDirectory, 'generated-extension.mjs');
const isolatedDirectory = resolve(outputDirectory, 'empty-directory');
const isolatedArtifact = resolve(isolatedDirectory, 'extension.mjs');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} failed (code=${code}, signal=${signal}):\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ stderr, stdout });
    });
  });
}

function parseSingleJsonLine(text, label) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${label} emitted ${lines.length} non-empty stdout lines`);
  }
  return JSON.parse(lines[0]);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await rm(outputDirectory, { force: true, recursive: true });

try {
  const generation = await run(process.execPath, [
    resolve(spikeDirectory, 'generate.mjs'),
    '--output',
    generatedArtifact,
  ]);
  const generated = parseSingleJsonLine(generation.stdout, 'generator');

  await mkdir(isolatedDirectory, { recursive: true });
  await copyFile(generatedArtifact, isolatedArtifact);
  const isolatedEntries = await readdir(isolatedDirectory);
  assert(
    isolatedEntries.length === 1 && isolatedEntries[0] === 'extension.mjs',
    `Expected isolated directory to contain only extension.mjs: ${isolatedEntries.join(', ')}`,
  );

  const artifactSource = await readFile(isolatedArtifact, 'utf8');
  assert(
    artifactSource.includes('new Worker(import.meta.url, {'),
    'Artifact does not spawn its worker from import.meta.url',
  );
  assert(
    /workerData:\s*\{\s*role:\s*['"]model-worker['"]\s*\}/.test(artifactSource),
    'Artifact does not mark the model-worker role',
  );
  assert(
    /await import\(['"]@github\/copilot-sdk\/extension['"]\)/.test(artifactSource),
    'Copilot SDK is not retained as a dynamic external import',
  );

  const selfTestRun = await run(
    process.execPath,
    ['--permission', '--allow-worker', `--allow-fs-read=${isolatedArtifact}`, isolatedArtifact, '--self-test'],
    {
      cwd: isolatedDirectory,
      env: {
        HOME: isolatedDirectory,
        PATH: process.env.PATH ?? '',
      },
    },
  );
  const selfTest = parseSingleJsonLine(selfTestRun.stdout, 'self-test');

  assert(selfTest.singleFileWorker === true, 'Single-file worker assertion failed');
  assert(selfTest.canvasSdkImported === false, 'Self-test imported the Copilot SDK');
  assert(selfTest.cleanShutdown === true, 'HTTP server did not shut down cleanly');
  assert(selfTest.worker?.cleanShutdown === true, 'Model worker did not shut down cleanly');
  assert(selfTest.http?.byteForByteVerified === true, 'HTTP byte verification failed');
  assert(selfTest.assets?.length === 3, 'Expected three embedded viewer assets');
  assert(selfTest.worker?.stats?.numTri === 12, 'Unexpected Manifold triangle count');
  assert(selfTest.worker?.stats?.numVert === 8, 'Unexpected Manifold vertex count');
  assert(selfTest.worker?.stats?.volume === 24, 'Unexpected Manifold volume');
  assert(selfTest.worker?.stats?.surfaceArea === 52, 'Unexpected Manifold surface area');
  assert(
    selfTest.worker?.embeddedWasmBytes === generated.wasmBytes,
    "Worker's embedded WASM size differs from the installed manifold.wasm",
  );
  assert(
    selfTest.worker?.locateFileCalls?.some(
      call =>
        call.path === 'manifold.wasm' && typeof call.prefix === 'string' && call.prefix.endsWith('/empty-directory/'),
    ),
    'Emscripten locateFile did not resolve from the isolated artifact',
  );

  const artifactStat = await stat(isolatedArtifact);
  process.stdout.write(
    `${JSON.stringify(
      {
        artifactBytes: artifactStat.size,
        assets: selfTest.assets,
        cleanShutdown: selfTest.cleanShutdown,
        isolatedDirectoryEntries: isolatedEntries,
        manifold: {
          embeddedWasmBytes: selfTest.worker.embeddedWasmBytes,
          locateFileCalls: selfTest.worker.locateFileCalls,
          stats: selfTest.worker.stats,
          version: selfTest.worker.manifoldVersion,
        },
        nodeFilesystemPermission: `read-only ${isolatedArtifact}`,
        sdk: {
          dynamicExternalImportPresent: true,
          importedDuringSelfTest: selfTest.canvasSdkImported,
        },
        verified: true,
        warnings: selfTestRun.stderr.trim() || null,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(outputDirectory, { force: true, recursive: true });
}
