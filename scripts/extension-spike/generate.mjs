import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(spikeDirectory, '../..');
const defaultOutput = resolve(spikeDirectory, '.spike-output/generated-extension.mjs');

function parseOutputPath(argv) {
  if (argv.length === 0) {
    return defaultOutput;
  }
  if (argv.length === 2 && argv[0] === '--output') {
    return resolve(argv[1]);
  }
  throw new Error('Usage: node scripts/extension-spike/generate.mjs [--output PATH]');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const outputPath = parseOutputPath(process.argv.slice(2));
const packageDirectory = resolve(repositoryRoot, 'node_modules/manifold-3d');
const [template, manifoldSource, wasm, packageJson] = await Promise.all([
  readFile(resolve(spikeDirectory, 'artifact-template.mjs'), 'utf8'),
  readFile(resolve(packageDirectory, 'manifold.js'), 'utf8'),
  readFile(resolve(packageDirectory, 'manifold.wasm')),
  readFile(resolve(packageDirectory, 'package.json'), 'utf8').then(JSON.parse),
]);

const exportMarker = 'export default Module;';
if (manifoldSource.split(exportMarker).length !== 2) {
  throw new Error('Installed manifold-3d/manifold.js did not contain exactly one expected default export');
}
if (!manifoldSource.includes('wasmBinary=Module["wasmBinary"]')) {
  throw new Error('Installed manifold-3d module does not expose Emscripten wasmBinary');
}
if (!manifoldSource.includes('locateFile("manifold.wasm")')) {
  throw new Error('Installed manifold-3d module does not use Emscripten locateFile');
}
if (wasm.byteLength < 8 || !wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  throw new Error('Installed manifold-3d/manifold.wasm is not a valid WebAssembly file');
}

const inlinedManifoldSource = manifoldSource.replace(exportMarker, '');
let artifact = template.replace('/*__MANIFOLD_MODULE_SOURCE__*/', inlinedManifoldSource);
artifact = artifact.replace('__MANIFOLD_VERSION__', packageJson.version);
artifact = artifact.replace('__MANIFOLD_WASM_BASE64__', wasm.toString('base64'));

if (
  artifact.includes('/*__MANIFOLD_MODULE_SOURCE__*/') ||
  artifact.includes('__MANIFOLD_VERSION__') ||
  artifact.includes('__MANIFOLD_WASM_BASE64__')
) {
  throw new Error('Generated artifact still contains an unreplaced placeholder');
}

const banner = `// Generated feasibility artifact; manifold-3d ${packageJson.version}; JS sha256 ${sha256(manifoldSource)}; WASM sha256 ${sha256(wasm)}.\n`;
artifact = banner + artifact;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, artifact, 'utf8');
await chmod(outputPath, 0o755);

const artifactStat = await stat(outputPath);
process.stdout.write(
  `${JSON.stringify({
    artifactBytes: artifactStat.size,
    manifoldJsBytes: Buffer.byteLength(manifoldSource),
    manifoldVersion: packageJson.version,
    outputPath,
    wasmBytes: wasm.byteLength,
  })}\n`,
);
