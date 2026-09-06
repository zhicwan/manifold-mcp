import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { assemblePlugins } from '../scripts/build-plugins.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'manifold-assembly-test-'));
  try {
    const files = {
      'package.json': JSON.stringify({ version: '1.2.3', author: { name: 'Example' }, description: 'Example plugins' }),
      LICENSE: 'license\n',
      NOTICE: 'notice\n',
      'apps/manifold3d-mcp/dist/manifold.mjs': 'export {};\n',
      'apps/copilot-extension/dist/extension.mjs': 'export {};\n',
      'skills/use-manifold/SKILL.md': 'name: use-manifold\n',
      'skills/use-manifold-canvas/SKILL.md': 'name: use-manifold-canvas\n',
      'skills/shared/references/api.md': 'shared reference\n',
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('plugin assembly helpers', () => {
  it('extracts tool names from markdown and TypeScript sources', async () => {
    const sync = await import('../scripts/check-sync.mjs');
    const markdown = `
# Example

## Tools

- **\`alpha\`** — first tool
- **\`beta\`** — second tool
`;
    expect(sync.collectMarkdownToolNames(markdown)).toEqual({ tools: ['alpha', 'beta'], error: null });

    const source = `
      export const tools = [
        { name: 'gamma', handler() {} },
        { name: 'delta', handler() {} },
      ];
    `;
    expect(sync.collectSourceToolNames(source, 'fixture.ts')).toEqual({ tools: ['delta', 'gamma'], error: null });
    expect(
      sync.compareToolContracts({
        sourceTools: ['alpha', 'beta'],
        skillTools: ['alpha', 'beta'],
        label: 'fixture',
      }),
    ).toBeNull();
  });

  it('builds plugin manifests from the root version and existing metadata', async () => {
    const build = await import('../scripts/build-plugins.mjs');
    const metadata = {
      author: { name: 'Example Author' },
      homepage: 'https://example.com',
      repository: 'https://example.com/repo',
      license: 'Apache-2.0',
      keywords: ['one', 'two'],
      description: 'MCP description',
      extensionDescription: 'Extension description',
    };

    expect(build.createManifoldPluginManifest({ version: '1.2.3', metadata })).toMatchObject({
      name: 'manifold',
      version: '1.2.3',
      skills: './skills/',
      mcpServers: './.mcp.json',
      author: metadata.author,
    });
    expect(build.createManifoldExtensionManifest({ version: '1.2.3', metadata })).toMatchObject({
      name: 'manifold-extension',
      version: '1.2.3',
      skills: './skills/',
      extensions: './extensions/',
      author: metadata.author,
    });
  });

  it('assembles independent skills and different catalogs without reading prior output', async () => {
    await fixture(async root => {
      await assemblePlugins({ root });
      for (const [plugin, skill] of [
        ['manifold', 'use-manifold'],
        ['manifold-extension', 'use-manifold-canvas'],
      ]) {
        expect(await readFile(join(root, 'plugins', plugin, 'skills', skill, 'references/api.md'), 'utf8')).toBe(
          'shared reference\n',
        );
      }
      const github = JSON.parse(await readFile(join(root, '.github/plugin/marketplace.json'), 'utf8'));
      const claude = JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
      expect(github.plugins.map(plugin => plugin.name)).toEqual(['manifold', 'manifold-extension']);
      expect(claude.plugins.map(plugin => plugin.name)).toEqual(['manifold']);
      await assemblePlugins({ root, check: true });
    });
  });

  it('reports drift without replacing it, including unexpected generated files', async () => {
    await fixture(async root => {
      await assemblePlugins({ root });
      const changed = join(root, 'plugins/manifold/skills/use-manifold/SKILL.md');
      await writeFile(changed, 'manual change\n');
      await expect(assemblePlugins({ root, check: true })).rejects.toThrow('stale');
      expect(await readFile(changed, 'utf8')).toBe('manual change\n');
      await assemblePlugins({ root });
      await writeFile(join(root, 'plugins/manifold/unexpected.txt'), 'extra\n');
      await expect(assemblePlugins({ root, check: true })).rejects.toThrow('Unexpected');
    });
  });

  it('rejects conflicting sources before deleting the previous installation output', async () => {
    await fixture(async root => {
      await assemblePlugins({ root });
      await mkdir(join(root, 'skills/use-manifold/references'));
      await writeFile(join(root, 'skills/use-manifold/references/api.md'), 'conflict\n');
      await expect(assemblePlugins({ root })).rejects.toThrow('collide');
      expect(await readFile(join(root, 'plugins/manifold/bin/manifold.mjs'), 'utf8')).toBe('export {};\n');
    });
  });
});
