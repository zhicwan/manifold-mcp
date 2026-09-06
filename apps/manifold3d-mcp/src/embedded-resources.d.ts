declare module 'virtual:manifold-resources' {
  import type { ViewerAssetManifest } from '@manifold3d/viewer-host/viewer-host.js';

  export const applicationVersion: string;
  export const embeddedViewerAssets: ViewerAssetManifest;
  export const embeddedManifoldWasmBase64: string;
  export const embeddedTypeScriptLibBase64: string;
}
