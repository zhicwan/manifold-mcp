import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as HostModuleNs from '../packages/modeling/src/runner/host.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = join(repoRoot, 'samples');
const distHost = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'host.js');
const workerJs = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'worker.js');

const skipUnlessBuilt = !existsSync(workerJs) || !existsSync(distHost) || process.env.SKIP_RUNNER_TESTS === '1';

const sampleFiles = existsSync(samplesDir)
  ? readdirSync(samplesDir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  : [];

type HostModule = typeof HostModuleNs;
let host: HostModule;

describe.skipIf(skipUnlessBuilt || sampleFiles.length === 0)('samples/*.ts validate cleanly', () => {
  beforeAll(async () => {
    host = (await import(pathToFileURL(distHost).href)) as HostModule;
  });

  it.each(sampleFiles)(
    'validates %s without errors',
    async fileName => {
      const fullPath = join(samplesDir, fileName);
      const code = readFileSync(fullPath, 'utf8');
      const { report } = await host.run({ mode: 'validate', code }, { timeoutMs: 30_000 });
      if (!report.ok) {
        const firstError = report.errors[0];
        throw new Error(
          `Sample ${fileName} did not validate cleanly. First error: ${
            firstError ? `${firstError.code}: ${firstError.message}` : '(unknown)'
          }`,
        );
      }
      expect(report.errors).toEqual([]);
    },
    60_000,
  );
});
