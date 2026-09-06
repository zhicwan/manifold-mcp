import {
  assertViewerModelFrame,
  isViewerFeature,
  type ViewerFeature,
  type ViewerFeatureParam,
  type ViewerModelFrame,
} from '@manifold3d/protocol/wire/model.js';

import type { ModelArtifact } from './protocol.js';

/**
 * Project a full modeling artifact onto the browser/Node viewer boundary.
 *
 * Large geometry buffers are deliberately shared, not copied. Small feature
 * records are rebuilt so worker-private or accidental extra properties cannot
 * cross the viewer protocol boundary.
 */
export function toViewerModelFrame(artifact: ModelArtifact): ViewerModelFrame {
  const frame: ViewerModelFrame = {
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    numProp: artifact.numProp,
    triangles: artifact.triangles,
    vertices: artifact.vertices,
    vertProperties: artifact.vertProperties,
    triVerts: artifact.triVerts,
    triFeatureIds: artifact.triFeatureIds,
    features: artifact.features.map(sanitizeFeature),
    volume: artifact.volume,
    surfaceArea: artifact.surfaceArea,
    genus: artifact.genus,
    bboxMin: [...artifact.bboxMin],
    bboxMax: [...artifact.bboxMax],
  };
  assertViewerModelFrame(frame);
  return frame;
}

function sanitizeFeature(feature: ViewerFeature): ViewerFeature {
  const params: Record<string, ViewerFeatureParam> = {};
  for (const [name, value] of Object.entries(feature.params as Record<string, ViewerFeatureParam | undefined>)) {
    if (value !== undefined) {
      params[name] = Array.isArray(value) ? [...value] : value;
    }
  }
  const sanitized: ViewerFeature = {
    label: feature.label,
    kind: feature.kind,
    params,
    transform: [...feature.transform],
  };
  if (!isViewerFeature(sanitized)) {
    throw new TypeError(`Invalid viewer feature "${feature.label}".`);
  }
  return sanitized;
}
