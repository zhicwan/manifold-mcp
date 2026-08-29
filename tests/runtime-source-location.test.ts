import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as HostModuleNs from '../packages/modeling/src/runner/host.js';

// RUN-6 regression: a runtime null-deref on user line N must surface as
// `Issue.line === N` in the report. Before the sourcemap-based location
// the regex `<anonymous>:K:M` was offset by a fragile 4-line prelude
// constant and then matched against trimmed source lines, which silently
// drifted on every Node minor that touched stack-trace formatting and
// returned the wrong line for any non-trivial snippet.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distHost = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'host.js');
const workerJs = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'worker.js');

const skipUnlessBuilt = !existsSync(workerJs) || !existsSync(distHost) || process.env.SKIP_RUNNER_TESTS === '1';

type HostModule = typeof HostModuleNs;
let host: HostModule;

describe.skipIf(skipUnlessBuilt)('runner: runtime source location via sourcemap', () => {
  beforeAll(async () => {
    host = (await import(pathToFileURL(distHost).href)) as HostModule;
  });

  it('reports the original .ts line for a runtime null-deref', async () => {
    // Numbered for clarity:
    //   1: const a: { b?: { c?: number } } = {};
    //   2: const inner = a.b as { c: number };
    //   3: // throws at line 4 because `inner` is undefined
    //   4: result = Manifold.cube(inner.c);
    const code = [
      'const a: { b?: { c?: number } } = {};',
      'const inner = a.b as { c: number };',
      '// throws at line 4 because `inner` is undefined',
      'result = Manifold.cube(inner.c);',
    ].join('\n');

    const { report } = await host.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok).toBe(false);
    const runtime = report.errors.find(e => e.code === 'RUNTIME_ERROR');
    expect(runtime, `expected RUNTIME_ERROR; got ${JSON.stringify(report.errors)}`).toBeDefined();
    expect(runtime?.line).toBe(4);
  }, 20_000);
});
