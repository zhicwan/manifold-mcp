import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Runner } from '@manifold3d/modeling/runner/host.js';
import { afterAll, describe, expect, it } from 'vitest';

const references = resolve(import.meta.dirname, '../skills/shared/references');

function examples(file: string): string[] {
  return Array.from(readFileSync(resolve(references, file), 'utf8').matchAll(/```ts\r?\n([\s\S]*?)```/g), match => {
    const code = match[1];
    assert(code !== undefined, `Missing TypeScript block in ${file}`);
    return code;
  });
}

const memory = examples('memory-management.md');
const tips = examples('tips.md');

describe('shipped skill reference examples', () => {
  const runner = new Runner();
  afterAll(() => runner.dispose());

  it('includes all expected runnable examples', () => {
    expect(memory).toHaveLength(1);
    expect(tips).toHaveLength(3);
  });

  it.each([
    { name: 'managed cleanup', code: memory[0], size: [10, 10, 50], volume: 5000 },
    { name: 'integer-friendly precision', code: tips[0], size: [100, 100, 100], volume: 1_000_000 },
    { name: 'composed degree rotations', code: tips[1], size: [30 / Math.SQRT2, 30, 30 / Math.SQRT2], volume: 6000 },
    { name: 'radian conversion', code: tips[2], size: [30 / Math.SQRT2, 30 / Math.SQRT2, 30], volume: 6000 },
  ])('$name produces the intended geometry without cleanup failures', async ({ name, code, size, volume }) => {
    assert(code !== undefined, `Missing ${name} example`);
    const { report } = await runner.run({ mode: 'validate', code }, { timeoutMs: 15_000 });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.hints.some(hint => hint.includes('GC_DELETE_FAILED'))).toBe(false);
    expect(report.stats?.volume).toBeCloseTo(volume, 4);
    size.forEach((length, axis) => {
      expect(report.stats?.bbox.size[axis]).toBeCloseTo(length, 5);
    });
  });
});
