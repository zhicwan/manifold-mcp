import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseYaml } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'manifold-installed-plugin-')));
const plugin = join(scratch, 'installed plugin');
const workspace = join(scratch, 'unrelated workspace');
const output = join(scratch, 'runtime output');
const client = new Client({ name: 'installed-plugin-smoke', version: '1.0.0' });

try {
  await cp(join(root, 'plugins/manifold'), plugin, { recursive: true });
  await mkdir(workspace);
  await mkdir(output);
  const manifest = JSON.parse(await readFile(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  const product = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, product.version);
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(config.mcpServers['manifold3d-mcp'], {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/bin/manifold.mjs'],
  });
  const entry = join(plugin, 'bin/manifold.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--permission',
      '--allow-worker',
      `--allow-fs-read=${entry}`,
      `--allow-fs-read=${workspace}`,
      `--allow-fs-write=${workspace}`,
      `--allow-fs-read=${output}`,
      `--allow-fs-write=${output}`,
      entry,
    ],
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '',
      MANIFOLD_MCP_NO_OPEN: '1',
      TMPDIR: output,
      TMP: output,
      TEMP: output,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, product.version);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
      'capture_view',
      'execute_script',
      'get_annotations',
      'validate_script',
    ]);
    const execution = await client.callTool({
      name: 'execute_script',
      arguments: { code: 'result = Manifold.cube([2, 3, 4], true);', description: 'Installed plugin cube' },
    });
    assert.equal(execution.isError, false, JSON.stringify(execution));
    const report = textReport(execution);
    assert.equal(report.ok, true);
    assert.equal(report.stats.triangles, 12);
    const viewerRoot = join(root, 'apps/manifold3d-mcp/build/viewer');
    const assets = await readdir(viewerRoot, { recursive: true, withFileTypes: true });
    for (const asset of assets.filter(item => item.isFile())) {
      const source = join(asset.parentPath, asset.name);
      const path = relative(viewerRoot, source).split('\\').join('/');
      const response = await globalThis.fetch(new URL(path, report.previewUrl));
      assert.equal(response.status, 200, path);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(source), path);
    }
    const capture = await client.callTool({
      name: 'capture_view',
      arguments: { view: 'front', width: 128, height: 256 },
    });
    assert.equal(capture.isError, false, JSON.stringify(capture));
    const captured = textReport(capture);
    assert.equal(captured.width, 128);
    assert.equal(captured.height, 256);
    const capturePath = relative(output, captured.filePath);
    assert(capturePath && !capturePath.startsWith('..') && !isAbsolute(capturePath));
    const png = await readFile(captured.filePath);
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 256);

    const failure = textReport(
      await client.callTool({
        name: 'validate_script',
        arguments: {
          code: [
            'const value: { nested?: { size: number } } = {};',
            'const missing = value.nested as { size: number };',
            '// Mapping must work with no external resources.',
            'result = Manifold.cube(missing.size);',
          ].join('\n'),
        },
      }),
    );
    assert.equal(failure.ok, false);
    assert(failure.errors.some(issue => issue.code === 'RUNTIME_ERROR' && issue.line === 4));

    const filePath = join(workspace, 'example.ts');
    await writeFile(filePath, 'result = Manifold.cube(1);\n');
    assert.equal(textReport(await client.callTool({ name: 'validate_script', arguments: { filePath } })).ok, true);
    const annotations = await client.callTool({ name: 'get_annotations', arguments: {} });
    assert.notEqual(annotations.isError, true);
    assert.equal(textReport(annotations).count, 0);
  } catch (error) {
    throw new Error(`Installed MCP plugin failed.\n${stderr}`, { cause: error });
  }

  for (const [name, skill] of [
    ['manifold', 'use-manifold'],
    ['manifold-extension', 'use-manifold-canvas'],
  ]) {
    const skillRoot = join(root, 'plugins', name, 'skills', skill);
    const entryText = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
    assert(entryText.includes(`name: ${skill}`));
    for (const file of await readdir(join(root, 'skills/shared/references'))) {
      assert.deepEqual(
        await readFile(join(skillRoot, 'references', file)),
        await readFile(join(root, 'skills/shared/references', file)),
      );
    }
  }
  process.stdout.write(
    'Installed plugin smoke passed: standalone MCP, embedded Viewer, capture, error mapping and skills.\n',
  );
} finally {
  try {
    await client.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function textReport(result) {
  const text = result.content.find(item => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', JSON.stringify(result));
  return parseYaml(text);
}
