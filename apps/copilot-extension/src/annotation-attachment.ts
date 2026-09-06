import type { WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';

export const ANNOTATION_ATTACHMENT_VERSION = 2 as const;
export const MAX_ATTACHMENT_ANNOTATIONS = 128;
const MAX_ATTACHMENT_NOTE_LENGTH = 4_096;
export const MAX_ATTACHMENT_SKETCH_POINTS = 8_192;
export const MAX_ANNOTATION_ATTACHMENT_BYTES = 128 * 1024;
const MAX_ATTACHMENT_BATCH_ID_LENGTH = 64;

type AnnotationAttachmentMode = 'annotation-batch' | 'location-selection';

type AnnotationAttachmentBase = {
  version: typeof ANNOTATION_ATTACHMENT_VERSION;
  source: 'manifold3d-viewer';
  mode: AnnotationAttachmentMode;
  modelVersion: string;
  annotationRevision: number;
  annotations: AnnotationAttachmentItem[];
};

export type AnnotationBatchAttachmentPayload = AnnotationAttachmentBase & {
  mode: 'annotation-batch';
  batchId: string;
  annotations: AnnotationBatchAttachmentItem[];
};

export type LocationSelectionAttachmentPayload = AnnotationAttachmentBase & {
  mode: 'location-selection';
  annotations: [LocationSelectionAttachmentItem];
};

export type AnnotationAttachmentPayload = AnnotationBatchAttachmentPayload | LocationSelectionAttachmentPayload;

type AnnotationAttachmentItem = AnnotationBatchAttachmentItem | LocationSelectionAttachmentItem;

type AnnotationAttachmentItemBase = {
  id: string;
  partLabel: string;
};

type AnnotationBatchAttachmentItem = AnnotationAttachmentItemBase & {
  note: string;
  selection: AnnotationSelection;
};

type LocationSelectionAttachmentItem = AnnotationAttachmentItemBase & {
  selection: PointSelection | RegionSelection;
};

type AnnotationSelection = PointSelection | RegionSelection | SketchSelection;

type PointSelection = {
  kind: 'point';
  worldCoord: [number, number, number];
};

type RegionSelection = {
  kind: 'region';
  worldCoord: [number, number, number];
  triangleCount: number;
};

type SketchSelection = {
  kind: 'sketch';
  worldCoord: [number, number, number];
  viewPlane: NonNullable<WireAnnotation['viewPlane']>;
  planeOrigin: [number, number, number];
  strokes: Array<Array<[number, number]>>;
};

interface AnnotationAttachmentBuildBase {
  modelVersion: string;
  annotationRevision: number;
  annotations: readonly WireAnnotation[];
}

type AnnotationAttachmentBuildInput =
  | (AnnotationAttachmentBuildBase & {
      mode: 'annotation-batch';
      batchId: string;
    })
  | (AnnotationAttachmentBuildBase & {
      mode: 'location-selection';
    });

export function buildAnnotationAttachment(
  input: Extract<AnnotationAttachmentBuildInput, { mode: 'annotation-batch' }>,
): AnnotationBatchAttachmentPayload;
export function buildAnnotationAttachment(
  input: Extract<AnnotationAttachmentBuildInput, { mode: 'location-selection' }>,
): LocationSelectionAttachmentPayload;
export function buildAnnotationAttachment(input: AnnotationAttachmentBuildInput): AnnotationAttachmentPayload {
  const annotations =
    input.mode === 'annotation-batch'
      ? input.annotations.map((annotation, index) => sanitizeBatchAnnotation(annotation, index))
      : input.annotations.map((annotation, index) => sanitizeLocationAnnotation(annotation, index));
  return parseAnnotationAttachment({
    version: ANNOTATION_ATTACHMENT_VERSION,
    source: 'manifold3d-viewer',
    mode: input.mode,
    modelVersion: input.modelVersion,
    annotationRevision: input.annotationRevision,
    annotations,
    ...(input.mode === 'annotation-batch' ? { batchId: input.batchId } : {}),
  });
}

export function parseAnnotationAttachment(value: unknown): AnnotationAttachmentPayload {
  assertAttachmentByteLimit(value);
  const record = requireRecord(value, 'Annotation attachment');
  requireOnlyKeys(
    record,
    ['version', 'source', 'mode', 'modelVersion', 'annotationRevision', 'annotations', 'batchId'],
    'Annotation attachment',
  );
  if (record.version !== ANNOTATION_ATTACHMENT_VERSION) {
    throw new Error(`Annotation attachment version must be ${ANNOTATION_ATTACHMENT_VERSION}.`);
  }
  if (record.source !== 'manifold3d-viewer') {
    throw new Error('Annotation attachment source is unsupported.');
  }
  if (record.mode !== 'annotation-batch' && record.mode !== 'location-selection') {
    throw new Error('Annotation attachment mode is unsupported.');
  }
  const modelVersion = boundedText(record.modelVersion, 'Annotation attachment modelVersion', 128, false);
  if (
    typeof record.annotationRevision !== 'number' ||
    !Number.isSafeInteger(record.annotationRevision) ||
    record.annotationRevision < 0
  ) {
    throw new Error('Annotation attachment revision must be a nonnegative safe integer.');
  }
  if (!Array.isArray(record.annotations)) {
    throw new Error('Annotation attachment annotations must be an array.');
  }

  if (record.mode === 'annotation-batch') {
    if (record.annotations.length === 0 || record.annotations.length > MAX_ATTACHMENT_ANNOTATIONS) {
      throw new Error(`Annotation batch must contain between 1 and ${MAX_ATTACHMENT_ANNOTATIONS} annotations.`);
    }
    const batchId = boundedIdentifier(record.batchId, 'Annotation attachment batchId', MAX_ATTACHMENT_BATCH_ID_LENGTH);
    const pointCounter = { value: 0 };
    const annotations = record.annotations.map((annotation, index) =>
      parseBatchAnnotation(annotation, index, pointCounter),
    );
    requireUniqueAnnotationIds(annotations);
    return {
      version: ANNOTATION_ATTACHMENT_VERSION,
      source: 'manifold3d-viewer',
      mode: 'annotation-batch',
      modelVersion,
      annotationRevision: record.annotationRevision,
      annotations,
      batchId,
    };
  }

  if (Object.hasOwn(record, 'batchId')) {
    throw new Error('Location selection attachments must not include batchId.');
  }
  if (record.annotations.length !== 1) {
    throw new Error('Location selection attachment must contain exactly one annotation.');
  }
  return {
    version: ANNOTATION_ATTACHMENT_VERSION,
    source: 'manifold3d-viewer',
    mode: 'location-selection',
    modelVersion,
    annotationRevision: record.annotationRevision,
    annotations: [parseLocationAnnotation(record.annotations[0], 0)],
  };
}

export function isAnnotationAttachment(value: unknown): value is AnnotationAttachmentPayload {
  try {
    parseAnnotationAttachment(value);
    return true;
  } catch {
    return false;
  }
}

function sanitizeBatchAnnotation(annotation: WireAnnotation, index: number): AnnotationBatchAttachmentItem {
  return {
    ...sanitizeAnnotationBase(annotation, index),
    note: boundedText(annotation.note, `Annotation ${index} note`, MAX_ATTACHMENT_NOTE_LENGTH, false),
    selection: sanitizeSelection(annotation, index),
  };
}

function sanitizeLocationAnnotation(annotation: WireAnnotation, index: number): LocationSelectionAttachmentItem {
  const note = boundedText(annotation.note, `Annotation ${index} note`, MAX_ATTACHMENT_NOTE_LENGTH, true);
  if (note.trim().length > 0) {
    throw new Error('Location selection annotation note must be empty.');
  }
  const selection = sanitizeSelection(annotation, index);
  if (selection.kind === 'sketch') {
    throw new Error('Location selection annotation must be a point or region.');
  }
  return {
    ...sanitizeAnnotationBase(annotation, index),
    selection,
  };
}

function sanitizeAnnotationBase(
  annotation: WireAnnotation,
  index: number,
): Pick<AnnotationAttachmentItemBase, 'id' | 'partLabel'> {
  return {
    id: boundedIdentifier(annotation.id, `Annotation ${index} id`, 64),
    partLabel: boundedText(annotation.partLabel, `Annotation ${index} partLabel`, 160, false),
  };
}

function sanitizeSelection(annotation: WireAnnotation, index: number): AnnotationSelection {
  const label = `Annotation ${index}`;
  const worldCoord = finiteTuple3(annotation.worldCoord, `${label} worldCoord`);
  if (annotation.kind === 'point') {
    return { kind: 'point', worldCoord };
  }
  if (annotation.kind === 'region') {
    const triangleCount = annotation.triCount;
    if (triangleCount === undefined || !Number.isSafeInteger(triangleCount) || triangleCount < 0) {
      throw new Error(`${label} region triangle count is invalid.`);
    }
    return {
      kind: 'region',
      worldCoord,
      triangleCount,
    };
  }
  if (!annotation.viewPlane || !annotation.planeOrigin || !annotation.strokes) {
    throw new Error(`${label} sketch data is incomplete.`);
  }
  const pointCounter = { value: 0 };
  return {
    kind: 'sketch',
    worldCoord,
    viewPlane: annotation.viewPlane,
    planeOrigin: finiteTuple3(annotation.planeOrigin, `${label} planeOrigin`),
    strokes: sanitizeStrokes(annotation.strokes, label, pointCounter),
  };
}

function parseBatchAnnotation(
  value: unknown,
  index: number,
  pointCounter: { value: number },
): AnnotationBatchAttachmentItem {
  const label = `Annotation ${index}`;
  const record = requireRecord(value, label);
  requireOnlyKeys(record, ['id', 'partLabel', 'note', 'selection'], label);
  return {
    id: boundedIdentifier(record.id, `${label} id`, 64),
    partLabel: boundedText(record.partLabel, `${label} partLabel`, 160, false),
    note: boundedText(record.note, `${label} note`, MAX_ATTACHMENT_NOTE_LENGTH, false),
    selection: parseSelection(record.selection, label, true, pointCounter),
  };
}

function parseLocationAnnotation(value: unknown, index: number): LocationSelectionAttachmentItem {
  const label = `Annotation ${index}`;
  const record = requireRecord(value, label);
  requireOnlyKeys(record, ['id', 'partLabel', 'selection'], label);
  const selection = parseSelection(record.selection, label, false, { value: 0 });
  if (selection.kind === 'sketch') {
    throw new Error(`${label} location selection must be a point or region.`);
  }
  return {
    id: boundedIdentifier(record.id, `${label} id`, 64),
    partLabel: boundedText(record.partLabel, `${label} partLabel`, 160, false),
    selection,
  };
}

function parseSelection(
  value: unknown,
  label: string,
  allowSketch: boolean,
  pointCounter: { value: number },
): AnnotationSelection {
  const record = requireRecord(value, `${label} selection`);
  if (record.kind === 'point') {
    requireOnlyKeys(record, ['kind', 'worldCoord'], `${label} selection`);
    return {
      kind: 'point',
      worldCoord: finiteTuple3(record.worldCoord, `${label} worldCoord`),
    };
  }
  if (record.kind === 'region') {
    requireOnlyKeys(record, ['kind', 'worldCoord', 'triangleCount'], `${label} selection`);
    if (
      typeof record.triangleCount !== 'number' ||
      !Number.isSafeInteger(record.triangleCount) ||
      record.triangleCount < 0
    ) {
      throw new Error(`${label} region triangle count is invalid.`);
    }
    return {
      kind: 'region',
      worldCoord: finiteTuple3(record.worldCoord, `${label} worldCoord`),
      triangleCount: record.triangleCount,
    };
  }
  if (record.kind !== 'sketch' || !allowSketch) {
    throw new Error(`${label} selection kind is unsupported.`);
  }
  requireOnlyKeys(record, ['kind', 'worldCoord', 'viewPlane', 'planeOrigin', 'strokes'], `${label} selection`);
  if (
    record.viewPlane !== 'front' &&
    record.viewPlane !== 'back' &&
    record.viewPlane !== 'left' &&
    record.viewPlane !== 'right' &&
    record.viewPlane !== 'top' &&
    record.viewPlane !== 'bottom'
  ) {
    throw new Error(`${label} sketch viewPlane is unsupported.`);
  }
  if (!Array.isArray(record.strokes)) {
    throw new Error(`${label} sketch strokes must be an array.`);
  }
  return {
    kind: 'sketch',
    worldCoord: finiteTuple3(record.worldCoord, `${label} worldCoord`),
    viewPlane: record.viewPlane,
    planeOrigin: finiteTuple3(record.planeOrigin, `${label} planeOrigin`),
    strokes: sanitizeStrokes(record.strokes, label, pointCounter),
  };
}

function sanitizeStrokes(
  strokes: readonly unknown[],
  label: string,
  pointCounter: { value: number },
): Array<Array<[number, number]>> {
  if (strokes.length === 0 || strokes.length > 256) {
    throw new Error(`${label} sketch must contain between 1 and 256 strokes.`);
  }
  return strokes.map((stroke, strokeIndex) => {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 4_096) {
      throw new Error(`${label} stroke ${strokeIndex} length is invalid.`);
    }
    return stroke.map((point, pointIndex) => {
      pointCounter.value += 1;
      if (pointCounter.value > MAX_ATTACHMENT_SKETCH_POINTS) {
        throw new Error(`Annotation attachment sketches exceed ${MAX_ATTACHMENT_SKETCH_POINTS} points.`);
      }
      return finiteTuple2(point, `${label} stroke ${strokeIndex} point ${pointIndex}`);
    });
  });
}

function assertAttachmentByteLimit(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error('Annotation attachment must be JSON serializable.', { cause: error });
  }
  if (serialized === undefined) {
    throw new Error('Annotation attachment must be JSON serializable.');
  }
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > MAX_ANNOTATION_ATTACHMENT_BYTES) {
    throw new Error(`Annotation attachment exceeds ${MAX_ANNOTATION_ATTACHMENT_BYTES} bytes.`);
  }
}

function requireUniqueAnnotationIds(annotations: readonly AnnotationAttachmentItem[]): void {
  if (new Set(annotations.map(annotation => annotation.id)).size !== annotations.length) {
    throw new Error('Annotation attachment ids must be unique.');
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find(key => !allowedSet.has(key));
  if (unexpected !== undefined) {
    throw new Error(`${label} contains unsupported field "${unexpected}".`);
  }
}

function boundedIdentifier(value: unknown, label: string, maxLength: number): string {
  const parsed = boundedText(value, label, maxLength, false);
  if (!/^[A-Za-z0-9][-A-Za-z0-9._:]*$/.test(parsed)) {
    throw new Error(`${label} must be a safe identifier.`);
  }
  return parsed;
}

function boundedText(value: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength ||
    hasUnsafeControlCharacter(value)
  ) {
    throw new Error(`${label} must be bounded plain text.`);
  }
  return value;
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function finiteTuple2(value: unknown, label: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(item => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error(`${label} must contain two finite numbers.`);
  }
  return [value[0]!, value[1]!];
}

function finiteTuple3(value: unknown, label: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(item => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error(`${label} must contain three finite numbers.`);
  }
  return [value[0]!, value[1]!, value[2]!];
}
