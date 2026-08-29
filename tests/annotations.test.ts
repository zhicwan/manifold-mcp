import { describe, expect, it } from 'vitest';

import {
  ANNOTATIONS_PROTOCOL_VERSION,
  createAnnotationsMessage,
  isAnnotationsMessage,
} from '../packages/protocol/src/wire/annotations.js';

describe('isAnnotationsMessage', () => {
  it('returns true for a valid empty annotations message', () => {
    expect(
      isAnnotationsMessage({
        kind: 'annotations',
        modelVersion: 'v1',
        items: [],
      }),
    ).toBe(true);
  });

  it('returns true for a valid populated annotations message', () => {
    expect(
      isAnnotationsMessage({
        kind: 'annotations',
        modelVersion: 'v2',
        items: [
          {
            id: 'a1',
            modelVersion: 'v2',
            kind: 'point',
            partLabel: 'point#1',
            note: 'too thick',
            worldCoord: [1, 2, 3],
          },
        ],
      }),
    ).toBe(true);
  });

  it('accepts the immediate legacy shape and validates the revisioned current shape', () => {
    expect(
      isAnnotationsMessage({
        kind: 'annotations',
        modelVersion: 'legacy-v1',
        items: [],
      }),
    ).toBe(true);
    expect(createAnnotationsMessage('v2', 4, [])).toEqual({
      kind: 'annotations',
      protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
      revision: 4,
      modelVersion: 'v2',
      items: [],
    });
    expect(
      isAnnotationsMessage({
        kind: 'annotations',
        protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
        modelVersion: 'v2',
        items: [],
      }),
    ).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAnnotationsMessage(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAnnotationsMessage(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isAnnotationsMessage('annotations')).toBe(false);
  });

  it('returns false for a wrong kind', () => {
    expect(isAnnotationsMessage({ kind: 'mesh', items: [] })).toBe(false);
  });

  it('returns false when items is missing', () => {
    expect(isAnnotationsMessage({ kind: 'annotations' })).toBe(false);
  });

  it('returns false when items is not an array', () => {
    expect(isAnnotationsMessage({ kind: 'annotations', items: 'oops' })).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isAnnotationsMessage(42)).toBe(false);
  });
});
