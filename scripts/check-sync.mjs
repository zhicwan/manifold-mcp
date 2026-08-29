#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicPackagePath = 'packages/manifold3d-mcp/package.json';
const packageName = '@zhicwan/manifold3d-mcp';
const failures = [];

function readText(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  const text = readText(relativePath);
  try {
    return JSON.parse(text);
  } catch (error) {
    // A common cause is a symlink that Git materialized as a plain text file
    // (e.g. a Windows checkout without symlink support), leaving the target
    // path rather than JSON in the file.
    addFailure(
      `${relativePath} is not valid JSON (${error.message}). If it is a Git ` +
        `symlink materialized as text on Windows, enable core.symlinks or ` +
        `replace it with a real file.`,
    );
    return undefined;
  }
}

function addFailure(message) {
  failures.push(message);
}

function uniqSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function versionMajorMinor(version) {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/.exec(version);
  if (!match?.groups) {
    addFailure(`Invalid semver version: ${version}`);
    return undefined;
  }
  return `${match.groups.major}.${match.groups.minor}`;
}

function checkVersions() {
  const packageJson = readJson(publicPackagePath);
  const pluginJson = readJson('plugin/plugin.json');
  const claudePluginJson = readJson('plugin/.claude-plugin/plugin.json');
  const marketplaceJson = readJson('.claude-plugin/marketplace.json');
  const pluginMcpJson = readJson('plugin/.mcp.json');

  if (!packageJson || !pluginJson || !claudePluginJson || !marketplaceJson || !pluginMcpJson) {
    // readJson already recorded a clear failure for the unparseable file(s).
    return;
  }

  const marketplacePlugin = marketplaceJson.plugins?.find(plugin => plugin?.name === 'manifold');
  if (!marketplacePlugin) {
    addFailure('.claude-plugin/marketplace.json does not contain a plugin entry named "manifold".');
    return;
  }

  const expectedVersion = packageJson.version;
  const versions = [
    [publicPackagePath, packageJson.version],
    ['plugin/plugin.json', pluginJson.version],
    ['plugin/.claude-plugin/plugin.json', claudePluginJson.version],
    ['.claude-plugin/marketplace.json plugins[name=manifold]', marketplacePlugin.version],
  ];
  const mismatches = versions.filter(([, version]) => version !== expectedVersion);
  if (mismatches.length > 0) {
    addFailure(
      [
        `Package/plugin versions must match ${publicPackagePath}:`,
        ...versions.map(([label, version]) => `  - ${label}: ${version}`),
      ].join('\n'),
    );
  }

  const serverConfig = pluginMcpJson.mcpServers?.['manifold3d-mcp'];
  const args = Array.isArray(serverConfig?.args) ? serverConfig.args : [];
  const packageArg = args.find(arg => typeof arg === 'string' && arg.startsWith(`${packageName}@`));
  if (!packageArg) {
    addFailure(
      `plugin/.mcp.json args must include a versioned ${packageName}@x.y.z or ${packageName}@x.y.x package spec.`,
    );
    return;
  }

  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rangeMatch = new RegExp(`^${escapedPackageName}@(\\d+)\\.(\\d+)\\.(?:\\d+|x)$`).exec(packageArg);
  if (!rangeMatch) {
    addFailure(
      `plugin/.mcp.json package spec must be ${packageName}@x.y.z or ${packageName}@x.y.x; found ${packageArg}.`,
    );
    return;
  }

  const packageMajorMinor = versionMajorMinor(expectedVersion);
  const rangeMajorMinor = `${rangeMatch[1]}.${rangeMatch[2]}`;
  if (packageMajorMinor && rangeMajorMinor !== packageMajorMinor) {
    addFailure(
      `plugin/.mcp.json package range ${packageArg} must share ${publicPackagePath} major.minor ${packageMajorMinor}.`,
    );
  }
}

function readServerToolNames() {
  const sourcePath = 'packages/manifold3d-mcp/src/server/mcp/mcp-server.ts';
  const source = readText(sourcePath);
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidates = [];
  const propertyName = name => (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined);

  const visit = node => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'tools' &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      candidates.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (candidates.length !== 1) {
    addFailure(`Expected exactly one MCP tools array in ${sourcePath}; found ${candidates.length}.`);
    return [];
  }

  const names = [];
  for (const element of candidates[0].elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      addFailure(`Every MCP tool definition in ${sourcePath} must be an object literal.`);
      return [];
    }
    const nameProperty = element.properties.find(
      property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'name',
    );
    if (!nameProperty || !ts.isPropertyAssignment(nameProperty) || !ts.isStringLiteralLike(nameProperty.initializer)) {
      addFailure(`Every MCP tool definition in ${sourcePath} must have a string-literal name.`);
      return [];
    }
    names.push(nameProperty.initializer.text);
  }
  return uniqSorted(names);
}

function readSkillToolNames() {
  const skill = readText('plugin/skills/use-manifold/SKILL.md');
  const toolsHeading = skill.match(/^## Tools\s*$/m);
  if (!toolsHeading) {
    addFailure('Could not find a "## Tools" section in plugin/skills/use-manifold/SKILL.md.');
    return [];
  }

  const afterTools = skill.slice(toolsHeading.index + toolsHeading[0].length);
  const nextHeading = afterTools.search(/^## /m);
  const toolsSection = nextHeading < 0 ? afterTools : afterTools.slice(0, nextHeading);
  return uniqSorted([...toolsSection.matchAll(/\*\*`([^`]+)`\*\*/g)].map(match => match[1]));
}

function formatList(values) {
  return values.length === 0 ? '  (none)' : values.map(value => `  - ${value}`).join('\n');
}

function checkToolDocs() {
  const serverTools = readServerToolNames();
  const skillTools = readSkillToolNames();

  const missingFromSkill = serverTools.filter(tool => !skillTools.includes(tool));
  const extraInSkill = skillTools.filter(tool => !serverTools.includes(tool));
  if (missingFromSkill.length > 0 || extraInSkill.length > 0) {
    addFailure(
      [
        'SKILL.md tool list must match MCP server registered tools.',
        'Server tools:',
        formatList(serverTools),
        'Skill tools:',
        formatList(skillTools),
        'Missing from SKILL.md:',
        formatList(missingFromSkill),
        'Documented in SKILL.md but not registered by the server:',
        formatList(extraInSkill),
      ].join('\n'),
    );
  }
}

function checkMarketplaceCopies() {
  // `.claude-plugin/marketplace.json` and `.github/plugin/marketplace.json`
  // must stay byte-identical (they used to be a symlink; they are now two real
  // files so Windows checkouts get real JSON). sync-versions.mjs keeps both in
  // step; this guard catches any divergence.
  let a;
  let b;
  try {
    a = readText('.claude-plugin/marketplace.json');
  } catch (error) {
    addFailure(`Could not read .claude-plugin/marketplace.json: ${error.message}`);
    return;
  }
  try {
    b = readText('.github/plugin/marketplace.json');
  } catch (error) {
    addFailure(`Could not read .github/plugin/marketplace.json: ${error.message}`);
    return;
  }
  if (a !== b) {
    addFailure(
      '.claude-plugin/marketplace.json and .github/plugin/marketplace.json must be ' +
        'byte-identical. Run `node scripts/sync-versions.mjs` or copy one over the other.',
    );
  }
}

checkVersions();
checkMarketplaceCopies();
checkToolDocs();

if (failures.length > 0) {
  process.stderr.write(`Sync check failed:\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

process.stdout.write('Sync check passed: versions, plugin MCP range, and skill tool docs are aligned.\n');
