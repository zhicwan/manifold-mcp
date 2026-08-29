#!/usr/bin/env node

import { access, copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const publicPackage = resolve(repositoryRoot, 'packages/manifold3d-mcp');
const generatedDocs = ['README.md', 'LICENSE', 'NOTICE'];
const internalPackages = ['protocol', 'modeling', 'viewer-host'];
const stagedScope = resolve(publicPackage, 'node_modules/@manifold3d');

async function clean() {
  await Promise.all([
    rm(resolve(publicPackage, 'node_modules'), { force: true, recursive: true }),
    ...generatedDocs.map(file => rm(resolve(publicPackage, file), { force: true })),
  ]);
}

if (process.argv.includes('--clean')) {
  await clean();
  process.exit(0);
}

await clean();

const requiredBuildFiles = [
  'packages/protocol/dist/wire/annotations.js',
  'packages/protocol/dist/wire/host-actions.js',
  'packages/protocol/dist/wire/model.js',
  'packages/modeling/dist/modeling.js',
  'packages/modeling/dist/runner/model-artifact.js',
  'packages/modeling/dist/runner/worker.js',
  'packages/viewer-host/dist/preview/preview-server.js',
  'packages/viewer-host/dist/viewer-host.js',
  'packages/viewer-host/dist/public/index.html',
  'packages/manifold3d-mcp/dist/server/index.js',
];
for (const file of requiredBuildFiles) {
  await access(resolve(repositoryRoot, file));
}

await mkdir(stagedScope, { recursive: true });
for (const name of internalPackages) {
  const source = resolve(repositoryRoot, 'packages', name);
  const target = resolve(stagedScope, name);
  await mkdir(target, { recursive: true });
  await Promise.all([
    copyFile(resolve(source, 'package.json'), resolve(target, 'package.json')),
    cp(resolve(source, 'dist'), resolve(target, 'dist'), {
      filter: sourcePath => !sourcePath.endsWith('.map') && !sourcePath.endsWith('.tsbuildinfo'),
      recursive: true,
    }),
  ]);
}

await Promise.all(
  generatedDocs.map(file => copyFile(resolve(repositoryRoot, file), resolve(publicPackage, basename(file)))),
);
