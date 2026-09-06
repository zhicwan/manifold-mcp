import { describe, expect, it } from 'vitest';

import {
  VIEWER_PROTOCOL_VERSION,
  createHelloMessage,
  createModelHeader,
  createModelVersionMessage,
  createResumeTokenAckMessage,
  decodeViewerModel,
  isHelloMessage,
  isModelHeader,
  isModelVersionMessage,
  isResumeTokenAckMessage,
  parseModelHeader,
  type ViewerModelFrame,
} from '../packages/protocol/src/wire/model.js';

function modelFrame(): ViewerModelFrame {
  return {
    description: 'protocol triangle',
    numProp: 3,
    triangles: 1,
    vertices: 3,
    vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
    triVerts: new Uint32Array([0, 1, 2]).buffer,
    triFeatureIds: new Uint32Array([0]).buffer,
    features: [
      {
        label: 'triangle#1',
        kind: 'unknown',
        params: { selected: true, scale: [1, 2, 3] },
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      },
    ],
    volume: 0,
    surfaceArea: 0.5,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [1, 1, 0],
  };
}

describe('viewer model protocol', () => {
  it('round-trips a valid model header and binary frames without copying buffers', () => {
    const frame = modelFrame();
    const header = parseModelHeader(createModelHeader(frame));
    const model = decodeViewerModel(header, frame);

    expect(header.protocolVersion).toBe(VIEWER_PROTOCOL_VERSION);
    expect(model.vertProperties.buffer).toBe(frame.vertProperties);
    expect(model.triVerts.buffer).toBe(frame.triVerts);
    expect(model.triFeatureIds.buffer).toBe(frame.triFeatureIds);
    expect([...model.triVerts]).toEqual([0, 1, 2]);
    expect(model.features).toEqual(frame.features);
  });

  it('requires the current protocol version and complete metadata', () => {
    const current = createModelHeader(modelFrame());
    const { protocolVersion: _ignored, ...unversioned } = current;
    const { features: _features, ...missingFeatures } = current;

    expect(() => parseModelHeader(unversioned)).toThrow(/protocolVersion is required/);
    expect(() => parseModelHeader(missingFeatures)).toThrow(/features must be an array/);
  });

  it('rejects unsupported, incomplete, and malformed metadata', () => {
    const header = createModelHeader(modelFrame());

    expect(isModelHeader({ ...header, protocolVersion: 2 })).toBe(false);
    expect(() => parseModelHeader({ ...header, protocolVersion: 2 })).toThrow(/Unsupported viewer protocolVersion/);
    expect(isModelHeader({ kind: 'mesh' })).toBe(false);
    expect(isModelHeader({ ...header, volume: Number.NaN })).toBe(false);
    expect(isModelHeader({ ...header, bboxMax: [1, 1] })).toBe(false);
    expect(isModelHeader({ ...header, hasTriFeatureIds: 1 })).toBe(false);
    expect(isModelHeader({ ...header, extra: true })).toBe(false);
    expect(
      isModelHeader({
        ...header,
        features: [{ ...header.features[0], transform: [1, 0, 0] }],
      }),
    ).toBe(false);
  });

  it('rejects misaligned and declared-length-mismatched binary frames', () => {
    const frame = modelFrame();
    const header = parseModelHeader(createModelHeader(frame));

    expect(() => decodeViewerModel(header, { ...frame, vertProperties: new ArrayBuffer(5) })).toThrow(
      /not 4-byte aligned/,
    );
    expect(() => decodeViewerModel(header, { ...frame, triVerts: new Uint32Array([0, 1]).buffer })).toThrow(
      /does not match the declared/,
    );
    expect(() => decodeViewerModel(header, { ...frame, triFeatureIds: new ArrayBuffer(0) })).toThrow(
      /does not match the declared/,
    );
  });

  it('guards hello and model-version messages including protocol versions', () => {
    expect(isHelloMessage(createHelloMessage('client-1', 'initial-token', false))).toBe(true);
    expect(createHelloMessage('client-1', 'resume-token', true)).toMatchObject({
      clientId: 'client-1',
      resumeToken: 'resume-token',
      resumed: true,
    });
    expect(isModelVersionMessage(createModelVersionMessage('v1'))).toBe(true);
    expect(isHelloMessage({ kind: 'hello', clientId: 'unversioned-client' })).toBe(false);
    expect(isModelVersionMessage({ kind: 'model_version', modelVersion: 'unversioned-v1' })).toBe(false);
    expect(isHelloMessage({ kind: 'hello', protocolVersion: 99, clientId: 'client-1' })).toBe(false);
    expect(
      isHelloMessage({
        kind: 'hello',
        protocolVersion: 1,
        clientId: 'client-1',
        resumeToken: 'valid-token',
      }),
    ).toBe(false);
    expect(
      isHelloMessage({
        kind: 'hello',
        protocolVersion: 1,
        clientId: 'client-1',
        annotationRevision: 3,
      }),
    ).toBe(false);
    expect(isHelloMessage({ ...createHelloMessage('client-1', 'resume-token', false), extra: true })).toBe(false);
    expect(isModelVersionMessage({ kind: 'model_version', protocolVersion: 1, modelVersion: '' })).toBe(false);
  });

  it('strictly guards versioned resume-token acknowledgements', () => {
    expect(isResumeTokenAckMessage(createResumeTokenAckMessage('resume-token'))).toBe(true);
    expect(
      isResumeTokenAckMessage({
        kind: 'resume_token_ack',
        protocolVersion: VIEWER_PROTOCOL_VERSION,
        resumeToken: 'resume-token',
        clientId: 'untrusted',
      }),
    ).toBe(false);
    expect(
      isResumeTokenAckMessage({
        kind: 'resume_token_ack',
        protocolVersion: 99,
        resumeToken: 'resume-token',
      }),
    ).toBe(false);
  });
});
