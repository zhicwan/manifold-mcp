import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as HostModuleNs from '../packages/modeling/src/runner/host.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distHost = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'host.js');
const workerJs = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'worker.js');
const lifecycleFixture = new URL(
  `data:text/javascript,${encodeURIComponent(`
    import { parentPort, threadId, workerData } from 'node:worker_threads';
    const options = workerData ?? {};
    parentPort.on('message', (request) => {
      if (options.errorCode) {
        queueMicrotask(() => {
          const error = new Error(String(options.errorMessage ?? options.errorCode));
          error.code = options.errorCode;
          throw error;
        });
        return;
      }
      if (request.code === options.hangCode) {
        while (true) {}
      }
      setTimeout(() => {
        parentPort.postMessage({
          report: { ok: true, stage: 'ok', errors: [], warnings: [], hints: [] },
        });
      }, Number(options.resultDelayMs ?? 0));
    });
    if (options.readyDelayMs !== null) {
      setTimeout(
        () => parentPort.postMessage({ ready: true, threadId }),
        Number(options.readyDelayMs ?? 0),
      );
    }
  `)}`,
);

const skipUnlessBuilt = !existsSync(workerJs) || !existsSync(distHost) || process.env.SKIP_RUNNER_TESTS === '1';

// Import the COMPILED host (not the TS source). The host computes
// `WORKER_PATH` relative to its own file location at import-time; under
// vitest with esbuild, the TS source location is `packages/modeling/src/runner/`
// which has no worker.js. Pointing at modeling/dist/runner/host.js keeps
// WORKER_PATH correctly aligned with modeling/dist/runner/worker.js.
type HostModule = typeof HostModuleNs;
let host: HostModule;
let defaultRunner: InstanceType<HostModule['Runner']>;

describe.skipIf(skipUnlessBuilt)('runner host: Runner.run()', () => {
  beforeAll(async () => {
    host = (await import(pathToFileURL(distHost).href)) as HostModule;
    defaultRunner = new host.Runner();
  });

  afterAll(async () => {
    await defaultRunner.dispose();
  });

  it('runs a happy-path validate of result = Manifold.cube()', async () => {
    const { report } = await defaultRunner.run(
      { mode: 'validate', code: 'result = Manifold.cube();' },
      { timeoutMs: 15_000 },
    );
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.hints.some(hint => hint.startsWith('GC_DELETE_FAILED:'))).toBe(false);
    expect(host._currentThreadId(defaultRunner)).toBeUndefined();
    expect(host._lastThreadId(defaultRunner)).toBeDefined();
  }, 20_000);

  it('returns a TIMEOUT error when timeoutMs is exceeded', async () => {
    const runner = new host.Runner({
      workerFilename: lifecycleFixture,
      workerData: { hangCode: 'hang' },
    });
    try {
      const { report } = await runner.run({ mode: 'validate', code: 'hang' }, { timeoutMs: 100 });
      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.code === 'TIMEOUT')).toBe(true);
    } finally {
      await runner.dispose();
    }
  }, 10_000);

  it('maps OOM exit-code to OUT_OF_MEMORY', async () => {
    const runner = new host.Runner({
      workerFilename: lifecycleFixture,
      workerData: {
        errorCode: 'ERR_WORKER_OUT_OF_MEMORY',
        errorMessage: 'Worker terminated due to reaching memory limit: JS heap out of memory',
      },
    });
    try {
      const { report } = await runner.run({ mode: 'validate', code: 'ignored' }, { timeoutMs: 5_000 });
      expect(report.ok).toBe(false);
      expect(report.errors.some(error => error.code === 'OUT_OF_MEMORY')).toBe(true);
      expect(host._currentThreadId(runner)).toBeUndefined();
    } finally {
      await runner.dispose();
    }
  }, 10_000);

  // Regression test for the queue serialization invariant. The host
  // promises that runs do not overlap (Manifold's allocator does not
  // tolerate two live worker WASM heaps in the same process). After the
  // RUN-1 fix `settle` awaits worker.terminate(), so even a flood of
  // concurrent calls must complete in submission order with no overlap.
  it('serializes concurrent runs in submission order', async () => {
    const calls = [0, 1, 2, 3].map(i =>
      defaultRunner.run({ mode: 'validate', code: `result = Manifold.cube(${i + 1});` }, { timeoutMs: 15_000 }),
    );
    const results = await Promise.all(calls);
    for (const { report } of results) {
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
    }
  }, 60_000);

  it('uses a fresh disposable worker for every request', async () => {
    const first = await defaultRunner.run(
      { mode: 'validate', code: 'result = Manifold.cube();' },
      { timeoutMs: 15_000 },
    );
    expect(first.report.ok).toBe(true);
    const firstThreadId = host._lastThreadId(defaultRunner);
    expect(firstThreadId).toBeDefined();
    expect(host._currentThreadId(defaultRunner)).toBeUndefined();

    let previousThreadId = firstThreadId;
    for (let i = 0; i < 3; i++) {
      const { report } = await defaultRunner.run(
        { mode: 'validate', code: `result = Manifold.sphere(${i + 1});` },
        { timeoutMs: 15_000 },
      );
      expect(report.ok).toBe(true);
      expect(host._currentThreadId(defaultRunner)).toBeUndefined();
      expect(host._lastThreadId(defaultRunner)).not.toBe(previousThreadId);
      previousThreadId = host._lastThreadId(defaultRunner);
    }
  }, 60_000);

  it('freezes exposed constructors and hidden Embind prototypes during each request', async () => {
    const runner = new host.Runner();
    try {
      const poisonAttempt = await runner.run(
        {
          mode: 'validate',
          code: `
            let blocked = 0;
            const manifoldApi = Manifold as unknown as Record<string, unknown>;
            const crossSectionApi = CrossSection as unknown as Record<string, unknown>;
            const meshPrototype = Mesh.prototype as unknown as Record<string, unknown>;
            try { manifoldApi['cube'] = () => Manifold.sphere(99); } catch { blocked++; }
            try { crossSectionApi['square'] = () => CrossSection.circle(99); } catch { blocked++; }
            try { meshPrototype['merge'] = () => false; } catch { blocked++; }

            const cube = Manifold.cube();
            const manifoldPrototype = Object.getPrototypeOf(cube) as Record<string, unknown>;
            try { manifoldPrototype['translate'] = () => Manifold.cube(99); } catch { blocked++; }

            const section = CrossSection.square();
            const crossSectionPrototype = Object.getPrototypeOf(section) as Record<string, unknown>;
            try { crossSectionPrototype['extrude'] = () => Manifold.cube(99); } catch { blocked++; }

            result = cube.scale(blocked === 5 ? 1 : 7);
          `,
        },
        { timeoutMs: 15_000 },
      );
      expect(poisonAttempt.report.ok, JSON.stringify(poisonAttempt.report.errors)).toBe(true);
      expect(poisonAttempt.report.stats?.bbox.size).toEqual([1, 1, 1]);
      expect(poisonAttempt.report.hints.some(hint => hint.startsWith('GC_DELETE_FAILED:'))).toBe(false);
      const firstThreadId = host._lastThreadId(runner);
      expect(host._currentThreadId(runner)).toBeUndefined();

      const nextRun = await runner.run(
        { mode: 'validate', code: 'result = Manifold.cube().translate([1, 0, 0]);' },
        { timeoutMs: 15_000 },
      );
      expect(nextRun.report.ok, JSON.stringify(nextRun.report.errors)).toBe(true);
      expect(nextRun.report.stats?.bbox.size).toEqual([1, 1, 1]);
      expect(nextRun.report.hints.some(hint => hint.startsWith('GC_DELETE_FAILED:'))).toBe(false);
      expect(host._lastThreadId(runner)).not.toBe(firstThreadId);
      expect(host._currentThreadId(runner)).toBeUndefined();
    } finally {
      await runner.dispose();
    }
  }, 60_000);

  it('terminates a successful worker before an infinite Promise microtask can outlive the request', async () => {
    const runner = new host.Runner();
    try {
      const startedAt = performance.now();
      const first = await runner.run(
        {
          mode: 'validate',
          code: `
            Promise.resolve().then(() => {
              while (true) {}
            });
            result = Manifold.cube();
          `,
        },
        { timeoutMs: 15_000 },
      );
      expect(first.report.ok, JSON.stringify(first.report.errors)).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      const firstThreadId = host._lastThreadId(runner);
      expect(firstThreadId).toBeDefined();
      expect(host._currentThreadId(runner)).toBeUndefined();

      const recovered = await runner.run(
        { mode: 'validate', code: 'result = Manifold.cube(2);' },
        { timeoutMs: 15_000 },
      );
      expect(recovered.report.ok, JSON.stringify(recovered.report.errors)).toBe(true);
      expect(host._lastThreadId(runner)).toBeDefined();
      expect(host._lastThreadId(runner)).not.toBe(firstThreadId);
      expect(host._currentThreadId(runner)).toBeUndefined();
    } finally {
      await runner.dispose();
    }
  }, 60_000);

  it('times out bootstrap and lets dispose finish when a worker never becomes ready', async () => {
    const runner = new host.Runner({
      workerFilename: lifecycleFixture,
      workerData: { readyDelayMs: null },
    });
    const runPromise = runner.run({ mode: 'validate', code: 'ignored' }, { timeoutMs: 100 });
    const disposePromise = runner.dispose();
    const result = await runPromise;
    expect(result.report.errors.some(error => error.code === 'TIMEOUT')).toBe(true);
    await expect(disposePromise).resolves.toBeUndefined();
    expect(host._currentThreadId(runner)).toBeUndefined();
  }, 5_000);

  it('passes only the remaining end-to-end budget to execution after bootstrap', async () => {
    const runner = new host.Runner({
      workerFilename: lifecycleFixture,
      workerData: { readyDelayMs: 200, resultDelayMs: 150 },
    });
    try {
      const result = await runner.run({ mode: 'validate', code: 'ignored' }, { timeoutMs: 300 });
      expect(result.report.errors.some(error => error.code === 'TIMEOUT')).toBe(true);
      expect(host._currentThreadId(runner)).toBeUndefined();
    } finally {
      await runner.dispose();
    }
  }, 5_000);

  it('emits the millimetres reminder once per Runner despite disposable workers', async () => {
    const runner = new host.Runner();
    const otherRunner = new host.Runner();
    const hasUnitsHint = (result: Awaited<ReturnType<InstanceType<HostModule['Runner']>['run']>>): boolean =>
      result.report.hints.some(hint => hint.includes('no intrinsic units'));
    try {
      const first = await runner.run({ mode: 'validate', code: 'result = Manifold.cube();' }, { timeoutMs: 15_000 });
      const firstThreadId = host._lastThreadId(runner);
      const second = await runner.run(
        { mode: 'validate', code: 'result = Manifold.sphere(2);' },
        { timeoutMs: 15_000 },
      );
      expect(hasUnitsHint(first)).toBe(true);
      expect(hasUnitsHint(second)).toBe(false);
      expect(host._lastThreadId(runner)).not.toBe(firstThreadId);

      const independent = await otherRunner.run(
        { mode: 'validate', code: 'result = Manifold.cube();' },
        { timeoutMs: 15_000 },
      );
      expect(hasUnitsHint(independent)).toBe(true);
    } finally {
      await Promise.all([runner.dispose(), otherRunner.dispose()]);
    }
  }, 60_000);

  it('keeps independent Runner instances isolated with disposable workers', async () => {
    const firstRunner = new host.Runner();
    const secondRunner = new host.Runner();
    try {
      const [firstResult, secondResult] = await Promise.all([
        firstRunner.run({ mode: 'validate', code: 'result = Manifold.cube();' }, { timeoutMs: 15_000 }),
        secondRunner.run({ mode: 'validate', code: 'result = Manifold.sphere(2);' }, { timeoutMs: 15_000 }),
      ]);
      expect(firstResult.report.ok).toBe(true);
      expect(secondResult.report.ok).toBe(true);

      const firstThreadId = host._lastThreadId(firstRunner);
      const secondThreadId = host._lastThreadId(secondRunner);
      expect(firstThreadId).toBeDefined();
      expect(secondThreadId).toBeDefined();
      expect(firstThreadId).not.toBe(secondThreadId);
      expect(host._currentThreadId(firstRunner)).toBeUndefined();
      expect(host._currentThreadId(secondRunner)).toBeUndefined();

      await Promise.all([
        firstRunner.run({ mode: 'validate', code: 'result = Manifold.cube(2);' }, { timeoutMs: 15_000 }),
        secondRunner.run({ mode: 'validate', code: 'result = Manifold.sphere(3);' }, { timeoutMs: 15_000 }),
      ]);
      expect(host._lastThreadId(firstRunner)).not.toBe(firstThreadId);
      expect(host._lastThreadId(secondRunner)).not.toBe(secondThreadId);
    } finally {
      await Promise.all([firstRunner.dispose(), secondRunner.dispose()]);
    }
  }, 60_000);

  it('fully retires a timed-out worker before allowing the next run', async () => {
    const runner = new host.Runner({
      workerFilename: lifecycleFixture,
      workerData: { hangCode: 'hang' },
    });
    try {
      const first = await runner.run({ mode: 'validate', code: 'ok' }, { timeoutMs: 5_000 });
      expect(first.report.ok).toBe(true);
      const firstThreadId = host._lastThreadId(runner);

      const timedOut = await runner.run({ mode: 'validate', code: 'hang' }, { timeoutMs: 100 });
      expect(timedOut.report.errors.some(error => error.code === 'TIMEOUT')).toBe(true);
      expect(host._currentThreadId(runner)).toBeUndefined();
      expect(host._lastThreadId(runner)).not.toBe(firstThreadId);
      const timedOutThreadId = host._lastThreadId(runner);

      const recovered = await runner.run({ mode: 'validate', code: 'ok-again' }, { timeoutMs: 5_000 });
      expect(recovered.report.ok).toBe(true);
      expect(host._currentThreadId(runner)).toBeUndefined();
      expect(host._lastThreadId(runner)).not.toBe(timedOutThreadId);
    } finally {
      const firstDispose = runner.dispose();
      expect(runner.dispose()).toBe(firstDispose);
      await firstDispose;
    }
  }, 60_000);
});
