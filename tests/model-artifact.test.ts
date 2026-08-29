import { describe, expect, it } from 'vitest';

import { toViewerModelFrame } from '../packages/modeling/src/runner/model-artifact.js';
import type { ModelArtifact } from '../packages/modeling/src/runner/protocol.js';

describe('ModelArtifact viewer projection', () => {
  it('keeps geometry buffers by reference and sanitizes the viewer fields', () => {
    const vertProperties = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer;
    const triVerts = new Uint32Array([0, 1, 2]).buffer;
    const triFeatureIds = new Uint32Array([0]).buffer;
    const artifact = {
      description: 'sanitized model',
      numProp: 3,
      triangles: 1,
      vertices: 3,
      vertProperties,
      triVerts,
      triFeatureIds,
      features: [
        {
          label: 'cube#1',
          kind: 'cube',
          params: { size: [1, 1, 1], omitted: undefined },
          transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
          workerPrivate: 'not viewer data',
        },
      ],
      volume: 1,
      surfaceArea: 6,
      genus: 0,
      bboxMin: [0, 0, 0],
      bboxMax: [1, 1, 1],
      compilerPrivate: 'not viewer data',
    } as unknown as ModelArtifact;

    const frame = toViewerModelFrame(artifact);

    expect(frame.vertProperties).toBe(vertProperties);
    expect(frame.triVerts).toBe(triVerts);
    expect(frame.triFeatureIds).toBe(triFeatureIds);
    expect(frame).not.toHaveProperty('compilerPrivate');
    expect(frame.features[0]).toEqual({
      label: 'cube#1',
      kind: 'cube',
      params: { size: [1, 1, 1] },
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    });
    expect(frame.features[0]).not.toHaveProperty('workerPrivate');
  });
});
