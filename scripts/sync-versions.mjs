#!/usr/bin/env node

/**
 * Propagate the public workspace package version to every other manifest that
 * must move in lockstep, and to the `@x.y.x` range in `plugin/.mcp.json`. Run
 * as that workspace's npm `version` lifecycle script so an `npm version <bump>
 * --workspace @zhicwan/manifold3d-mcp` keeps everything in sync.
 *
 * Uses targeted, format-preserving string replacement (not full JSON
 * re-serialization) so it does not reflow unrelated formatting. `check-sync.mjs`
 * asserts the result is consistent.
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

const version = JSON.parse(read(publicPackagePath)).version;
const semver = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
if (!semver) {
  process.stderr.write(`sync-versions: invalid ${publicPackagePath} version "${version}"\n`);
  process.exit(1);
}
const [, major, minor] = semver;
const range = `${major}.${minor}.x`;

const changed = [];

/** Replace the first top-level `"version": "..."` value in a JSON document. */
function replaceTopLevelVersion(relativePath) {
  const before = read(relativePath);
  const after = before.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (after !== before) {
    write(relativePath, after);
    changed.push(relativePath);
  }
}

/**
 * Replace the version of the `manifold` plugin entry inside a marketplace
 * document, without touching the top-level `metadata.version`.
 */
function replaceMarketplacePluginVersion(relativePath) {
  const before = read(relativePath);
  const after = before.replace(/("name"\s*:\s*"manifold"[\s\S]*?"version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (after !== before) {
    write(relativePath, after);
    changed.push(relativePath);
  }
}

/** Repin the `@zhicwan/manifold3d-mcp@x.y.x` range in plugin/.mcp.json. */
function replaceMcpRange(relativePath) {
  const before = read(relativePath);
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escaped}@)\\d+\\.\\d+\\.(?:\\d+|x)`, 'g');
  const after = before.replace(pattern, `$1${range}`);
  if (after !== before) {
    write(relativePath, after);
    changed.push(relativePath);
  }
}

replaceTopLevelVersion('plugin/plugin.json');
replaceTopLevelVersion('plugin/.claude-plugin/plugin.json');
replaceMarketplacePluginVersion('.github/plugin/marketplace.json');
replaceMarketplacePluginVersion('.claude-plugin/marketplace.json');
replaceMcpRange('plugin/.mcp.json');

if (changed.length === 0) {
  process.stdout.write(`sync-versions: already in sync at ${version}\n`);
} else {
  process.stdout.write(
    `sync-versions: set version ${version} / range @${range} in:\n${changed.map(path => `  - ${path}`).join('\n')}\n`,
  );
}
