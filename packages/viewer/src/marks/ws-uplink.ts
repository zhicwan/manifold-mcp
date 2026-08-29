import type { AnnotationStore } from './annotation-store.js';
import type { Annotation } from './types.js';
import { createAnnotationsMessage, type WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';

interface UplinkSink {
  send(message: unknown): void;
  isOpen(): boolean;
}

export interface AnnotationsUplinkOptions {
  onError?(error: Error): void;
  onSuccess?(): void;
}

/**
 * Subscribes to the annotation store and pushes a debounced JSON
 * snapshot of all annotations to the preview server over the WebSocket.
 * The server caches these and returns them to AI clients via the
 * `get_annotations` MCP tool.
 *
 * Debounce window: ~150ms - a balance between responsiveness (AI sees
 * fresh data) and avoiding a flood during rapid typing.
 *
 * Reconnect safety: when the WS is closed at flush time, we record that
 * a flush is owed and replay it as soon as `flushNow()` is invoked
 * again (typically on the next reconnect via `onOpen`). Without this
 * the server's cached annotations would silently drift out of sync
 * after a transient network blip.
 *
 * The wire format is intentionally smaller than the in-memory
 * Annotation: per-triangle indices for region selections are reduced
 * to a triCount, since AI consumers only care about the part label,
 * location, and note. Browser-local intent/state/batchId metadata is
 * deliberately not copied into WireAnnotation.
 */
export function installAnnotationsUplink(
  store: AnnotationStore,
  sink: UplinkSink,
  options: AnnotationsUplinkOptions = {},
): UplinkHandle {
  let timer: number | undefined;
  let pendingFlush = false;

  const flushNow = (): boolean => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (!sink.isOpen()) {
      pendingFlush = true;
      return false;
    }
    try {
      const items: WireAnnotation[] = store.list().map(a => toWire(a));
      sink.send(createAnnotationsMessage(store.getModelVersion(), store.getRevision(), items));
      pendingFlush = false;
      options.onSuccess?.();
      return true;
    } catch (error) {
      pendingFlush = true;
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };

  const unsubscribe = store.subscribe(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(flushNow, 150);
  });

  return {
    flushNow,
    dispose(): void {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      unsubscribe();
    },
    hasPendingFlush(): boolean {
      return pendingFlush;
    },
  };
}

export interface UplinkHandle {
  /**
   * Force a flush attempt now. If the socket is open, sends the current
   * snapshot and clears the pending-flush flag. If closed, marks a
   * flush as pending so the next call (e.g. from onOpen) will retry.
   */
  flushNow(): boolean;
  dispose(): void;
  hasPendingFlush(): boolean;
}

function toWire(a: Annotation): WireAnnotation {
  const wire: WireAnnotation = {
    id: a.id,
    modelVersion: a.modelVersion,
    kind: a.kind,
    partLabel: a.partLabel,
    note: a.note,
    worldCoord: a.worldCoord,
  };
  if (a.kind === 'region') {
    wire.triCount = a.triIds.length;
  }
  return wire;
}
