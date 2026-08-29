/**
 * Shared wire-format definitions for annotations exchanged between the
 * preview server (Node) and the viewer (browser). This module is the
 * SINGLE source of truth — both sides import from here so that adding
 * or renaming a wire field cannot silently desync the two halves.
 *
 * The full client-side annotation (with per-triangle indices for
 * region selections) lives in packages/viewer/src/marks/types.ts; THIS is
 * the on-the-wire/server projection that AI clients see via the
 * `get_annotations` MCP tool.
 *
 * Multi-tab note: every annotation may carry a `clientId` identifying
 * the WS connection that produced it. The server uses this to merge
 * annotations across multiple viewer tabs without one tab clobbering
 * the other (VIE-2). AI clients still see a flat list — the clientId
 * is purely an internal routing tag.
 */
export interface WireAnnotation {
  id: string;
  modelVersion: string;
  kind: 'point' | 'region' | 'sketch';
  partLabel: string;
  note: string;
  worldCoord: [number, number, number];
  /** Only set for kind='region'. Number of triangles in the selection. */
  triCount?: number;
  /** Only set for kind='sketch'. View-aligned plane used for 2D sketch strokes. */
  viewPlane?: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  /** Only set for kind='sketch'. World-space origin of the sketch plane. */
  planeOrigin?: [number, number, number];
  /** Only set for kind='sketch'. 2D strokes in sketch-plane coordinates. */
  strokes?: Array<Array<[number, number]>>;
  /**
   * Server-assigned identifier of the WebSocket connection that owns
   * this annotation. Set by the server on the inbound message before
   * caching; viewers don't have to populate it. AI consumers see a
   * flat union of all clients' annotations and can ignore this field.
   */
  clientId?: string;
}

export const ANNOTATIONS_PROTOCOL_VERSION = 1 as const;
export const MAX_ANNOTATIONS = 500;
export const MAX_ANNOTATION_ID_LENGTH = 64;
export const MAX_ANNOTATION_NOTE_LENGTH = 4_096;
export const MAX_ANNOTATIONS_PAYLOAD_BYTES = 256 * 1024;

export type AnnotationsProtocolVersion = typeof ANNOTATIONS_PROTOCOL_VERSION;

export interface AnnotationsMessage {
  kind: 'annotations';
  /** Missing only for the immediately preceding legacy wire format. */
  protocolVersion?: AnnotationsProtocolVersion;
  /** Missing only for the immediately preceding legacy wire format. */
  revision?: number;
  modelVersion: string;
  items: WireAnnotation[];
}

export interface VersionedAnnotationsMessage extends AnnotationsMessage {
  protocolVersion: AnnotationsProtocolVersion;
  revision: number;
}

export interface AnnotationsGuardOptions {
  /** Defaults to true to interoperate with the immediately preceding viewer. */
  allowLegacy?: boolean;
}

/**
 * Server -> client greeting frame, sent immediately after the WS
 * handshake succeeds. Tells the viewer which clientId the server has
 * assigned to it so subsequent uplink messages and replayed snapshots
 * can be reasoned about consistently.
 */
export type { HelloMessage } from './model.js';

/**
 * Type guard for the WS text frames the preview server accepts from
 * connected viewers. Anything that isn't an `annotations` message is
 * ignored (forward compatible).
 *
 * Validates the shape of every item too — a truncated or malformed
 * payload (e.g. a stale viewer that omits `worldCoord`) is rejected
 * outright rather than silently merged into the cache. This is
 * tighter than the original guard which only checked the top-level
 * `kind` and `items` array (VIE-7).
 */
export function createAnnotationsMessage(
  modelVersion: string,
  revision: number,
  items: readonly WireAnnotation[],
): VersionedAnnotationsMessage {
  const parsed = parseAnnotationsMessage(
    {
      kind: 'annotations',
      protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
      revision,
      modelVersion,
      items: [...items],
    },
    { allowLegacy: false },
  );
  return parsed as VersionedAnnotationsMessage;
}

export function parseAnnotationsMessage(
  x: unknown,
  { allowLegacy = true }: AnnotationsGuardOptions = {},
): AnnotationsMessage {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    throw new Error('Annotations message must be an object.');
  }
  const m = x as Record<string, unknown>;
  if (Object.keys(m).some(key => !['kind', 'protocolVersion', 'revision', 'modelVersion', 'items'].includes(key))) {
    throw new Error('Annotations message contains unsupported fields.');
  }
  if (m.kind !== 'annotations') {
    throw new Error('Annotations message kind must be "annotations".');
  }
  const legacy = m.protocolVersion === undefined && m.revision === undefined;
  if (legacy) {
    if (!allowLegacy) {
      throw new Error('Annotations protocolVersion and revision are required.');
    }
  } else if (m.protocolVersion !== ANNOTATIONS_PROTOCOL_VERSION) {
    throw new Error(`Unsupported annotations protocolVersion ${String(m.protocolVersion)}.`);
  } else if (typeof m.revision !== 'number' || !Number.isSafeInteger(m.revision) || m.revision < 0) {
    throw new Error('Annotations revision must be a nonnegative safe integer.');
  }
  const modelVersion = boundedString(m.modelVersion, 'Annotations modelVersion', 128, false);
  if (!Array.isArray(m.items) || m.items.length > MAX_ANNOTATIONS) {
    throw new Error(`Annotations items must contain at most ${MAX_ANNOTATIONS} entries.`);
  }
  const items = m.items.map((item, index) => parseWireAnnotation(item, `Annotation ${index}`));
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('Annotation ids must be unique within a snapshot.');
  }
  if (items.some(item => item.modelVersion !== modelVersion)) {
    throw new Error('Every annotation modelVersion must match its snapshot.');
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(x)).byteLength > MAX_ANNOTATIONS_PAYLOAD_BYTES) {
      throw new Error(`Annotations payload exceeds ${MAX_ANNOTATIONS_PAYLOAD_BYTES} bytes.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Annotations payload exceeds')) {
      throw error;
    }
    throw new Error('Annotations payload must be JSON serializable.', { cause: error });
  }
  return {
    kind: 'annotations',
    ...(!legacy
      ? {
          protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
          revision: m.revision as number,
        }
      : {}),
    modelVersion,
    items,
  };
}

export function isAnnotationsMessage(x: unknown, options?: AnnotationsGuardOptions): x is AnnotationsMessage {
  try {
    parseAnnotationsMessage(x, options);
    return true;
  } catch {
    return false;
  }
}

export function parseWireAnnotation(x: unknown, label = 'Annotation'): WireAnnotation {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    throw new Error(`${label} must be an object.`);
  }
  const a = x as Record<string, unknown>;
  const allowed = new Set([
    'id',
    'modelVersion',
    'kind',
    'partLabel',
    'note',
    'worldCoord',
    'triCount',
    'viewPlane',
    'planeOrigin',
    'strokes',
    'clientId',
  ]);
  if (Object.keys(a).some(key => !allowed.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
  const id = boundedIdentifier(a.id, `${label} id`);
  const modelVersion = boundedString(a.modelVersion, `${label} modelVersion`, 128, false);
  if (a.kind !== 'point' && a.kind !== 'region' && a.kind !== 'sketch') {
    throw new Error(`${label} kind is unsupported.`);
  }
  const partLabel = boundedString(a.partLabel, `${label} partLabel`, 160, false);
  const note = boundedString(a.note, `${label} note`, MAX_ANNOTATION_NOTE_LENGTH, true);
  const worldCoord = numberTuple3(a.worldCoord, `${label} worldCoord`);
  if (
    a.triCount !== undefined &&
    (typeof a.triCount !== 'number' || !Number.isSafeInteger(a.triCount) || a.triCount < 0)
  ) {
    throw new Error(`${label} triCount must be a nonnegative safe integer.`);
  }
  const clientId = a.clientId === undefined ? undefined : boundedIdentifier(a.clientId, `${label} clientId`, 128);
  const base: WireAnnotation = {
    id,
    modelVersion,
    kind: a.kind,
    partLabel,
    note,
    worldCoord,
    ...(a.triCount !== undefined ? { triCount: a.triCount } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  };
  if (a.kind === 'sketch') {
    return { ...base, ...parseWireSketchAnnotation(a, label) };
  }
  if (a.viewPlane !== undefined || a.planeOrigin !== undefined || a.strokes !== undefined) {
    throw new Error(`${label} sketch fields require kind="sketch".`);
  }
  return base;
}

const VIEW_PLANES = new Set(['front', 'back', 'left', 'right', 'top', 'bottom']);

function isNumber2(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && x.every(value => typeof value === 'number' && Number.isFinite(value));
}

function parseWireSketchAnnotation(
  a: Record<string, unknown>,
  label: string,
): Pick<WireAnnotation, 'viewPlane' | 'planeOrigin' | 'strokes'> {
  if (typeof a.viewPlane !== 'string' || !VIEW_PLANES.has(a.viewPlane)) {
    throw new Error(`${label} viewPlane is unsupported.`);
  }
  const planeOrigin = numberTuple3(a.planeOrigin, `${label} planeOrigin`);
  if (!Array.isArray(a.strokes) || a.strokes.length === 0 || a.strokes.length > 256) {
    throw new Error(`${label} strokes must contain between 1 and 256 strokes.`);
  }
  for (const stroke of a.strokes) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 4_096) {
      throw new Error(`${label} stroke length is invalid.`);
    }
    for (const point of stroke) {
      if (!isNumber2(point)) {
        throw new Error(`${label} stroke points must be finite number tuples.`);
      }
    }
  }
  return {
    viewPlane: a.viewPlane as NonNullable<WireAnnotation['viewPlane']>,
    planeOrigin,
    strokes: a.strokes as NonNullable<WireAnnotation['strokes']>,
  };
}

function boundedIdentifier(value: unknown, label: string, maxLength = MAX_ANNOTATION_ID_LENGTH): string {
  const id = boundedString(value, label, maxLength, false);
  if (!/^[A-Za-z0-9][-A-Za-z0-9._:]*$/.test(id)) {
    throw new Error(`${label} must be a safe identifier.`);
  }
  return id;
}

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength ||
    hasUnsafeControlCharacter(value)
  ) {
    throw new Error(`${label} must be bounded text no longer than ${maxLength} characters.`);
  }
  return value;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function numberTuple3(value: unknown, label: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    throw new Error(`${label} must be a tuple of three finite numbers.`);
  }
  return [value[0]!, value[1]!, value[2]!];
}
