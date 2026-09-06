import { describe, expect, it } from 'vitest';

import { runtimeSourceLocation } from '../packages/modeling/src/runner/runtime-location.js';

describe('runtime source-map lookup', () => {
  it('maps emitted frames without loading a sibling WASM resource', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['snippet.ts'],
      names: [],
      mappings: 'AAGA',
    });
    expect(runtimeSourceLocation('TypeError\n at eval (<anonymous>:5:1)', map)).toEqual({ line: 4, col: 1 });
  });

  it('retains the emitted location when the map has no matching source segment', () => {
    const map = JSON.stringify({ version: 3, sources: [], names: [], mappings: '' });
    expect(runtimeSourceLocation('Error\n at eval (<anonymous>:8:3)', map)).toEqual({ line: 4, col: 3 });
    expect(runtimeSourceLocation('Error\n at eval (<anonymous>:8:3)', undefined)).toEqual({ line: 4, col: 3 });
  });

  it('does not invent a source location for frames outside the snippet', () => {
    expect(runtimeSourceLocation('Error\n at native code', undefined)).toBeUndefined();
    expect(runtimeSourceLocation('Error\n at eval (<anonymous>:2:1)', undefined)).toBeUndefined();
  });
});
