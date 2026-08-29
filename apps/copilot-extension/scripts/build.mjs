#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

const appRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(appRoot, '../..');
const viewerRoot = resolve(appRoot, 'build/viewer');
const outputFile = resolve(appRoot, 'dist/extension.mjs');
const entryFile = resolve(appRoot, 'src/entry.ts');
const manifoldWasmPath = fileURLToPath(import.meta.resolve('manifold-3d/manifold.wasm'));
const typeScriptLibRoot = dirname(fileURLToPath(import.meta.resolve('typescript')));
const MAX_ASSETS = 256;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

const [viewerAssets, wasm, typeScriptLib] = await Promise.all([
  readViewerAssets(),
  readFile(manifoldWasmPath),
  readTypeScriptLib(),
]);
assertWasm(wasm);

await rm(dirname(outputFile), { force: true, recursive: true });
await mkdir(dirname(outputFile), { recursive: true });

const build = await rolldown({
  input: entryFile,
  platform: 'node',
  external: id => id.startsWith('node:') || id === '@github/copilot-sdk/extension',
  plugins: [embeddedResourcesPlugin(viewerAssets, wasm, typeScriptLib)],
  treeshake: true,
});
try {
  await build.write({
    file: outputFile,
    format: 'es',
    codeSplitting: false,
    minify: process.env.MANIFOLD_EXTENSION_DEBUG_BUNDLE === '1' ? false : true,
    sourcemap: false,
    banner: [
      `// manifold3d Copilot CLI Extension; generated from ${relative(repositoryRoot, entryFile)}`,
      'import { fileURLToPath as __manifoldFileURLToPath } from "node:url";',
      'import { dirname as __manifoldDirname } from "node:path";',
      'const __filename=__manifoldFileURLToPath(import.meta.url);',
      'const __dirname=__manifoldDirname(__filename);',
    ].join('\n'),
  });
} finally {
  await build.close();
}
await chmod(outputFile, 0o755);
await rm(resolve(appRoot, 'build'), { force: true, recursive: true });

const output = await stat(outputFile);
process.stdout.write(
  `${JSON.stringify({
    output: relative(repositoryRoot, outputFile),
    bytes: output.size,
    viewerAssets: viewerAssets.length,
    viewerBytes: viewerAssets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0),
    wasmBytes: wasm.byteLength,
    wasmSha256: sha256(wasm),
    typeScriptLibBytes: typeScriptLib.byteLength,
  })}\n`,
);

async function readViewerAssets() {
  const files = await walk(viewerRoot);
  if (files.length === 0 || files.length > MAX_ASSETS) {
    throw new Error(`Extension Viewer must contain between 1 and ${MAX_ASSETS} assets.`);
  }
  const assets = [];
  let totalBytes = 0;
  for (const absolutePath of files) {
    const path = relative(viewerRoot, absolutePath).split(sep).join('/');
    if (!isSafeAssetPath(path)) {
      throw new Error(`Extension Viewer emitted unsafe asset path: ${path}`);
    }
    if (/\.(?:map|woff2?|ttf|otf)$/i.test(path)) {
      throw new Error(`Extension Viewer emitted forbidden font/source-map asset: ${path}`);
    }
    const bytes = await readFile(absolutePath);
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`Extension Viewer asset ${path} exceeds ${MAX_ASSET_BYTES} bytes.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_MANIFEST_BYTES) {
      throw new Error(`Extension Viewer assets exceed ${MAX_MANIFEST_BYTES} bytes.`);
    }
    assets.push({
      path,
      bytes,
      contentType: mime(path),
      sha256: sha256(bytes),
    });
  }
  if (!assets.some(asset => asset.path === 'index.html')) {
    throw new Error('Extension Viewer build did not emit index.html.');
  }
  return assets;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`Extension Viewer build contains unsupported entry: ${path}`);
    }
  }
  return files;
}

async function readTypeScriptLib() {
  const seen = new Set();
  const chunks = [];
  const visit = async name => {
    const fileName = `lib.${name.toLowerCase()}.d.ts`;
    if (seen.has(fileName)) {
      return;
    }
    seen.add(fileName);
    const source = await readFile(resolve(typeScriptLibRoot, fileName), 'utf8');
    const references = [...source.matchAll(/^\s*\/\/\/\s*<reference\s+lib=["']([^"']+)["']\s*\/>\s*$/gim)].map(
      match => match[1],
    );
    for (const reference of references) {
      await visit(reference);
    }
    const stripped = source.replace(/^\s*\/\/\/\s*<reference\s+[^>]+\/>\s*$/gim, '');
    chunks.push(`// ${fileName}\n${stripped}`);
  };
  await visit('es2022');
  return Buffer.from(chunks.join('\n'), 'utf8');
}

function embeddedResourcesPlugin(assets, wasmBytes, typeScriptLibBytes) {
  const moduleId = 'virtual:manifold-extension-resources';
  const resolvedId = `\0${moduleId}`;
  return {
    name: 'embedded-manifold-extension-resources',
    resolveId(id) {
      return id === moduleId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) {
        return null;
      }
      const manifest = assets
        .map(
          asset =>
            `[${JSON.stringify(asset.path)},{bytes:Buffer.from(${JSON.stringify(
              asset.bytes.toString('base64'),
            )},"base64"),contentType:${JSON.stringify(asset.contentType)}}]`,
        )
        .join(',');
      const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
      return [
        'import { Buffer } from "node:buffer";',
        `export const embeddedViewerAssets=new Map([${manifest}]);`,
        `export const embeddedViewerAssetCount=${assets.length};`,
        `export const embeddedViewerAssetBytes=${totalBytes};`,
        `export const embeddedManifoldWasmBase64=${JSON.stringify(wasmBytes.toString('base64'))};`,
        `export const embeddedManifoldWasmBytes=${wasmBytes.byteLength};`,
        `export const embeddedManifoldWasmSha256=${JSON.stringify(sha256(wasmBytes))};`,
        `export const embeddedTypeScriptLibBase64=${JSON.stringify(typeScriptLibBytes.toString('base64'))};`,
        `export const embeddedTypeScriptLibBytes=${typeScriptLibBytes.byteLength};`,
      ].join('\n');
    },
  };
}

function isSafeAssetPath(path) {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function assertWasm(bytes) {
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('Installed manifold.wasm is invalid.');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mime(path) {
  if (path.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (path.endsWith('.js') || path.endsWith('.mjs')) {
    return 'text/javascript; charset=utf-8';
  }
  if (path.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (path.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (path.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (path.endsWith('.png')) {
    return 'image/png';
  }
  return 'application/octet-stream';
}
