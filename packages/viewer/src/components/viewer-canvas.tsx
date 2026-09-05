import { useEffect, useRef } from 'react';

import { HostActionsClient, LOCATION_SELECTION_ACTION_ID } from '@/host-actions/client';
import { installMarks } from '@/marks';
import type { MarkMode } from '@/marks/types';
import { installAnnotationsUplink } from '@/marks/ws-uplink';
import { acquireViewerCanvasOwnership, type ViewerCanvasOwnership } from '@/scene/viewer-canvas-ownership';
import { Viewer, type RenderMode, type ViewerTheme } from '@/scene/viewer';
import { useViewerStore, type ViewerStore } from '@/store';
import { connectMeshFeed, validateResumeIdentity, type MeshFeedHandle } from '@/transport/ws-client';
import { createViewerGenerationDisposer } from '@/viewer-runtime-lifecycle';
import { useViewerRuntimeHost, type ViewerRuntimeHost } from '@/viewer-runtime';
import type { ViewerModel } from '@manifold3d/protocol/wire/model.js';

interface ViewerGeneration {
  readonly viewer: Viewer;
  dispose(): Promise<void>;
}

export function ViewerCanvas({ resumeIdentity }: { resumeIdentity: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const runtimeHost = useViewerRuntimeHost();
  const viewerStore = useViewerStore();

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) {
      throw new Error('ViewerCanvas mounted without canvas/overlay refs');
    }

    const acquisition = acquireViewerCanvasOwnership(canvas);
    let cancelled = false;
    let ownership: ViewerCanvasOwnership | null = null;
    let generation: ViewerGeneration | null = null;
    const startup = acquisition.acquired
      .then(async acquired => {
        if (!acquired) {
          return;
        }
        if (cancelled) {
          acquired.release();
          return;
        }
        ownership = acquired;
        generation = await startViewerGeneration(canvas, overlay, resumeIdentity, runtimeHost, viewerStore);
      })
      .catch(error => {
        ownership?.release();
        ownership = null;
        console.error('Failed to start the 3D viewer generation.', error);
      });
    let cleanupPromise: Promise<void> | null = null;

    return () => {
      cancelled = true;
      acquisition.cancel();
      generation?.viewer.stop();
      cleanupPromise ??= startup.then(async () => {
        const activeOwnership = ownership;
        if (!activeOwnership) {
          return;
        }
        await activeOwnership.releaseAfter(async () => {
          await generation?.dispose();
        });
        ownership = null;
      });
      void cleanupPromise.catch(error => {
        console.error('Failed to dispose the 3D viewer generation cleanly.', error);
      });
    };
  }, [resumeIdentity, runtimeHost, viewerStore]);

  return (
    <>
      {/*
        The canvas is graphical content; assistive tech can't read its
        pixels. role="img" plus a descriptive label gives screen readers
        something to announce.
      */}
      <canvas id="view" ref={canvasRef} role="img" aria-label="3D model preview" />
      <div id="marks-overlay" ref={overlayRef} />
    </>
  );
}

async function startViewerGeneration(
  canvas: HTMLCanvasElement,
  overlay: HTMLDivElement,
  resumeIdentity: string,
  runtimeHost: ViewerRuntimeHost,
  viewerStore: ViewerStore,
): Promise<ViewerGeneration> {
  const stableResumeIdentity = validateResumeIdentity(resumeIdentity);
  let mounted = true;
  const viewer = new Viewer(canvas);
  viewer.setRenderMode(viewerStore.getState().renderMode);
  const partialCleanup: Array<() => void | Promise<void>> = [() => viewer.dispose()];
  try {
    const sceneRuntime = viewer.getSceneRuntime();
    let flushSavedAnnotation = (): void => undefined;
    let attachSelection = (_id: string): void => undefined;

    const marks = installMarks({
      scene: sceneRuntime.scene,
      camera: sceneRuntime.camera,
      controls: sceneRuntime.controls,
      canvas,
      overlayHost: overlay,
      getMesh: sceneRuntime.getMesh,
      requestRender: sceneRuntime.requestRender,
      onModeChange: mode => {
        if (mounted) {
          viewerStore.setMarkMode(mode);
        }
      },
      onAnnotationCommit: () => flushSavedAnnotation(),
      onSelectionCreated: id => attachSelection(id),
    });
    partialCleanup.push(() => marks.dispose());
    const removeMarksFrameHook = sceneRuntime.addAnimationFrameHook(() => marks.frame());
    partialCleanup.push(removeMarksFrameHook);
    const publishedRuntime = runtimeHost.publishRuntime({
      scene: sceneRuntime,
      setMarksImmersivePresenting: presenting => marks.setImmersivePresenting(presenting),
    });
    partialCleanup.push(() => runtimeHost.clearRuntime(publishedRuntime));

    let feedHandle: MeshFeedHandle | null = null;
    const uplink = installAnnotationsUplink(
      marks.store,
      {
        send(msg) {
          feedHandle?.send(msg);
        },
        isOpen() {
          return feedHandle?.isOpen() ?? false;
        },
      },
      {
        onError(error) {
          viewerStore.setAnnotationSyncError(`Annotation sync failed: ${error.message}`);
        },
        onSuccess() {
          viewerStore.setAnnotationSyncError(null);
        },
      },
    );
    flushSavedAnnotation = () => {
      uplink.flushNow();
    };
    partialCleanup.push(() => uplink.dispose());
    const hostActions = new HostActionsClient({
      send(message) {
        feedHandle?.send(message);
      },
      isOpen() {
        return feedHandle?.isOpen() ?? false;
      },
      flushAnnotations: () => uplink.flushNow(),
      getInvocationContext: () => ({
        modelVersion: marks.store.getModelVersion(),
        annotationRevision: marks.store.getRevision(),
      }),
    });
    attachSelection = id => {
      void hostActions
        .invokeAndWait(LOCATION_SELECTION_ACTION_ID, { annotationIds: [id] })
        .then(status => {
          if (!mounted) {
            return;
          }
          if (status.state === 'succeeded') {
            marks.store.commitSelection(id);
          } else {
            marks.store.removeSelection(id);
          }
          uplink.flushNow();
        })
        .catch(error => {
          if (!mounted) {
            return;
          }
          marks.store.removeSelection(id);
          uplink.flushNow();
          viewerStore.setAnnotationSyncError(`Location attachment failed: ${errorMessage(error)}`);
        });
    };
    partialCleanup.push(() => hostActions.dispose());
    viewerStore.setHostActionsClient(hostActions);
    partialCleanup.push(() => viewerStore.setHostActionsClient(null));

    feedHandle = connectMeshFeed({
      resumeIdentity: stableResumeIdentity,
      onMesh: payload => {
        viewerStore.setProtocolError(null);
        viewerStore.setAnnotationSyncError(null);
        viewerStore.setStatus('connected');
        viewerStore.setPayload(payload);
        viewer.setMesh(payload);
        marks.setPayload(payload);
      },
      onModelVersion: version => {
        viewerStore.setModelVersion(version);
        marks.setModelVersion(version);
        uplink.flushNow();
      },
      onHostActionsManifest: manifest => hostActions.receiveManifest(manifest),
      onHostActionStatus: status => hostActions.receiveStatus(status),
      onHello: message => {
        if (message.annotationRevision !== undefined) {
          marks.store.rebaseRevision(message.annotationRevision);
        }
        hostActions.receiveHello(message);
      },
      onError: error => {
        hostActions.setProtocolError();
        viewerStore.setProtocolError(error.message);
        viewerStore.setStatus('protocol-error');
      },
      onStatusChange: status => {
        hostActions.setConnectionStatus(status);
        if (status === 'connecting') {
          viewerStore.setProtocolError(null);
        }
        viewerStore.setStatus(status);
      },
    });
    partialCleanup.push(() => feedHandle?.close());
    partialCleanup.push(() => viewerStore.setStatus('disconnected'));

    // Dev-only offline preview. `npm run dev:viewer` runs Vite with
    // --mode demo, which sets import.meta.env.MODE to 'demo'. In every
    // other mode (development / production) this branch constant-folds
    // to false, so the demo module is tree-shaken out of real builds.
    // If no live mesh arrives shortly after mount, inject the built-in
    // bracket so the whole UI stays explorable without an MCP server.
    let demoTimer: number | undefined;
    if (import.meta.env.MODE === 'demo') {
      demoTimer = window.setTimeout(() => {
        if (!mounted || viewerStore.getState().payload) {
          return;
        }
        void import('@/demo-payload').then(({ buildDemoPayload }) => {
          if (!mounted || viewerStore.getState().payload) {
            return;
          }
          const demo = buildDemoPayload();
          viewerStore.setStatus('connected');
          viewerStore.setPayload(demo);
          viewer.setMesh(demo);
          marks.setPayload(demo);
          marks.setModelVersion('demo');
          viewerStore.setModelVersion('demo');
        });
      }, 600);
      partialCleanup.push(() => window.clearTimeout(demoTimer));
    }

    viewerStore.setMarksRuntime({
      store: marks.store,
      commitOpenDraft(): void {
        marks.commitOpenDraft();
      },
      flushAnnotations(): boolean {
        return uplink.flushNow();
      },
    });
    partialCleanup.push(() => viewerStore.setMarksRuntime(null));
    viewerStore.setViewerApi({
      setRenderMode(mode: RenderMode): void {
        viewerStore.setRenderMode(mode);
        viewer.setRenderMode(mode);
      },
      setMarkMode(mode: MarkMode): void {
        // MarkTool notifies onModeChange, which updates the store.
        marks.setMode(mode);
      },
      setTheme(theme: ViewerTheme): void {
        viewer.setTheme(theme);
      },
      zoomIn(): void {
        viewer.zoomIn();
      },
      zoomOut(): void {
        viewer.zoomOut();
      },
      // Exporters are dynamically imported on first use (~85 KB min).
      async export3mf(): Promise<void> {
        const payload = viewerStore.getState().payload;
        if (!payload) {
          return;
        }
        const { export3mf } = await import('@/exporters/three-mf');
        download(export3mf(payload), filename(payload, '3mf'));
      },
      async exportStl(): Promise<void> {
        const payload = viewerStore.getState().payload;
        if (!payload) {
          return;
        }
        const name = filename(payload, 'stl');
        const { exportStl } = await import('@/exporters/stl');
        download(exportStl(payload), name);
      },
    });
    partialCleanup.push(() => viewerStore.setViewerApi(null));

    const dispose = createViewerGenerationDisposer({
      stop(): void {
        mounted = false;
        viewer.stop();
      },
      beforeContributions: [
        () => {
          if (demoTimer !== undefined) {
            window.clearTimeout(demoTimer);
          }
        },
        () => viewerStore.setViewerApi(null),
        () => viewerStore.setMarksRuntime(null),
        () => viewerStore.setHostActionsClient(null),
        () => feedHandle?.close(),
        () => uplink.dispose(),
        () => hostActions.dispose(),
        () => viewerStore.setPayload(null),
        () => viewerStore.setMarkMode('orbit'),
        () => viewerStore.setModelVersion('unknown'),
        () => viewerStore.setStatus('disconnected'),
        () => viewerStore.setProtocolError(null),
        () => viewerStore.setAnnotationSyncError(null),
      ],
      disposeContributions: () => runtimeHost.clearRuntime(publishedRuntime),
      afterContributions: [removeMarksFrameHook, () => marks.dispose(), () => viewer.dispose()],
    });
    return {
      viewer,
      dispose,
    };
  } catch (error) {
    mounted = false;
    viewer.stop();
    const failures: unknown[] = [error];
    for (const cleanup of partialCleanup.reverse()) {
      try {
        await cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Viewer generation startup and cleanup failed.');
  }
}

function filename(payload: ViewerModel, ext: string): string {
  const slug =
    (payload.description || 'model')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'model';
  return `${slug}.${ext}`;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
