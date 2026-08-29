import { createContext, createElement, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';

import type { HostActionsClient } from './host-actions/client.js';
import type { AnnotationStore } from './marks/annotation-store.js';
import type { FlyoutLayer } from './marks/flyout.js';
import type { Annotation } from './marks/types.js';
import type { RenderMode } from './scene/viewer.js';
import type { ConnectionStatus } from './transport/ws-client.js';
import type { PreviewPayload } from './types.js';

/**
 * Tiny instance-scoped external store. Imperative subsystems write to the
 * nearest ViewerApp store, while React subscribes via useSyncExternalStore.
 */
export interface MarksRuntime {
  store: AnnotationStore;
  flyouts: FlyoutLayer;
  removeAnnotation(id: string): void;
}

/**
 * Interaction mode for the left tool rail. 'orbit' is the default
 * camera mode (marks still reachable via Ctrl gestures); 'point' and
 * 'region' arm the corresponding annotation gesture on plain left
 * click / drag.
 */
export type MarkMode = 'orbit' | 'point' | 'region';

export interface ViewerApi {
  setRenderMode(mode: RenderMode): void;
  setMarkMode(mode: MarkMode): void;
  /** Sync the three.js scene palette with the UI theme. */
  setTheme(theme: 'light' | 'dark'): void;
  /** Move the desktop perspective camera closer to the orbit target. */
  zoomIn(): void;
  /** Move the desktop perspective camera farther from the orbit target. */
  zoomOut(): void;
  // VIE-4: exporters are dynamically imported on first use. The handlers
  // resolve when the module download AND the export step both complete;
  // callers can ignore the returned promise (fire-and-forget click).
  export3mf(): Promise<void>;
  exportStl(): Promise<void>;
}

export interface ViewerState {
  payload: PreviewPayload | null;
  status: ConnectionStatus;
  renderMode: RenderMode;
  modelVersion: string;
  /**
   * Owned by ViewerCanvas — swapped in once installMarks() has wired up
   * the annotation subsystem. ControlPanel and MarksSidebar read it via
   * useViewerState rather than receiving it as a prop, so an early-mount
   * sidebar doesn't see a stale `null` reference (VIE-6).
   */
  marksRuntime: MarksRuntime | null;
  /** Same lifecycle as marksRuntime. Bound by ViewerCanvas. */
  viewerApi: ViewerApi | null;
  /** Active interaction tool (left tool rail). */
  markMode: MarkMode;
  /** Malformed or unsupported Viewer Host protocol error. */
  protocolError: string | null;
  /** Recoverable annotation snapshot serialization/transport error. */
  annotationSyncError: string | null;
  /** Room-scoped generic host action state/dispatch, owned by ViewerCanvas. */
  hostActionsClient: HostActionsClient | null;
}

const INITIAL: ViewerState = {
  payload: null,
  status: 'connecting',
  renderMode: 'solid',
  modelVersion: 'unknown',
  marksRuntime: null,
  viewerApi: null,
  markMode: 'orbit',
  protocolError: null,
  annotationSyncError: null,
  hostActionsClient: null,
};

type Listener = () => void;

export function createViewerStore() {
  let state: ViewerState = INITIAL;
  const listeners = new Set<Listener>();

  const emit = (): void => {
    for (const fn of listeners) {
      fn();
    }
  };

  return {
    getState(): ViewerState {
      return state;
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setPayload(payload: PreviewPayload | null): void {
      if (state.payload === payload) {
        return;
      }
      state = { ...state, payload };
      emit();
    },
    setStatus(status: ConnectionStatus): void {
      if (state.status === status) {
        return;
      }
      state = { ...state, status };
      emit();
    },
    setRenderMode(renderMode: RenderMode): void {
      if (state.renderMode === renderMode) {
        return;
      }
      state = { ...state, renderMode };
      emit();
    },
    setModelVersion(modelVersion: string): void {
      if (state.modelVersion === modelVersion) {
        return;
      }
      state = { ...state, modelVersion };
      emit();
    },
    setMarksRuntime(marksRuntime: MarksRuntime | null): void {
      if (state.marksRuntime === marksRuntime) {
        return;
      }
      state = { ...state, marksRuntime };
      emit();
    },
    setMarkMode(markMode: MarkMode): void {
      if (state.markMode === markMode) {
        return;
      }
      state = { ...state, markMode };
      emit();
    },
    setViewerApi(viewerApi: ViewerApi | null): void {
      if (state.viewerApi === viewerApi) {
        return;
      }
      state = { ...state, viewerApi };
      emit();
    },
    setProtocolError(protocolError: string | null): void {
      if (state.protocolError === protocolError) {
        return;
      }
      state = { ...state, protocolError };
      emit();
    },
    setAnnotationSyncError(annotationSyncError: string | null): void {
      if (state.annotationSyncError === annotationSyncError) {
        return;
      }
      state = { ...state, annotationSyncError };
      emit();
    },
    setHostActionsClient(hostActionsClient: HostActionsClient | null): void {
      if (state.hostActionsClient === hostActionsClient) {
        return;
      }
      state = { ...state, hostActionsClient };
      emit();
    },
  };
}

export type ViewerStore = ReturnType<typeof createViewerStore>;

const ViewerStoreContext = createContext<ViewerStore | null>(null);

export function ViewerStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ViewerStore | null>(null);
  storeRef.current ??= createViewerStore();
  return createElement(ViewerStoreContext.Provider, { value: storeRef.current }, children);
}

export function useViewerStore(): ViewerStore {
  const store = useContext(ViewerStoreContext);
  if (!store) {
    throw new Error('Viewer state hooks must be rendered inside ViewerStoreProvider.');
  }
  return store;
}

export function useViewerState<T>(selector: (s: ViewerState) => T): T {
  const store = useViewerStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/**
 * Subscribe to the existing AnnotationStore via useSyncExternalStore.
 * The annotation store already owns its own pub/sub — we don't mirror
 * it into another store; React reads it directly.
 *
 * Note: AnnotationStore.subscribe immediately invokes the callback
 * synchronously on subscribe, which works fine for SES because the
 * snapshot is read on the next paint anyway.
 */
export function useAnnotations(store: AnnotationStore | null): readonly Annotation[] {
  const subscribe = (fn: Listener): (() => void) => {
    if (!store) {
      return () => undefined;
    }
    return store.subscribe(() => fn());
  };
  const getSnapshot = (): readonly Annotation[] => (store ? store.list() : EMPTY_ANNOTATIONS);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ANNOTATIONS);
}

const EMPTY_ANNOTATIONS: readonly Annotation[] = [];
