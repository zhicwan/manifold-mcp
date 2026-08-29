#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const generatedPaths = [
  'dist',
  'packages/protocol/dist',
  'packages/modeling/dist',
  'packages/viewer/dist',
  'packages/viewer-host/dist',
  'packages/manifold3d-mcp/dist',
  'packages/manifold3d-mcp/node_modules',
  'packages/manifold3d-mcp/README.md',
  'packages/manifold3d-mcp/LICENSE',
  'packages/manifold3d-mcp/NOTICE',
  'apps/copilot-extension/build',
  'apps/copilot-extension/dist',
  'apps/copilot-extension/.verify-empty',
  'apps/copilot-extension/.test-workspace',
];

await Promise.all(generatedPaths.map(path => rm(resolve(repositoryRoot, path), { force: true, recursive: true })));
