declare module 'virtual:manifold-resources' {
  import type { ViewerAssetManifest } from '@manifold3d/viewer-host/viewer-host.js';

  export const embeddedViewerAssets: ViewerAssetManifest;
  export const applicationVersion: string;
  export const embeddedViewerAssetCount: number;
  export const embeddedViewerAssetBytes: number;
  export const embeddedManifoldWasmBase64: string;
  export const embeddedManifoldWasmBytes: number;
  export const embeddedManifoldWasmSha256: string;
  export const embeddedTypeScriptLibBase64: string;
  export const embeddedTypeScriptLibBytes: number;
}
