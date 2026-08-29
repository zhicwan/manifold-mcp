#!/usr/bin/env node

/**
 * Propagate the public workspace package version to every other manifest that
 * must move in lockstep, and to the `@x.y.x` range in `plugin/.mcp.json`. Run
 * as that workspace's npm `version` lifecycle script so an `npm version <bump>
 * --workspace @zhicwan/manifold3d-mcp` keeps everything in sync.
 *
 * Updates explicit JSON fields so malformed manifests fail loudly instead of
 * being skipped by text replacement. `check-sync.mjs` asserts the result is
 * consistent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicPackagePath = 'packages/manifold3d-mcp/package.json';
const packageName = '@zhicwan/manifold3d-mcp';

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function write(relativePath, contents) {
  writeFileSync(resolve(repoRoot, relativePath), contents);
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    throw new Error(`Could not parse ${relativePath}: ${error.message}`, { cause: error });
  }
}

function writeJson(relativePath, value) {
  write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  changed.push(relativePath);
}

const publicPackage = readJson(publicPackagePath);
const version = publicPackage.version;
if (typeof version !== 'string') {
  throw new Error(`${publicPackagePath} must contain a string version.`);
}
const semver = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
if (!semver) {
  process.stderr.write(`sync-versions: invalid ${publicPackagePath} version "${version}"\n`);
  process.exit(1);
}
const [, major, minor] = semver;
const range = `${major}.${minor}.x`;

const changed = [];

function setTopLevelVersion(relativePath) {
  const manifest = readJson(relativePath);
  if (typeof manifest.version !== 'string') {
    throw new Error(`${relativePath} must contain a string top-level version.`);
  }
  if (manifest.version !== version) {
    manifest.version = version;
    writeJson(relativePath, manifest);
  }
}

function setMarketplacePluginVersion(relativePath) {
  const marketplace = readJson(relativePath);
  const plugin = marketplace.plugins?.find(candidate => candidate?.name === 'manifold');
  if (!plugin || typeof plugin.version !== 'string') {
    throw new Error(`${relativePath} must contain a versioned plugin entry named "manifold".`);
  }
  if (plugin.version !== version) {
    plugin.version = version;
    writeJson(relativePath, marketplace);
  }
}

function setMcpRange(relativePath) {
  const manifest = readJson(relativePath);
  const args = manifest.mcpServers?.['manifold3d-mcp']?.args;
  if (!Array.isArray(args)) {
    throw new Error(`${relativePath} must contain an args array for mcpServers.manifold3d-mcp.`);
  }
  const packageIndex = args.findIndex(arg => typeof arg === 'string' && arg.startsWith(`${packageName}@`));
  if (packageIndex < 0) {
    throw new Error(`${relativePath} must include a versioned ${packageName} package spec.`);
  }
  const packageSpec = `${packageName}@${range}`;
  if (args[packageIndex] !== packageSpec) {
    args[packageIndex] = packageSpec;
    writeJson(relativePath, manifest);
  }
}

setTopLevelVersion('plugin/plugin.json');
setTopLevelVersion('plugin/.claude-plugin/plugin.json');
setMarketplacePluginVersion('.github/plugin/marketplace.json');
setMarketplacePluginVersion('.claude-plugin/marketplace.json');
setMcpRange('plugin/.mcp.json');

if (changed.length === 0) {
  process.stdout.write(`sync-versions: already in sync at ${version}\n`);
} else {
  process.stdout.write(
    `sync-versions: set version ${version} / package spec ${packageName}@${range} in:\n${changed.map(path => `  - ${path}`).join('\n')}\n`,
  );
}
