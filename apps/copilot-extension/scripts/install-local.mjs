#!/usr/bin/env node

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

const appRoot = resolve(import.meta.dirname, '..');
const artifact = resolve(appRoot, 'dist/extension.mjs');
const copilotHome = resolve(process.env.COPILOT_HOME ?? resolve(homedir(), '.copilot'));
const installDirectory = resolve(copilotHome, 'extensions', 'manifold3d');
const destination = resolve(installDirectory, 'extension.mjs');

await readFile(artifact);
await mkdir(installDirectory, { recursive: true });
await copyFile(artifact, destination);
process.stdout.write(`${destination}\n`);
