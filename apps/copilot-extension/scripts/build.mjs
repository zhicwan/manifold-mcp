import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { bundleApplication } from '../../../scripts/bundle-application.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const result = await bundleApplication({
  entryFile: resolve(appRoot, 'src/entry.ts'),
  outputFile: resolve(appRoot, 'dist/extension.mjs'),
  viewerRoot: resolve(appRoot, 'build/viewer'),
  sdk: true,
  minify: process.env.MANIFOLD_EXTENSION_DEBUG_BUNDLE !== '1',
});
await rm(resolve(appRoot, 'build'), { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ output: 'apps/copilot-extension/dist/extension.mjs', ...result })}\n`);
