import type { WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import type { JsonValue } from './sdk-boundary.js';

export const ANNOTATION_ATTACHMENT_VERSION = 1 as const;
export const MAX_ATTACHMENT_ANNOTATIONS = 128;
export const MAX_ATTACHMENT_NOTE_LENGTH = 4_096;
export const MAX_ATTACHMENT_SKETCH_POINTS = 8_192;
export const MAX_ANNOTATION_ATTACHMENT_BYTES = 128 * 1024;

export interface AnnotationAttachmentPayload {
  version: typeof ANNOTATION_ATTACHMENT_VERSION;
  source: 'manifold3d-viewer';
  modelVersion: string;
  annotationRevision: number;
  annotations: AnnotationAttachmentItem[];
}

export interface AnnotationAttachmentItem {
  id: string;
  partLabel: string;
  note: string;
  selection:
    | {
        kind: 'point';
        worldCoord: [number, number, number];
      }
    | {
        kind: 'region';
        worldCoord: [number, number, number];
        triangleCount: number;
      }
    | {
        kind: 'sketch';
        worldCoord: [number, number, number];
        viewPlane: NonNullable<WireAnnotation['viewPlane']>;
        planeOrigin: [number, number, number];
        strokes: Array<Array<[number, number]>>;
      };
}

export interface BuiltAnnotationAttachment {
  payload: AnnotationAttachmentPayload;
  json: string;
  bytes: Uint8Array;
}

export function buildAnnotationAttachment(input: {
  modelVersion: string;
  annotationRevision: number;
  annotations: readonly WireAnnotation[];
}): BuiltAnnotationAttachment {
  if (input.modelVersion.length === 0 || input.modelVersion.length > 128) {
    throw new Error('Annotation attachment modelVersion must be bounded text.');
  }
  if (!Number.isSafeInteger(input.annotationRevision) || input.annotationRevision < 0) {
    throw new Error('Annotation attachment revision must be a nonnegative safe integer.');
  }
  if (input.annotations.length === 0 || input.annotations.length > MAX_ATTACHMENT_ANNOTATIONS) {
    throw new Error(`Annotation attachment must contain between 1 and ${MAX_ATTACHMENT_ANNOTATIONS} annotations.`);
  }

  const annotations = input.annotations.map((annotation, index) => sanitizeAnnotation(annotation, index));
  const payload: AnnotationAttachmentPayload = {
    version: ANNOTATION_ATTACHMENT_VERSION,
    source: 'manifold3d-viewer',
    modelVersion: input.modelVersion,
    annotationRevision: input.annotationRevision,
    annotations,
  };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_ANNOTATION_ATTACHMENT_BYTES) {
    throw new Error(`Annotation attachment exceeds ${MAX_ANNOTATION_ATTACHMENT_BYTES} bytes.`);
  }
  return { payload, json, bytes };
}

export function annotationPayloadAsJsonValue(payload: AnnotationAttachmentPayload): JsonValue {
  return structuredClone(payload) as unknown as JsonValue;
}

function sanitizeAnnotation(annotation: WireAnnotation, index: number): AnnotationAttachmentItem {
  const label = `Annotation ${index}`;
  if (annotation.note.length > MAX_ATTACHMENT_NOTE_LENGTH) {
    throw new Error(`${label} note exceeds ${MAX_ATTACHMENT_NOTE_LENGTH} characters.`);
  }
  const base = {
    id: boundedText(annotation.id, `${label} id`, 64, false),
    partLabel: boundedText(annotation.partLabel, `${label} partLabel`, 160, false),
    note: boundedText(annotation.note, `${label} note`, MAX_ATTACHMENT_NOTE_LENGTH, true),
  };
  const worldCoord = finiteTuple3(annotation.worldCoord, `${label} worldCoord`);
  if (annotation.kind === 'point') {
    return {
      ...base,
      selection: {
        kind: 'point',
        worldCoord,
      },
    };
  }
  if (annotation.kind === 'region') {
    if (!Number.isSafeInteger(annotation.triCount) || (annotation.triCount ?? -1) < 0) {
      throw new Error(`${label} region triangle count is invalid.`);
    }
    return {
      ...base,
      selection: {
        kind: 'region',
        worldCoord,
        triangleCount: annotation.triCount!,
      },
    };
  }

  if (!annotation.viewPlane || !annotation.planeOrigin || !annotation.strokes) {
    throw new Error(`${label} sketch data is incomplete.`);
  }
  let pointCount = 0;
  if (annotation.strokes.length === 0 || annotation.strokes.length > 256) {
    throw new Error(`${label} sketch must contain between 1 and 256 strokes.`);
  }
  const strokes = annotation.strokes.map((stroke, strokeIndex) => {
    if (stroke.length < 2 || stroke.length > 4_096) {
      throw new Error(`${label} stroke ${strokeIndex} length is invalid.`);
    }
    return stroke.map((point, pointIndex) => {
      pointCount += 1;
      if (pointCount > MAX_ATTACHMENT_SKETCH_POINTS) {
        throw new Error(`Annotation attachment sketches exceed ${MAX_ATTACHMENT_SKETCH_POINTS} points.`);
      }
      return finiteTuple2(point, `${label} stroke ${strokeIndex} point ${pointIndex}`);
    });
  });
  return {
    ...base,
    selection: {
      kind: 'sketch',
      worldCoord,
      viewPlane: annotation.viewPlane,
      planeOrigin: finiteTuple3(annotation.planeOrigin, `${label} planeOrigin`),
      strokes,
    },
  };
}

function boundedText(value: string, label: string, maxLength: number, allowEmpty: boolean): string {
  if (
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength ||
    [...value].some(character => {
      const code = character.charCodeAt(0);
      return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
    })
  ) {
    throw new Error(`${label} must be bounded plain text.`);
  }
  return value;
}

function finiteTuple2(value: readonly number[], label: string): [number, number] {
  if (value.length !== 2 || !value.every(Number.isFinite)) {
    throw new Error(`${label} must contain two finite numbers.`);
  }
  return [value[0]!, value[1]!];
}

function finiteTuple3(value: readonly number[], label: string): [number, number, number] {
  if (value.length !== 3 || !value.every(Number.isFinite)) {
    throw new Error(`${label} must contain three finite numbers.`);
  }
  return [value[0]!, value[1]!, value[2]!];
}
