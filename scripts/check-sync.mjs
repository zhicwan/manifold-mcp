#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpSourcePath = 'apps/manifold3d-mcp/src/server/mcp/mcp-server.ts';
const canvasSourcePath = 'apps/copilot-extension/src/tools.ts';
const mcpSkillPath = 'skills/use-manifold/SKILL.md';
const canvasSkillPath = 'skills/use-manifold-canvas/SKILL.md';

export function collectMarkdownToolNames(markdown) {
  const toolsHeading = markdown.match(/^## Tools\s*$/m);
  if (!toolsHeading) {
    return { tools: [], error: 'Could not find a "## Tools" section.' };
  }
  const afterHeading = markdown.slice(toolsHeading.index + toolsHeading[0].length);
  const nextHeading = afterHeading.search(/^## /m);
  const toolsSection = nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading);
  return {
    tools: uniqSorted([...toolsSection.matchAll(/\*\*`([^`]+)`\*\*/g)].map(match => match[1])),
    error: null,
  };
}

export function collectSourceToolNames(sourceText, sourcePath = 'source.ts') {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidates = [];

  const visit = node => {
    if (ts.isArrayLiteralExpression(node)) {
      const names = [];
      let valid = true;
      for (const element of node.elements) {
        if (!ts.isObjectLiteralExpression(element)) {
          valid = false;
          break;
        }
        const nameProperty = element.properties.find(
          property => ts.isPropertyAssignment(property) && isPropertyName(property.name, 'name'),
        );
        if (
          !nameProperty ||
          !ts.isPropertyAssignment(nameProperty) ||
          !ts.isStringLiteralLike(nameProperty.initializer)
        ) {
          valid = false;
          break;
        }
        names.push(nameProperty.initializer.text);
      }
      if (valid && names.length > 0) {
        candidates.push(names);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (candidates.length !== 1) {
    return {
      tools: [],
      error: `Expected exactly one tool-definition array in ${sourcePath}; found ${candidates.length}.`,
    };
  }

  return {
    tools: uniqSorted(candidates[0]),
    error: null,
  };
}

export function compareToolContracts({ sourceTools, skillTools, label }) {
  const missingFromSkill = sourceTools.filter(tool => !skillTools.includes(tool));
  const extraInSkill = skillTools.filter(tool => !sourceTools.includes(tool));
  if (missingFromSkill.length === 0 && extraInSkill.length === 0) {
    return null;
  }
  return [
    `${label} tool list must match its implementation source.`,
    'Source tools:',
    formatList(sourceTools),
    'Skill tools:',
    formatList(skillTools),
    'Missing from SKILL.md:',
    formatList(missingFromSkill),
    'Documented in SKILL.md but not implemented:',
    formatList(extraInSkill),
  ].join('\n');
}

export function loadToolContract(path) {
  return collectMarkdownToolNames(readText(path));
}

function readText(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function isPropertyName(name, expected) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text === expected : false;
}

function uniqSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function formatList(values) {
  return values.length === 0 ? '  (none)' : values.map(value => `  - ${value}`).join('\n');
}

function readSourceToolContract(relativePath) {
  return collectSourceToolNames(readText(relativePath), relativePath);
}

function fail(message) {
  process.stderr.write(`Sync check failed:\n\n${message}\n`);
  process.exitCode = 1;
}

function run() {
  const mcpSource = readSourceToolContract(mcpSourcePath);
  if (mcpSource.error) {
    fail(mcpSource.error);
    return;
  }
  const canvasSource = readSourceToolContract(canvasSourcePath);
  if (canvasSource.error) {
    fail(canvasSource.error);
    return;
  }
  const mcpSkill = loadToolContract(mcpSkillPath);
  if (mcpSkill.error) {
    fail(`${mcpSkillPath}: ${mcpSkill.error}`);
    return;
  }
  const canvasSkill = loadToolContract(canvasSkillPath);
  if (canvasSkill.error) {
    fail(`${canvasSkillPath}: ${canvasSkill.error}`);
    return;
  }

  const failures = [
    compareToolContracts({
      sourceTools: mcpSource.tools,
      skillTools: mcpSkill.tools,
      label: 'MCP',
    }),
    compareToolContracts({
      sourceTools: canvasSource.tools,
      skillTools: canvasSkill.tools,
      label: 'Canvas',
    }),
  ].filter(Boolean);

  if (failures.length > 0) {
    fail(failures.join('\n\n'));
    return;
  }

  process.stdout.write('Sync check passed: MCP and Canvas skill tool lists match their implementation sources.\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
