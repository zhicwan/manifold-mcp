import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

const repositoryRoot = resolve(import.meta.dirname, '..');
const resourceModule = 'virtual:manifold-resources';

export async function bundleApplication({ entryFile, outputFile, viewerRoot, sdk = false, minify = true }) {
  const [assets, wasm, declarations, packageJson] = await Promise.all([
    readAssets(viewerRoot),
    readFile(fileURLToPath(import.meta.resolve('manifold-3d/manifold.wasm'))),
    readTypeScriptLib(),
    readFile(resolve(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  if (typeof packageJson.version !== 'string') {
    throw new Error('The workspace must declare the product version.');
  }
  await mkdir(dirname(outputFile), { recursive: true });
  const build = await rolldown({
    input: entryFile,
    platform: 'node',
    external: id => id.startsWith('node:') || (sdk && id === '@github/copilot-sdk/extension'),
    plugins: [
      {
        name: 'embedded-manifold-resources',
        resolveId: id => (id === resourceModule ? `\0${resourceModule}` : null),
        load(id) {
          if (id !== `\0${resourceModule}`) {
            return null;
          }
          const manifest = assets
            .map(
              asset =>
                `[${JSON.stringify(asset.path)},{bytes:Buffer.from(${JSON.stringify(asset.bytes.toString('base64'))},"base64"),contentType:${JSON.stringify(asset.contentType)}}]`,
            )
            .join(',');
          return [
            'import { Buffer } from "node:buffer";',
            `export const applicationVersion=${JSON.stringify(packageJson.version)};`,
            `export const embeddedViewerAssets=new Map([${manifest}]);`,
            `export const embeddedViewerAssetCount=${assets.length};`,
            `export const embeddedViewerAssetBytes=${assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0)};`,
            `export const embeddedManifoldWasmBase64=${JSON.stringify(wasm.toString('base64'))};`,
            `export const embeddedManifoldWasmBytes=${wasm.byteLength};`,
            `export const embeddedManifoldWasmSha256=${JSON.stringify(createHash('sha256').update(wasm).digest('hex'))};`,
            `export const embeddedTypeScriptLibBase64=${JSON.stringify(declarations.toString('base64'))};`,
            `export const embeddedTypeScriptLibBytes=${declarations.byteLength};`,
          ].join('\n');
        },
      },
    ],
  });
  try {
    const result = await build.write({
      file: outputFile,
      format: 'es',
      codeSplitting: false,
      minify,
      comments: { legal: true, annotation: false, jsdoc: false },
      sourcemap: false,
      banner: [
        `// manifold3d ${packageJson.version}; generated from ${relative(repositoryRoot, entryFile).split(sep).join('/')}`,
        '// SPDX-License-Identifier: Apache-2.0',
        'import { fileURLToPath as __manifoldFileURLToPath } from "node:url";',
        'import { dirname as __manifoldDirname } from "node:path";',
        'const __filename=__manifoldFileURLToPath(import.meta.url);',
        'const __dirname=__manifoldDirname(__filename);',
      ].join('\n'),
    });
    const licenses = [
      await readFile(resolve(repositoryRoot, 'LICENSE'), 'utf8'),
      await readFile(resolve(repositoryRoot, 'NOTICE'), 'utf8'),
      await readFile(resolve(viewerRoot, 'third-party-licenses.txt'), 'utf8'),
      await dependencyLicenses(result.output),
    ].join('\n\n');
    await appendFile(
      outputFile,
      `\n${licenses
        .split(/\r\n|\r|\n|\u2028|\u2029/u)
        .map(line => `// ${line}`.trimEnd())
        .join('\n')}\n`,
    );
  } finally {
    await build.close();
  }
  await chmod(outputFile, 0o755);
  return { bytes: (await stat(outputFile)).size, assets: assets.length };
}

async function dependencyLicenses(outputs) {
  const packages = new Set();
  for (const chunk of outputs) {
    if (chunk.type !== 'chunk') {
      continue;
    }
    for (const id of Object.keys(chunk.modules)) {
      const path = id.split('\\').join('/');
      const marker = path.lastIndexOf('/node_modules/');
      if (marker < 0 || path.startsWith('\0')) {
        continue;
      }
      const parts = path.slice(marker + 14).split('/');
      const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      packages.add(resolve(path.slice(0, marker + 14), name));
    }
  }
  const notices = [];
  for (const directory of [...packages].sort()) {
    const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory))
      .filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name))
      .sort();
    if (files.length === 0) {
      throw new Error(`Bundled dependency ${metadata.name} is missing its redistribution license.`);
    }
    for (const file of files) {
      notices.push(`${metadata.name}@${metadata.version}\n${await readFile(resolve(directory, file), 'utf8')}`);
    }
  }
  return notices.join('\n\n');
}

async function readAssets(root) {
  const assets = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        assets.push({
          path: relative(root, path).split(sep).join('/'),
          bytes: await readFile(path),
          contentType: contentType(path),
        });
      } else {
        throw new Error(`Unsupported Viewer asset: ${path}`);
      }
    }
  };
  await visit(root);
  if (!assets.some(asset => asset.path === 'index.html')) {
    throw new Error('Viewer build did not emit index.html.');
  }
  return assets;
}

async function readTypeScriptLib() {
  const root = dirname(fileURLToPath(import.meta.resolve('typescript')));
  const seen = new Set();
  const chunks = [];
  const visit = async name => {
    const file = `lib.${name.toLowerCase()}.d.ts`;
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const source = await readFile(resolve(root, file), 'utf8');
    for (const match of source.matchAll(/^\s*\/\/\/\s*<reference\s+lib=["']([^"']+)["']\s*\/>\s*$/gim)) {
      await visit(match[1]);
    }
    chunks.push(`// ${file}\n${source.replace(/^\s*\/\/\/\s*<reference\s+[^>]+\/>\s*$/gim, '')}`);
  };
  await visit('es2022');
  return Buffer.from(chunks.join('\n'), 'utf8');
}

function contentType(path) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extname(path)] ?? 'application/octet-stream';
}
