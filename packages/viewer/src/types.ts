/**
 * Viewer-local compatibility aliases. The wire/browser model contract lives
 * in @manifold3d/protocol so the browser and Node host share one definition.
 */
export type {
  ViewerFeature,
  ViewerFeature as PreviewFeature,
  ViewerModel,
  ViewerModel as PreviewPayload,
} from '@manifold3d/protocol/wire/model.js';
