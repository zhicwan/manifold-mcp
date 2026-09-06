// SEC-1 regression suite for dynamic-code constructor recovery, dynamic
// import, host globals, and shared primordial mutation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as HostModuleNs from '../../packages/modeling/src/runner/host.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distHost = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'host.js');
const workerJs = join(repoRoot, 'packages', 'modeling', 'dist', 'runner', 'worker.js');

const skipUnlessBuilt = !existsSync(workerJs) || !existsSync(distHost) || process.env.SKIP_RUNNER_TESTS === '1';

type HostModule = typeof HostModuleNs;
let host: HostModule;
let runner: InstanceType<HostModule['Runner']>;

describe.skipIf(skipUnlessBuilt)('SEC-1: worker sandbox scrubs dangerous globals', () => {
  beforeAll(async () => {
    host = (await import(pathToFileURL(distHost).href)) as HostModule;
    runner = new host.Runner();
  });

  afterAll(async () => {
    await runner.dispose();
  });

  it('rejects direct dynamic import with a clear sandbox diagnostic', async () => {
    const { report } = await runner.run(
      { mode: 'validate', code: `void import('node:fs'); result = Manifold.cube();` },
      { timeoutMs: 15_000 },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.some(error => error.message.includes('Dynamic import() is not allowed'))).toBe(true);
  }, 20_000);

  it('blocks the reviewed indirect Function + import("node:fs") exploit', async () => {
    const code = `
      const importer = ({}).constructor.constructor('return import("node:fs")');
      void importer();
      result = Manifold.cube();
    `;
    const { report } = await runner.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok).toBe(false);
    expect(report.errors.some(error => error.message.includes('dynamic-code constructors'))).toBe(true);
  }, 20_000);

  it('disconnects Function at runtime even when constructor lookup is obfuscated past static lint', async () => {
    const code = `
      const key = ['con', 'structor'].join('');
      const objectCtor = Reflect.get({}, key) as object;
      const dynamicCtor = Reflect.get(objectCtor, key) as ((...args: string[]) => unknown) | undefined;
      let blocked = false;
      try {
        const importer = Reflect.apply(
          dynamicCtor as (...args: string[]) => unknown,
          undefined,
          ['return import("node:fs")'],
        ) as () => unknown;
        Reflect.apply(importer, undefined, []);
      } catch {
        blocked = true;
      }
      result = Manifold.cube([blocked ? 2 : 1, 1, 1], true);
    `;
    const { report } = await runner.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.stats?.bbox?.size?.[0]).toBe(2);
  }, 20_000);

  it('disconnects every Function-family constructor from user-reachable prototypes', async () => {
    const code = `
      const key = ['con', 'structor'].join('');
      const prototypes: object[] = [
        Object.getPrototypeOf(() => 0),
        Object.getPrototypeOf(async () => 0),
        Object.getPrototypeOf(function* () { yield 0; }),
        Object.getPrototypeOf(async function* () { yield 0; }),
      ];
      const blocked = prototypes.every((prototype) => Reflect.get(prototype, key) === undefined);
      result = Manifold.cube([blocked ? 2 : 1, 1, 1], true);
    `;
    const { report } = await runner.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.stats?.bbox?.size?.[0]).toBe(2);
  }, 20_000);

  it('keeps `Object.prototype` frozen so prototype-pollution attempts fail', async () => {
    // The worker freezes `Object/Function/Array.prototype` before the
    // user script runs. Under the strict-mode wrap that the worker
    // applies to user code, mutating a frozen prototype throws TypeError.
    // The probe catches the throw and treats *that exception* as the
    // success branch — the cube ends up at size 2 only when the freeze
    // really fired. Anything else (silent ignore, runtime crash) leaves
    // the cube at size 1 and the assertion below fails noisily.
    const code = `
      let frozen = false;
      try {
        const proto = Object.prototype as Record<string, unknown>;
        proto['polluted'] = 'pwn';
      } catch {
        frozen = true;
      }
      result = Manifold.cube([frozen ? 2 : 1, 1, 1], true);
    `;
    const { report } = await runner.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.stats?.bbox?.size?.[0]).toBe(2);
  }, 20_000);

  it('freezes ArrayIteratorPrototype before same-run cleanup and report processing', async () => {
    const code = `
      const iterators: object[] = [
        [][Symbol.iterator](),
        new Map<unknown, unknown>().entries(),
        new Set<unknown>().values(),
        ''[Symbol.iterator](),
        new Uint8Array().values(),
      ];
      const chainsFrozen = iterators.every((iterator) => {
        let prototype = Object.getPrototypeOf(iterator) as object | null;
        while (prototype && prototype !== Object.prototype) {
          if (!Object.isFrozen(prototype)) return false;
          prototype = Object.getPrototypeOf(prototype) as object | null;
        }
        return true;
      });
      const generator = (function* () { yield 1; })();
      const asyncGenerator = (async function* () { yield 1; })();
      const commonIteratorPrototypes = [
        Object.getPrototypeOf(Object.getPrototypeOf(generator)),
        Object.getPrototypeOf(Object.getPrototypeOf(asyncGenerator)),
      ] as object[];
      const commonChainsFrozen = commonIteratorPrototypes.every((start) => {
        let prototype: object | null = start;
        while (prototype && prototype !== Object.prototype) {
          if (!Object.isFrozen(prototype)) return false;
          prototype = Object.getPrototypeOf(prototype) as object | null;
        }
        return true;
      });
      const iteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as {
        next(): IteratorResult<unknown>;
      };
      let assignmentBlocked = false;
      try {
        iteratorPrototype.next = () => ({ done: true, value: undefined });
      } catch {
        assignmentBlocked = true;
      }
      result = chainsFrozen && commonChainsFrozen && assignmentBlocked
        ? Manifold.cube([2, 2, 2], true)
        : Manifold.cube([9, 9, 9], true);
    `;
    const { report } = await runner.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.stats?.bbox?.size).toEqual([2, 2, 2]);
    expect(report.hints.some(hint => hint.startsWith('GC_DELETE_FAILED:'))).toBe(false);
  }, 20_000);
});
