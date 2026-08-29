import { describe, expect, it } from 'vitest';

import type { WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import {
  buildAnnotationAttachment,
  MAX_ATTACHMENT_ANNOTATIONS,
  MAX_ATTACHMENT_SKETCH_POINTS,
} from '../src/annotation-attachment.js';

describe('AnnotationAttachment', () => {
  it('projects semantic point, region, and sketch data without transport fields', () => {
    const attachment = buildAnnotationAttachment({
      modelVersion: 'model-v1',
      annotationRevision: 7,
      annotations: [
        annotation({ kind: 'point', clientId: 'transport-client' }),
        annotation({ id: 'region', kind: 'region', triCount: 12 }),
        annotation({
          id: 'sketch',
          kind: 'sketch',
          viewPlane: 'front',
          planeOrigin: [0, 0, 0],
          strokes: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        }),
      ],
    });

    expect(attachment.payload).toMatchObject({
      version: 1,
      modelVersion: 'model-v1',
      annotationRevision: 7,
      annotations: [
        { selection: { kind: 'point' } },
        { selection: { kind: 'region', triangleCount: 12 } },
        { selection: { kind: 'sketch', viewPlane: 'front' } },
      ],
    });
    expect(attachment.json).not.toContain('clientId');
    expect(attachment.payload.annotations.some(item => 'modelVersion' in item)).toBe(false);
  });

  it('enforces count and aggregate sketch-point bounds', () => {
    expect(() =>
      buildAnnotationAttachment({
        modelVersion: 'model-v1',
        annotationRevision: 1,
        annotations: Array.from({ length: MAX_ATTACHMENT_ANNOTATIONS + 1 }, (_, index) =>
          annotation({ id: `point-${index}` }),
        ),
      }),
    ).toThrow(/at most|between/);

    expect(() =>
      buildAnnotationAttachment({
        modelVersion: 'model-v1',
        annotationRevision: 1,
        annotations: [
          annotation({
            kind: 'sketch',
            viewPlane: 'front',
            planeOrigin: [0, 0, 0],
            strokes: Array.from({ length: 3 }, (_stroke, strokeIndex) =>
              Array.from(
                { length: Math.floor(MAX_ATTACHMENT_SKETCH_POINTS / 3) + 1 },
                (_point, pointIndex) => [strokeIndex, pointIndex] as [number, number],
              ),
            ),
          }),
        ],
      }),
    ).toThrow(/sketches exceed/);
  });
});

function annotation(overrides: Partial<WireAnnotation> = {}): WireAnnotation {
  return {
    id: 'point',
    modelVersion: 'model-v1',
    kind: 'point',
    partLabel: 'part#1',
    note: 'note',
    worldCoord: [1, 2, 3],
    ...overrides,
  };
}
