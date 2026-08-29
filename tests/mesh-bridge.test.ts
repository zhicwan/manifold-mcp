import { describe, expect, it } from 'vitest';

import { packPositions } from '../packages/viewer/src/scene/mesh-bridge.js';
import type { PreviewPayload } from '../packages/viewer/src/types.js';

function payload(numProp: number, vertProperties: number[]): PreviewPayload {
  return {
    numProp,
    triangles: 0,
    vertices: numProp > 0 ? vertProperties.length / numProp : 0,
    vertProperties: new Float32Array(vertProperties),
    triVerts: new Uint32Array(),
    features: [],
    triFeatureIds: new Uint32Array(),
    volume: 0,
    surfaceArea: 0,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [0, 0, 0],
  };
}

describe('packPositions', () => {
  it('keeps an already packed xyz buffer', () => {
    const input = payload(3, [1, 2, 3, 4, 5, 6]);

    expect(packPositions(input)).toBe(input.vertProperties);
  });

  it('drops non-position vertex properties', () => {
    const input = payload(5, [1, 2, 3, 90, 91, 4, 5, 6, 92, 93]);

    expect([...packPositions(input)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects an invalid position stride', () => {
    expect(() => packPositions(payload(2, [1, 2]))).toThrow(/valid position stride/);
    expect(() => packPositions(payload(4, [1, 2, 3, 4, 5]))).toThrow(/valid position stride/);
  });
});
