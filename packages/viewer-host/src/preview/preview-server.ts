import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import type { ViewerModelFrame } from '@manifold3d/protocol/wire/model.js';

import {
  _testCacheControlFor,
  startViewerHost,
  type HostActionHandler,
  type ViewerAnnotationSnapshot,
  type ViewerHost,
  type ViewerRoom,
} from '../viewer-host.js';
import type { HostActionDescriptor } from '@manifold3d/protocol/wire/host-actions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSET_ROOT = join(HERE, '..', 'public');

export interface PreviewServerHandle {
  url: string;
  port: number;
  /** The authenticated default room owned by this compatibility wrapper. */
  room: ViewerRoom;
  push(model: ViewerModelFrame): void;
  pushModel(model: ViewerModelFrame): void;
  getLastModel(): ViewerModelFrame | undefined;
  /** @deprecated Use getLastModel(). */
  getLastMesh(): ViewerModelFrame | undefined;
  getAnnotations(): ViewerAnnotationSnapshot & { items: WireAnnotation[] };
  registerAction(descriptor: HostActionDescriptor, handler: HostActionHandler): () => void;
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
    port: viewerHost.port,
    room,
    push(model): void {
      room.pushModel(model);
    },
    pushModel(model): void {
      room.pushModel(model);
    },
    getLastModel(): ViewerModelFrame | undefined {
      return room.getLastModel();
    },
    getLastMesh(): ViewerModelFrame | undefined {
      return room.getLastModel();
    },
    getAnnotations(): ViewerAnnotationSnapshot & { items: WireAnnotation[] } {
      return room.getAnnotations();
    },
    registerAction(descriptor, handler): () => void {
      return room.registerAction(descriptor, handler);
    },
    close(): Promise<void> {
      return viewerHost.close();
    },
  };
}

export { _testCacheControlFor };
