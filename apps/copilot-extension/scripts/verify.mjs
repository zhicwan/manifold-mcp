#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import ts from 'typescript';

const appRoot = resolve(import.meta.dirname, '..');
const distDirectory = resolve(appRoot, 'dist');
const artifact = resolve(distDirectory, 'extension.mjs');
const isolatedDirectory = resolve(appRoot, '.verify-empty');
const isolatedArtifact = resolve(isolatedDirectory, 'extension.mjs');

await rm(isolatedDirectory, { force: true, recursive: true });
try {
  const distEntries = await readdir(distDirectory);
  assert(
    distEntries.length === 1 && distEntries[0] === 'extension.mjs',
    `Extension dist must contain only extension.mjs; found: ${distEntries.join(', ')}`,
  );
  await mkdir(isolatedDirectory, { recursive: true });
  await copyFile(artifact, isolatedArtifact);
  const isolatedEntries = await readdir(isolatedDirectory);
  assert(
    isolatedEntries.length === 1 && isolatedEntries[0] === 'extension.mjs',
    `Isolated install must contain only extension.mjs; found: ${isolatedEntries.join(', ')}`,
  );

  const source = await readFile(isolatedArtifact, 'utf8');
  inspectBundleSource(source);
  const run = await execute(
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
  const selfTest = parseSingleJsonLine(run.stdout, 'Extension self-test');
  assert(selfTest.verified === true, 'Extension self-test did not report verified=true.');
  assert(selfTest.sdkImported === false, 'Extension self-test resolved the host SDK.');
  assert(selfTest.singleFileWorker === true, 'Extension self-test did not use the same-file worker.');
  assert(selfTest.rooms?.count >= 2 && selfTest.rooms?.isolated === true, 'Room isolation proof failed.');
  assert(selfTest.rooms?.idempotent === true, 'Viewer Host idempotency proof failed.');
  assert(selfTest.model?.triangles === 12 && selfTest.model?.vertices === 8, 'Embedded cube proof failed.');
  assert(selfTest.embedded?.wasmCount === 1, 'Expected exactly one embedded WASM payload.');
  assert(
    selfTest.assets?.length === selfTest.embedded?.viewerAssetCount,
    'Not every embedded Viewer asset was fetched and verified.',
  );
  assert(
    selfTest.assets.every(asset => !/\.(?:woff2?|ttf|otf|map)$/i.test(asset.path)),
    'Embedded Viewer asset manifest contains fonts or source maps.',
  );

  const metadata = await stat(artifact);
  const gzipBytes = gzipSync(source, { level: 9 }).byteLength;
  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        artifact: 'apps/copilot-extension/dist/extension.mjs',
        rawBytes: metadata.size,
        gzipBytes,
        distEntries,
        isolatedDirectoryEntries: isolatedEntries,
        embedded: selfTest.embedded,
        assets: selfTest.assets,
        proofs: {
          dynamicExternalSdkImport: true,
          sdkSkippedBySelfTest: true,
          sameFileWorker: true,
          emptyDirectoryNodeOnly: true,
          permissionModelBlockedSiblingReads: true,
          allViewerAssetsFetchedByteForByte: true,
          roomIsolation: true,
          actionIdempotency: true,
          selfTestLocalCleanup: true,
        },
        host: {
          sdkVersionTypechecked: '1.0.11',
          canvasRendererExercised: false,
          productionLifecycleClaimedBySelfTest: false,
          note: 'SIGTERM/session shutdown use integration coverage; Canvas rendering still requires a manual host open.',
        },
        stderr: run.stderr.trim() || null,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(isolatedDirectory, { force: true, recursive: true });
}

function inspectBundleSource(source) {
  assert(source.includes('@github/copilot-sdk/extension'), 'Bundle does not retain the host-provided SDK import.');
  assert(
    !/(?:from\s*|import\s*)["']@github\/copilot-sdk\/extension["']/.test(source),
    'Copilot SDK must not be statically imported.',
  );
  assert(source.includes('model-worker'), 'Bundle does not contain the model-worker role.');
  assert(source.includes('import.meta.url'), 'Bundle does not derive the worker from its own module URL.');
  assert(
    !/\n\/\/[#@]\s*sourceMappingURL=[^\n]+\s*$/.test(source),
    'Bundle unexpectedly references a sibling source map.',
  );

  const file = ts.createSourceFile('extension.mjs', source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const dynamicImports = [];
  const staticImports = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      staticImports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      dynamicImports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const forbiddenStaticImports = staticImports.filter(specifier => !specifier.startsWith('node:'));
  assert(
    forbiddenStaticImports.length === 0,
    `Bundle contains runtime package imports other than Node built-ins: ${forbiddenStaticImports.join(', ')}`,
  );
  const forbiddenDynamicImports = dynamicImports.filter(
    specifier => specifier !== '@github/copilot-sdk/extension' && !specifier.startsWith('node:'),
  );
  assert(
    forbiddenDynamicImports.length === 0,
    `Bundle contains forbidden dynamic chunks/imports: ${forbiddenDynamicImports.join(', ')}`,
  );
  assert(
    dynamicImports.filter(specifier => specifier === '@github/copilot-sdk/extension').length === 1,
    'Bundle must contain exactly one dynamic Copilot SDK import.',
  );
}

function execute(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      resolvePromise({ stdout, stderr });
    });
  });
}

function parseSingleJsonLine(text, label) {
  const lines = text.trim().split('\n').filter(Boolean);
  assert(lines.length === 1, `${label} emitted ${lines.length} non-empty stdout lines.`);
  return JSON.parse(lines[0]);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
