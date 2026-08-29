#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

import { parse as parseYaml } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '..');
const configuredScratchRoot = process.env.MANIFOLD_PACK_SMOKE_ROOT;
const scratchRoot = configuredScratchRoot ? resolve(repositoryRoot, configuredScratchRoot) : tmpdir();
if (configuredScratchRoot) {
  assert(
    configuredScratchRoot === '.pack-smoke',
    'MANIFOLD_PACK_SMOKE_ROOT may only select the ignored .pack-smoke directory.',
  );
  await mkdir(scratchRoot, { recursive: true });
}
const scratchDirectory = await mkdtemp(join(scratchRoot, 'manifold3d-mcp-pack-smoke-'));
const packDirectory = resolve(scratchDirectory, 'pack');
const projectDirectory = resolve(scratchDirectory, 'project');
const runtimeTempDirectory = resolve(scratchDirectory, 'runtime-tmp');
const publicPackageName = '@zhicwan/manifold3d-mcp';

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed (${code}):\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function runNpm(args, cwd = repositoryRoot) {
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  delete env.NPM_CONFIG_DRY_RUN;
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], { cwd, env });
  }
  return run('npm', args, { cwd, env });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getText(url) {
  return new Promise((resolvePromise, reject) => {
    const request = httpGet(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.once('error', reject);
      response.once('end', () => {
        resolvePromise({
          body,
          contentType: response.headers['content-type'],
          statusCode: response.statusCode ?? 0,
        });
      });
    });
    request.once('error', reject);
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${error.message}\n${text}`, { cause: error });
  }
}

function parsePackJson(text) {
  const marker = '[\n  {\n    "id":';
  const start = text.lastIndexOf(marker);
  if (start < 0) {
    throw new Error(`npm pack did not emit its JSON result:\n${text}`);
  }
  return parseJson(text.slice(start), 'npm pack');
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(directory, entry.name), relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

class McpProbe {
  constructor(command) {
    this.command = command;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  start() {
    this.child = spawn(this.command, [], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        BROWSER: 'none',
        MANIFOLD_MCP_NO_OPEN: '1',
        TEMP: runtimeTempDirectory,
        TMP: runtimeTempDirectory,
        TMPDIR: runtimeTempDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.readline = createInterface({ input: this.child.stdout });
    this.readline.on('line', line => this.onLine(line));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr += chunk;
    });
    this.child.once('exit', code => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Installed MCP server exited before responding (${code}).\n${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  onLine(line) {
    if (!line.trim()) {
      return;
    }
    const message = parseJson(line, 'MCP response');
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) {
          pending.reject(new Error(`MCP error: ${JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  pauseResponses() {
    this.child.stdout.pause();
  }

  resumeResponses() {
    this.child.stdout.resume();
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for installed MCP ${method}.`));
      }, 30_000);
      this.pending.set(id, { reject, resolve: resolvePromise, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    const child = this.child;
    const exited = new Promise(resolvePromise => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    });
    child.stdin.end();
    const outcome = await Promise.race([exited, delayResult(5_000)]);
    if (outcome === 'timeout') {
      child.kill('SIGTERM');
      const terminated = await Promise.race([exited, delayResult(2_000)]);
      if (terminated === 'timeout') {
        child.kill('SIGKILL');
        const killed = await Promise.race([exited, delayResult(2_000)]);
        if (killed === 'timeout') {
          throw new Error('Installed MCP server could not be reaped after stdin EOF.');
        }
      }
      throw new Error('Installed MCP server did not exit after stdin EOF.');
    }
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(
        `Installed MCP server exited after stdin EOF with code=${outcome.code}, signal=${outcome.signal}.`,
      );
    }
    this.readline?.close();
  }
}

function delayResult(milliseconds) {
  return new Promise(resolvePromise => setTimeout(() => resolvePromise('timeout'), milliseconds));
}

let probe;
try {
  const relativeToRepository = relative(repositoryRoot, scratchDirectory);
  if (configuredScratchRoot) {
    assert(
      relativeToRepository.startsWith('.pack-smoke/'),
      `Installed smoke scratch escaped .pack-smoke: ${scratchDirectory}`,
    );
  } else {
    assert(
      relativeToRepository.startsWith('..') || isAbsolute(relativeToRepository),
      `Installed smoke scratch must be outside the repository: ${scratchDirectory}`,
    );
  }
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(runtimeTempDirectory, { recursive: true }),
  ]);
  const packed = await runNpm([
    'pack',
    '--workspace',
    publicPackageName,
    '--pack-destination',
    packDirectory,
    '--json',
    '--silent',
  ]);
  const packResult = parsePackJson(packed.stdout);
  assert(Array.isArray(packResult) && packResult.length === 1, 'npm pack did not report exactly one tarball.');
  const packedPackage = packResult[0];
  const tarball = resolve(packDirectory, packedPackage.filename);
  const bundled = new Set(packedPackage.bundled ?? []);
  const packedFiles = new Set(packedPackage.files?.map(file => file.path) ?? []);
  for (const dependency of ['@manifold3d/modeling', '@manifold3d/protocol', '@manifold3d/viewer-host']) {
    assert(bundled.has(dependency), `npm pack did not bundle ${dependency}.`);
  }
  assert(
    [...packedFiles].every(file => !file.endsWith('.map') && !file.endsWith('.tsbuildinfo')),
    'Published tarball contains build-only source maps or TypeScript build metadata.',
  );
  assert(
    [...packedFiles].every(file => !file.includes('copilot-extension') && !file.endsWith('/extension.mjs')),
    'Published MCP tarball unexpectedly contains the private Copilot Extension artifact.',
  );

  await writeFile(
    join(projectDirectory, 'package.json'),
    `${JSON.stringify({ name: 'manifold3d-mcp-installed-smoke', private: true, type: 'module' }, null, 2)}\n`,
  );
  await runNpm(
    ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', tarball],
    projectDirectory,
  );

  const installedPackage = resolve(projectDirectory, 'node_modules/@zhicwan/manifold3d-mcp');
  const requiredFiles = [
    'dist/server/index.js',
    'node_modules/@manifold3d/modeling/dist/modeling.js',
    'node_modules/@manifold3d/modeling/dist/runner/worker.js',
    'node_modules/@manifold3d/protocol/dist/wire/annotations.js',
    'node_modules/@manifold3d/protocol/dist/wire/host-actions.js',
    'node_modules/@manifold3d/protocol/dist/wire/model.js',
    'node_modules/@manifold3d/modeling/dist/runner/model-artifact.js',
    'node_modules/@manifold3d/viewer-host/dist/preview/preview-server.js',
    'node_modules/@manifold3d/viewer-host/dist/viewer-host.js',
    'node_modules/@manifold3d/viewer-host/dist/public/index.html',
  ];
  await Promise.all(requiredFiles.map(file => readFile(resolve(installedPackage, file))));
  await readFile(resolve(projectDirectory, 'node_modules/manifold-3d/manifold.wasm'));

  const manifest = parseJson(
    await readFile(resolve(installedPackage, 'package.json'), 'utf8'),
    'installed package manifest',
  );
  const binName = process.platform === 'win32' ? 'manifold3d-mcp.cmd' : 'manifold3d-mcp';
  probe = new McpProbe(resolve(projectDirectory, 'node_modules/.bin', binName));
  probe.start();
  const initialized = await probe.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'installed-package-smoke', version: '0' },
  });
  probe.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await probe.call('tools/list', {});

  assert(initialized.serverInfo?.name === 'manifold3d-mcp', 'Installed server reported the wrong name.');
  assert(initialized.serverInfo?.version === manifest.version, 'Installed server reported the wrong package version.');
  assert(
    tools.tools
      ?.map(tool => tool.name)
      .sort()
      .join(',') === 'capture_view,execute_script,get_annotations,validate_script',
    'Installed server tool list is incomplete.',
  );

  const execution = await probe.call('tools/call', {
    name: 'execute_script',
    arguments: {
      code: 'result = Manifold.cube([2, 3, 4], true);',
      description: 'installed package smoke cube',
    },
  });
  assert(execution.isError === false, `Installed execute_script failed: ${JSON.stringify(execution)}`);
  const text = execution.content?.find(item => item.type === 'text')?.text;
  assert(typeof text === 'string', 'Installed execute_script did not return a text report.');
  const report = parseYaml(text);
  assert(report?.ok === true, `Installed execute_script report was not successful: ${text}`);
  assert(report?.stats?.triangles === 12, `Installed worker returned unexpected geometry stats: ${text}`);
  assert(typeof report?.previewUrl === 'string', `Installed execute_script did not return previewUrl: ${text}`);

  const preview = await getText(report.previewUrl);
  assert(
    preview.statusCode >= 200 && preview.statusCode < 300,
    `Installed preview returned HTTP ${preview.statusCode}.`,
  );
  assert(
    preview.contentType?.startsWith('text/html') === true,
    `Installed preview returned unexpected Content-Type: ${preview.contentType}`,
  );
  assert(preview.body.includes('<div id="root"></div>'), 'Installed preview did not serve the bundled Viewer HTML.');
  const viewerPublicDirectory = resolve(installedPackage, 'node_modules/@manifold3d/viewer-host/dist/public');
  const viewerAssets = await listFiles(viewerPublicDirectory);
  assert(
    viewerAssets.some(file => file.endsWith('.js')),
    'Installed Viewer has no JavaScript asset.',
  );
  assert(
    viewerAssets.some(file => file.endsWith('.css')),
    'Installed Viewer has no CSS asset.',
  );
  await Promise.all(
    viewerAssets.map(async file => {
      const response = await getText(new URL(file, report.previewUrl));
      assert(
        response.statusCode >= 200 && response.statusCode < 300,
        `Installed Viewer asset ${file} returned HTTP ${response.statusCode}.`,
      );
      assert(response.body.length > 0, `Installed Viewer asset ${file} was empty.`);
      assert(response.contentType !== undefined, `Installed Viewer asset ${file} omitted Content-Type.`);
    }),
  );

  const sourcePath = resolve(projectDirectory, 'eof-request.ts');
  await writeFile(sourcePath, 'result = Manifold.cube([1, 1, 1], true);\n');
  probe.pauseResponses();
  const eofValidation = probe.call('tools/call', {
    name: 'validate_script',
    arguments: { filePath: sourcePath },
  });
  const queuedLists = Array.from({ length: 128 }, () => probe.call('tools/list', {}));
  const eofShutdown = probe.stop();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  probe.resumeResponses();
  const eofResult = await eofValidation;
  assert(eofResult.isError === false, `EOF-drained validate_script failed: ${JSON.stringify(eofResult)}`);
  const listed = await Promise.all(queuedLists);
  assert(
    listed.every(result => result.tools?.length === 4),
    'EOF drain dropped or corrupted queued tool responses.',
  );
  await eofShutdown;

  process.stdout.write(
    `Installed tarball smoke passed: ${packedPackage.filename}, ${requiredFiles.length} runtime files, ${viewerAssets.length} Viewer assets, ${tools.tools.length} tools, worker + WASM + Viewer verified.\n`,
  );
} finally {
  await probe?.stop();
  await rm(scratchDirectory, { force: true, recursive: true });
}
