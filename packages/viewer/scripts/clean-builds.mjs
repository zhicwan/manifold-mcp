import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const viewerDirectory = resolve(import.meta.dirname, '..');

await Promise.all([
  rm(resolve(viewerDirectory, 'dist/flat'), { force: true, recursive: true }),
  rm(resolve(viewerDirectory, '../viewer-host/dist/public'), { force: true, recursive: true }),
]);
