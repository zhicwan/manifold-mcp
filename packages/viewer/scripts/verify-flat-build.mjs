import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const viewerDirectory = resolve(import.meta.dirname, '..');
const flatDirectory = resolve(viewerDirectory, 'dist/flat');
const defaultDirectory = resolve(viewerDirectory, '../../apps/manifold3d-mcp/build/viewer');
const forbiddenImplementationMarkers = [
  '/packages/viewer/src/xr/',
  'immersive-vr',
  'WebXR is not available',
  '.xr.enabled=!0',
  '.xr.enabled=true',
];

const flatJavaScript = await readJavaScript(flatDirectory);
const defaultJavaScript = await readJavaScript(defaultDirectory);
const flatSource = flatJavaScript.map(file => file.source).join('\n');
const defaultSource = defaultJavaScript.map(file => file.source).join('\n');
const moduleIds = await readFile(resolve(flatDirectory, 'flat-modules.json'), 'utf8');

for (const marker of forbiddenImplementationMarkers) {
  assert(!flatSource.includes(marker), `Flat Viewer output contains XR implementation marker: ${marker}`);
}
assert(!moduleIds.includes('/packages/viewer/src/xr/'), 'Flat Viewer module graph contains packages/viewer/src/xr');
assert(defaultSource.includes('immersive-vr'), 'Default Viewer output does not contain the immersive composition.');

const flatBytes = flatJavaScript.reduce((sum, file) => sum + file.bytes, 0);
const defaultBytes = defaultJavaScript.reduce((sum, file) => sum + file.bytes, 0);
assert(
  flatBytes < defaultBytes,
  `Expected flat Viewer JavaScript (${flatBytes} bytes) to be smaller than default (${defaultBytes} bytes).`,
);

process.stdout.write(`Flat Viewer verified: ${flatBytes} bytes, default XR Viewer: ${defaultBytes} bytes.\n`);

async function readJavaScript(directory) {
  const entries = await walk(directory);
  const files = entries.filter(file => file.endsWith('.js'));
  assert(files.length > 0, `No JavaScript output found under ${directory}`);
  return Promise.all(
    files.map(async file => ({
      source: await readFile(file, 'utf8'),
      bytes: (await stat(file)).size,
    })),
  );
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(entry => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return paths.flat();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
