import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ViewerModelFrame } from '@manifold3d/protocol/wire/model.js';

import { startViewerHost, type ViewerAnnotationSnapshot, type ViewerHost } from '../viewer-host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSET_ROOT = join(HERE, '..', 'public');

export interface PreviewServerHandle {
  url: string;
  pushModel(model: ViewerModelFrame): void;
  getAnnotations(): ViewerAnnotationSnapshot;
  close(): Promise<void>;
}

export async function startPreviewServer(preferredPort = 3737, host = '127.0.0.1'): Promise<PreviewServerHandle> {
  const viewerHost: ViewerHost = await startViewerHost({
    preferredPort,
    host,
    assetRoot: DEFAULT_ASSET_ROOT,
    ...(process.env.NODE_ENV === 'development'
      ? { additionalOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'] }
      : {}),
  });
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
