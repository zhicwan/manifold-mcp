#!/usr/bin/env node

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const tempDirectory = resolve(repositoryRoot, '.test-tmp');
await rm(tempDirectory, { force: true, recursive: true });
await mkdir(tempDirectory, { recursive: true });

const executable = resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const vitestArgs = ['--config', 'vitest.config.ts', ...args.filter(arg => arg !== '--watch')];
if (!watch) {
  vitestArgs.unshift('run');
}

try {
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [executable, ...vitestArgs], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TEMP: tempDirectory,
        TMP: tempDirectory,
        TMPDIR: tempDirectory,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', exitCode => resolvePromise(exitCode ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(tempDirectory, { force: true, recursive: true });
}
