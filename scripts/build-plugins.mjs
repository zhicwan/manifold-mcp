import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const repoRoot = resolve(import.meta.dirname, '..');
const outputs = [
  'plugins/manifold',
  'plugins/manifold-extension',
  '.github/plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
];

function commonMetadata(metadata) {
  const { author, homepage, repository, license, keywords } = metadata;
  return { author, homepage, repository, license, keywords };
}

export function createManifoldPluginManifest({ version, metadata }) {
  return {
    name: 'manifold',
    description: metadata.description,
    version,
    ...commonMetadata(metadata),
    skills: './skills/',
    mcpServers: './.mcp.json',
  };
}

export function createManifoldExtensionManifest({ version, metadata }) {
  return {
    name: 'manifold-extension',
    description: metadata.extensionDescription,
    version,
    ...commonMetadata(metadata),
    skills: './skills/',
    extensions: './extensions/',
  };
}

export async function assemblePlugins({ root = repoRoot, check = false } = {}) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (typeof metadata.version !== 'string') {
    throw new Error('The workspace must declare the product version.');
  }
  const { version } = metadata;
  const jsonOptions = { ...(await resolveConfig(join(root, 'package.json'))), parser: 'json', endOfLine: 'lf' };
  const mcp = createManifoldPluginManifest({
    version,
    metadata: { ...metadata, description: 'Manifold modeling tools, browser/XR Viewer and skill over MCP.' },
  });
  const extension = createManifoldExtensionManifest({
    version,
    metadata: {
      ...metadata,
      extensionDescription: 'Manifold modeling tools, native Copilot Canvas and annotation messages.',
    },
  });
  const stage = await mkdtemp(join(tmpdir(), 'manifold-plugins-'));
  const claimed = new Set();
  const copy = async (source, target) => {
    if (claimed.has(target)) {
      throw new Error(`Plugin sources collide at ${target}.`);
    }
    claimed.add(target);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  };
  const copyTree = async (source, target) => {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await copyTree(join(source, entry.name), join(target, entry.name));
      } else if (entry.isFile()) {
        await copy(join(source, entry.name), join(target, entry.name));
      } else {
        throw new Error(`Plugin source must be a regular file or directory: ${join(source, entry.name)}`);
      }
    }
  };
  const json = async (path, value) => {
    const target = join(stage, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await format(JSON.stringify(value), jsonOptions));
  };
  try {
    await json('plugins/manifold/.claude-plugin/plugin.json', mcp);
    await json('plugins/manifold/.mcp.json', {
      mcpServers: {
        'manifold3d-mcp': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/manifold.mjs'] },
      },
    });
    await json('plugins/manifold-extension/plugin.json', extension);
    for (const [name, skill, artifact, destination] of [
      ['manifold', 'use-manifold', 'apps/manifold3d-mcp/dist/manifold.mjs', 'bin/manifold.mjs'],
      [
        'manifold-extension',
        'use-manifold-canvas',
        'apps/copilot-extension/dist/extension.mjs',
        'extensions/manifold/extension.mjs',
      ],
    ]) {
      const target = join(stage, 'plugins', name);
      await copy(join(root, artifact), join(target, destination));
      await copyTree(join(root, 'skills', skill), join(target, 'skills', skill));
      await copyTree(join(root, 'skills/shared/references'), join(target, 'skills', skill, 'references'));
      await copy(join(root, 'LICENSE'), join(target, 'LICENSE'));
      await copy(join(root, 'NOTICE'), join(target, 'NOTICE'));
    }
    const catalog = plugins => ({
      name: 'manifold3d-mcp',
      owner: metadata.author,
      metadata: { description: metadata.description, version },
      plugins: plugins.map(manifest => ({
        name: manifest.name,
        description: manifest.description,
        version,
        source: `./plugins/${manifest.name}`,
        ...commonMetadata(metadata),
      })),
    });
    await json('.github/plugin/marketplace.json', catalog([mcp, extension]));
    await json('.claude-plugin/marketplace.json', catalog([mcp]));

    if (check) {
      const differences = [];
      for (const path of outputs) {
        const expected = await snapshot(join(stage, path));
        const actual = await snapshot(join(root, path));
        for (const [file, bytes] of expected) {
          const existing = actual.get(file);
          if (!existing || !bytes.equals(existing)) {
            differences.push(`Missing or changed: ${join(path, file)}`);
          }
        }
        for (const file of actual.keys()) {
          if (!expected.has(file)) {
            differences.push(`Unexpected: ${join(path, file)}`);
          }
        }
      }
      if (differences.length) {
        throw new Error(`Plugin output is stale. Run npm run build:plugins.\n${differences.join('\n')}`);
      }
    } else {
      for (const path of outputs) {
        const target = join(root, path);
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await cp(join(stage, path), target, { recursive: true });
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function snapshot(root) {
  const files = new Map();
  const visit = async (path, relative) => {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        await visit(join(path, name), join(relative, name));
      }
    } else if (info.isFile()) {
      files.set(relative, await readFile(path));
    } else {
      throw new Error(`Generated plugin contains a non-regular path: ${path}`);
    }
  };
  await visit(root, '');
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--check')) {
    throw new Error('Usage: node scripts/build-plugins.mjs [--check]');
  }
  await assemblePlugins({ check: process.argv.includes('--check') });
  process.stdout.write('Plugin assembly complete.\n');
}
