import type { ViewerModelFrame } from '@manifold3d/protocol/wire/model.js';

import {
  startViewerHost,
  type ViewerAnnotationSnapshot,
  type ViewerHostOptions,
} from '@manifold3d/viewer-host/viewer-host.js';

export interface PreviewServerHandle {
  url: string;
  pushModel(model: ViewerModelFrame): void;
  getAnnotations(): ViewerAnnotationSnapshot;
  close(): Promise<void>;
}

export async function startPreviewServer(options: ViewerHostOptions): Promise<PreviewServerHandle> {
  const viewerHost = await startViewerHost(options);
  const room = viewerHost.createRoom();
  return {
    url: room.url,
    pushModel(model): void {
      room.pushModel(model);
    },
    getAnnotations(): ViewerAnnotationSnapshot {
      return room.getAnnotations();
    },
    close(): Promise<void> {
      return viewerHost.close();
    },
  };
}
