#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');

await Promise.all([
  rm(resolve(appRoot, 'build'), { force: true, recursive: true }),
  rm(resolve(appRoot, 'dist'), { force: true, recursive: true }),
  rm(resolve(appRoot, '.verify-empty'), { force: true, recursive: true }),
  rm(resolve(appRoot, '.test-workspace'), { force: true, recursive: true }),
]);
