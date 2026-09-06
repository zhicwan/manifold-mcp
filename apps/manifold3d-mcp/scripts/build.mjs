import { resolve } from 'node:path';
import process from 'node:process';

import { bundleApplication } from '../../../scripts/bundle-application.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const result = await bundleApplication({
  entryFile: resolve(appRoot, 'src/entry.ts'),
  outputFile: resolve(appRoot, 'dist/manifold.mjs'),
  viewerRoot: resolve(appRoot, 'build/viewer'),
});
process.stdout.write(`${JSON.stringify({ output: 'apps/manifold3d-mcp/dist/manifold.mjs', ...result })}\n`);
