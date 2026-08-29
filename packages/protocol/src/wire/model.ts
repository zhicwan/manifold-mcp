/**
 * Browser/Node wire contract for models sent by the preview server.
 *
 * Geometry is framed as one JSON header followed by two or three binary
 * ArrayBuffer frames:
 *   1. Float32 vertex properties
 *   2. Uint32 triangle vertex indices
 *   3. Uint32 per-triangle feature ids, when announced by the header
 *
 * Headers without protocolVersion are accepted as the immediately preceding
 * legacy format. A present version must always be supported.
 */

export const VIEWER_PROTOCOL_VERSION = 1 as const;

export type ViewerProtocolVersion = typeof VIEWER_PROTOCOL_VERSION;
export type FeatureKind = 'cube' | 'sphere' | 'cylinder' | 'tetrahedron' | 'extrude' | 'revolve' | 'unknown';
export type ViewerFeatureParam = number | boolean | number[];
export type ViewerFeatureParams = Readonly<Record<string, ViewerFeatureParam>>;

export interface ViewerFeature {
  label: string;
  kind: FeatureKind;
  params: ViewerFeatureParams;
  /** 3x4 column-major local-to-world transform. */
  transform: number[];
}

/** Backwards-compatible name for code that still calls the wire projection a WireFeature. */
export type WireFeature = ViewerFeature;

/** Server-side model projection. ArrayBuffers are sent as binary WS frames. */
export interface ViewerModelFrame {
  description?: string;
  numProp: number;
  triangles: number;
  vertices: number;
  vertProperties: ArrayBuffer;
  triVerts: ArrayBuffer;
  triFeatureIds: ArrayBuffer;
  features: ViewerFeature[];
  volume: number;
  surfaceArea: number;
  genus: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/** Browser-side model after the binary frames have been decoded. */
export interface ViewerModel {
  description?: string;
  numProp: number;
  triangles: number;
  vertices: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  triFeatureIds: Uint32Array;
  features: ViewerFeature[];
  volume: number;
  surfaceArea: number;
  genus: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

export interface ModelHeader {
  kind: 'mesh';
  /** Missing only for the immediately preceding legacy wire format. */
  protocolVersion?: ViewerProtocolVersion;
  description?: string;
  numProp: number;
  triangles: number;
  vertices: number;
  features: ViewerFeature[];
  hasTriFeatureIds: boolean;
  volume: number;
  surfaceArea: number;
  genus: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

export interface ModelVersionMessage {
  kind: 'model_version';
  /** Missing only for the immediately preceding legacy wire format. */
  protocolVersion?: ViewerProtocolVersion;
  modelVersion: string;
}

export interface HelloMessage {
  kind: 'hello';
  /** Missing only for the immediately preceding legacy wire format. */
  protocolVersion?: ViewerProtocolVersion;
  clientId: string;
  /** Rotating, room-bound capability used to reclaim this client after reconnect. */
  resumeToken?: string;
  /** True when the supplied resume token reclaimed an existing room client. */
  resumed?: boolean;
  /** Last annotation revision retained for this resumed client. */
  annotationRevision?: number;
}

export interface ResumeTokenAckMessage {
  kind: 'resume_token_ack';
  protocolVersion: ViewerProtocolVersion;
  resumeToken: string;
}

export type ModelBinaryFrameKind = 'vertProperties' | 'triVerts' | 'triFeatureIds';

export interface ViewerModelBinaryFrames {
  vertProperties: ArrayBuffer;
  triVerts: ArrayBuffer;
  triFeatureIds?: ArrayBuffer;
}

export interface ProtocolGuardOptions {
  /** Defaults to true to interoperate with the immediately preceding server. */
  allowLegacy?: boolean;
}

export class ViewerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewerProtocolError';
  }
}

export function createModelHeader(model: ViewerModelFrame): ModelHeader {
  return {
    kind: 'mesh',
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    ...(model.description !== undefined ? { description: model.description } : {}),
    numProp: model.numProp,
    triangles: model.triangles,
    vertices: model.vertices,
    features: model.features,
    hasTriFeatureIds: model.triFeatureIds.byteLength > 0,
    volume: model.volume,
    surfaceArea: model.surfaceArea,
    genus: model.genus,
    bboxMin: model.bboxMin,
    bboxMax: model.bboxMax,
  };
}

export function createModelVersionMessage(modelVersion: string): ModelVersionMessage {
  return { kind: 'model_version', protocolVersion: VIEWER_PROTOCOL_VERSION, modelVersion };
}

export function createHelloMessage(
  clientId: string,
  resumeToken?: string,
  resumed?: boolean,
  annotationRevision?: number,
): HelloMessage {
  const message = {
    kind: 'hello' as const,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    clientId,
    ...(resumeToken !== undefined ? { resumeToken, resumed: resumed ?? false } : {}),
    ...(annotationRevision !== undefined ? { annotationRevision } : {}),
  };
  return parseHelloMessage(message, { allowLegacy: false });
}

export function createResumeTokenAckMessage(resumeToken: string): ResumeTokenAckMessage {
  return parseResumeTokenAckMessage({
    kind: 'resume_token_ack',
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    resumeToken,
  });
}

export function parseModelHeader(value: unknown, options: ProtocolGuardOptions = {}): ModelHeader {
  const record = requireRecord(value, 'model header');
  if (record.kind !== 'mesh') {
    throw new ViewerProtocolError('Model header kind must be "mesh".');
  }
  const protocolVersion = parseProtocolVersion(record, options);
  const legacy = protocolVersion === undefined;
  const description = optionalString(record.description, 'description');
  const numProp = nonnegativeInteger(record.numProp, 'numProp');
  if (numProp < 3) {
    throw new ViewerProtocolError('Model header numProp must be at least 3.');
  }
  const triangles = nonnegativeInteger(record.triangles, 'triangles');
  const vertices = nonnegativeInteger(record.vertices, 'vertices');
  ensureSafeProduct(vertices, numProp, 'vertices * numProp');
  ensureSafeProduct(triangles, 3, 'triangles * 3');

  let features: ViewerFeature[];
  if (record.features === undefined && legacy) {
    features = [];
  } else if (!Array.isArray(record.features) || !record.features.every(isViewerFeature)) {
    throw new ViewerProtocolError('Model header features must be an array of valid viewer features.');
  } else {
    features = record.features;
  }

  let hasTriFeatureIds: boolean;
  if (record.hasTriFeatureIds === undefined && legacy) {
    hasTriFeatureIds = false;
  } else if (typeof record.hasTriFeatureIds !== 'boolean') {
    throw new ViewerProtocolError('Model header hasTriFeatureIds must be a boolean.');
  } else {
    hasTriFeatureIds = record.hasTriFeatureIds;
  }

  const volume = nonnegativeFiniteNumber(record.volume, 'volume');
  const surfaceArea = nonnegativeFiniteNumber(record.surfaceArea, 'surfaceArea');
  const genus = nonnegativeInteger(record.genus, 'genus');
  const bboxMin = numberTuple3(record.bboxMin, 'bboxMin');
  const bboxMax = numberTuple3(record.bboxMax, 'bboxMax');
  for (let axis = 0; axis < 3; axis += 1) {
    if (bboxMin[axis]! > bboxMax[axis]!) {
      throw new ViewerProtocolError(`Model header bboxMin[${axis}] must not exceed bboxMax[${axis}].`);
    }
  }

  return {
    kind: 'mesh',
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(description !== undefined ? { description } : {}),
    numProp,
    triangles,
    vertices,
    features,
    hasTriFeatureIds,
    volume,
    surfaceArea,
    genus,
    bboxMin,
    bboxMax,
  };
}

export function isModelHeader(value: unknown, options?: ProtocolGuardOptions): value is ModelHeader {
  try {
    parseModelHeader(value, options);
    return true;
  } catch {
    return false;
  }
}

export function parseModelVersionMessage(value: unknown, options: ProtocolGuardOptions = {}): ModelVersionMessage {
  const record = requireRecord(value, 'model version message');
  if (record.kind !== 'model_version') {
    throw new ViewerProtocolError('Model version message kind must be "model_version".');
  }
  const protocolVersion = parseProtocolVersion(record, options);
  const modelVersion = nonemptyString(record.modelVersion, 'modelVersion');
  return {
    kind: 'model_version',
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    modelVersion,
  };
}

export function isModelVersionMessage(value: unknown, options?: ProtocolGuardOptions): value is ModelVersionMessage {
  try {
    parseModelVersionMessage(value, options);
    return true;
  } catch {
    return false;
  }
}

export function parseHelloMessage(value: unknown, options: ProtocolGuardOptions = {}): HelloMessage {
  const record = requireRecord(value, 'hello message');
  if (record.kind !== 'hello') {
    throw new ViewerProtocolError('Hello message kind must be "hello".');
  }
  const protocolVersion = parseProtocolVersion(record, options);
  const clientId = nonemptyString(record.clientId, 'clientId');
  let resumeToken: string | undefined;
  let resumed: boolean | undefined;
  const annotationRevision =
    record.annotationRevision === undefined
      ? undefined
      : nonnegativeInteger(record.annotationRevision, 'annotationRevision');
  if (record.resumeToken !== undefined || record.resumed !== undefined) {
    resumeToken = safeIdentifier(record.resumeToken, 'resumeToken', 128);
    if (typeof record.resumed !== 'boolean') {
      throw new ViewerProtocolError('Hello message resumed must be a boolean when resumeToken is present.');
    }
    resumed = record.resumed;
  }
  return {
    kind: 'hello',
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    clientId,
    ...(resumeToken !== undefined && resumed !== undefined ? { resumeToken, resumed } : {}),
    ...(annotationRevision !== undefined ? { annotationRevision } : {}),
  };
}

export function isHelloMessage(value: unknown, options?: ProtocolGuardOptions): value is HelloMessage {
  try {
    parseHelloMessage(value, options);
    return true;
  } catch {
    return false;
  }
}

export function parseResumeTokenAckMessage(value: unknown): ResumeTokenAckMessage {
  const record = requireRecord(value, 'resume token acknowledgement');
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes('kind') ||
    !keys.includes('protocolVersion') ||
    !keys.includes('resumeToken')
  ) {
    throw new ViewerProtocolError('Resume token acknowledgement contains unsupported or missing fields.');
  }
  if (record.kind !== 'resume_token_ack') {
    throw new ViewerProtocolError('Resume token acknowledgement kind must be "resume_token_ack".');
  }
  parseProtocolVersion(record, { allowLegacy: false });
  const resumeToken = safeIdentifier(record.resumeToken, 'resumeToken', 128);
  return {
    kind: 'resume_token_ack',
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    resumeToken,
  };
}

export function isResumeTokenAckMessage(value: unknown): value is ResumeTokenAckMessage {
  try {
    parseResumeTokenAckMessage(value);
    return true;
  } catch {
    return false;
  }
}

export function isViewerFeature(value: unknown): value is ViewerFeature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const feature = value as Record<string, unknown>;
  return (
    typeof feature.label === 'string' &&
    feature.label.length > 0 &&
    isFeatureKind(feature.kind) &&
    isViewerFeatureParams(feature.params) &&
    Array.isArray(feature.transform) &&
    feature.transform.length === 12 &&
    feature.transform.every(isFiniteNumber)
  );
}

export function expectedModelBufferByteLength(header: ModelHeader, kind: ModelBinaryFrameKind): number {
  switch (kind) {
    case 'vertProperties':
      return safeByteLength(header.vertices, header.numProp, 'vertex properties');
    case 'triVerts':
      return safeByteLength(header.triangles, 3, 'triangle vertices');
    case 'triFeatureIds':
      return header.hasTriFeatureIds ? safeByteLength(header.triangles, 1, 'triangle feature ids') : 0;
  }
}

export function assertModelBinaryFrame(header: ModelHeader, kind: ModelBinaryFrameKind, buffer: ArrayBuffer): void {
  if (buffer.byteLength % 4 !== 0) {
    throw new ViewerProtocolError(`${kind} frame byte length ${buffer.byteLength} is not 4-byte aligned.`);
  }
  const expected = expectedModelBufferByteLength(header, kind);
  if (buffer.byteLength !== expected) {
    throw new ViewerProtocolError(
      `${kind} frame byte length ${buffer.byteLength} does not match the declared ${expected} bytes.`,
    );
  }
}

export function decodeViewerModel(header: ModelHeader, frames: ViewerModelBinaryFrames): ViewerModel {
  assertModelBinaryFrame(header, 'vertProperties', frames.vertProperties);
  assertModelBinaryFrame(header, 'triVerts', frames.triVerts);

  const triFeatureIdsBuffer = frames.triFeatureIds ?? new ArrayBuffer(0);
  assertModelBinaryFrame(header, 'triFeatureIds', triFeatureIdsBuffer);

  return {
    ...(header.description !== undefined ? { description: header.description } : {}),
    numProp: header.numProp,
    triangles: header.triangles,
    vertices: header.vertices,
    vertProperties: new Float32Array(frames.vertProperties),
    triVerts: new Uint32Array(frames.triVerts),
    triFeatureIds: new Uint32Array(triFeatureIdsBuffer),
    features: header.features,
    volume: header.volume,
    surfaceArea: header.surfaceArea,
    genus: header.genus,
    bboxMin: header.bboxMin,
    bboxMax: header.bboxMax,
  };
}

/** Validate a server-side frame without copying its geometry buffers. */
export function assertViewerModelFrame(frame: ViewerModelFrame): void {
  const header = parseModelHeader(createModelHeader(frame), { allowLegacy: false });
  assertModelBinaryFrame(header, 'vertProperties', frame.vertProperties);
  assertModelBinaryFrame(header, 'triVerts', frame.triVerts);
  assertModelBinaryFrame(header, 'triFeatureIds', frame.triFeatureIds);
}

function parseProtocolVersion(
  record: Record<string, unknown>,
  { allowLegacy = true }: ProtocolGuardOptions,
): ViewerProtocolVersion | undefined {
  if (record.protocolVersion === undefined) {
    if (allowLegacy) {
      return undefined;
    }
    throw new ViewerProtocolError('protocolVersion is required.');
  }
  if (record.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
    throw new ViewerProtocolError(
      `Unsupported viewer protocolVersion ${String(record.protocolVersion)}; expected ${VIEWER_PROTOCOL_VERSION}.`,
    );
  }
  return VIEWER_PROTOCOL_VERSION;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ViewerProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ViewerProtocolError(`Model header ${label} must be a string when present.`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ViewerProtocolError(`${label} must be a non-empty string.`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string, maxLength: number): string {
  const text = nonemptyString(value, label);
  if (text.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new ViewerProtocolError(`${label} must be a safe identifier no longer than ${maxLength} characters.`);
  }
  return text;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonnegativeFiniteNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value) || value < 0) {
    throw new ViewerProtocolError(`Model header ${label} must be a finite nonnegative number.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ViewerProtocolError(`Model header ${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function numberTuple3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    throw new ViewerProtocolError(`Model header ${label} must be a tuple of three finite numbers.`);
  }
  return [value[0]!, value[1]!, value[2]!];
}

function isFeatureKind(value: unknown): value is FeatureKind {
  return (
    value === 'cube' ||
    value === 'sphere' ||
    value === 'cylinder' ||
    value === 'tetrahedron' ||
    value === 'extrude' ||
    value === 'revolve' ||
    value === 'unknown'
  );
}

function isViewerFeatureParams(value: unknown): value is ViewerFeatureParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(param => {
    if (typeof param === 'boolean' || isFiniteNumber(param)) {
      return true;
    }
    return Array.isArray(param) && param.every(isFiniteNumber);
  });
}

function ensureSafeProduct(left: number, right: number, label: string): void {
  if (!Number.isSafeInteger(left * right)) {
    throw new ViewerProtocolError(`Model header ${label} exceeds the safe integer range.`);
  }
}

function safeByteLength(items: number, valuesPerItem: number, label: string): number {
  const values = items * valuesPerItem;
  const bytes = values * 4;
  if (!Number.isSafeInteger(values) || !Number.isSafeInteger(bytes)) {
    throw new ViewerProtocolError(`Declared ${label} byte length exceeds the safe integer range.`);
  }
  return bytes;
}
