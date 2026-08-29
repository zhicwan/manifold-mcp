import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ViewerSceneRuntime } from '@/scene/runtime';
import { createViewerSceneCleanupRegistry, type ViewerSceneCleanupRegistry } from '@/viewer-runtime-lifecycle';

type ContributionDisposer = () => void | Promise<void>;

export interface ViewerRuntime {
  readonly scene: ViewerSceneRuntime;
  setMarksImmersivePresenting(presenting: boolean): void;
  /**
   * Register browser-local scene cleanup that must finish before the Viewer
   * releases controls, scene objects, or its WebGL renderer.
   */
  registerSceneCleanup(dispose: ContributionDisposer): () => Promise<void>;
}

interface RuntimeSeed {
  readonly scene: ViewerSceneRuntime;
  setMarksImmersivePresenting(presenting: boolean): void;
}

export interface ViewerRuntimeHost {
  publishRuntime(seed: RuntimeSeed): ViewerRuntime;
  clearRuntime(runtime: ViewerRuntime): Promise<void>;
}

const ViewerRuntimeContext = createContext<ViewerRuntime | null>(null);
const ViewerRuntimeHostContext = createContext<ViewerRuntimeHost | null>(null);

export function ViewerRuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<ViewerRuntime | null>(null);
  const currentRef = useRef<ViewerRuntime | null>(null);
  const cleanupRegistriesRef = useRef(new WeakMap<ViewerRuntime, ViewerSceneCleanupRegistry>());

  const publishRuntime = useCallback((seed: RuntimeSeed): ViewerRuntime => {
    const cleanupRegistry = createViewerSceneCleanupRegistry();
    const next: ViewerRuntime = {
      ...seed,
      registerSceneCleanup: cleanupRegistry.register,
    };
    cleanupRegistriesRef.current.set(next, cleanupRegistry);
    currentRef.current = next;
    setRuntime(next);
    return next;
  }, []);

  const clearRuntime = useCallback(async (target: ViewerRuntime): Promise<void> => {
    if (currentRef.current === target) {
      currentRef.current = null;
      setRuntime(null);
    }
    const cleanupRegistry = cleanupRegistriesRef.current.get(target);
    if (!cleanupRegistry) {
      throw new Error('Viewer runtime cleanup registry is missing.');
    }
    cleanupRegistriesRef.current.delete(target);
    await cleanupRegistry.disposeAll();
  }, []);

  const host = useMemo<ViewerRuntimeHost>(() => ({ publishRuntime, clearRuntime }), [clearRuntime, publishRuntime]);

  return (
    <ViewerRuntimeHostContext.Provider value={host}>
      <ViewerRuntimeContext.Provider value={runtime}>{children}</ViewerRuntimeContext.Provider>
    </ViewerRuntimeHostContext.Provider>
  );
}

/** Returns the ready Viewer runtime, or null until ViewerCanvas has mounted. */
export function useViewerRuntime(): ViewerRuntime | null {
  return useContext(ViewerRuntimeContext);
}

export function useViewerRuntimeHost(): ViewerRuntimeHost {
  const host = useContext(ViewerRuntimeHostContext);
  if (!host) {
    throw new Error('ViewerCanvas must be rendered inside ViewerRuntimeProvider.');
  }
  return host;
}
