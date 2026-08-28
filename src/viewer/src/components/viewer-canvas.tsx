import { useEffect, useRef } from 'react';

import { installMarks } from '@/marks';
import type { MarksHandle } from '@/marks';
import { installAnnotationsUplink } from '@/marks/ws-uplink';
import { Viewer, type RenderMode, type ViewerTheme } from '@/scene/viewer';
import { viewerStore, type MarkMode } from '@/store';
import { connectMeshFeed, type MeshFeedHandle } from '@/transport/ws-client';
import type { PreviewPayload } from '@/types';
import { watchImmersiveVrSupport, xrErrorMessage } from '@/xr/support';

export function ViewerCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) {
      throw new Error('ViewerCanvas mounted without canvas/overlay refs');
    }

    let marksRuntime: MarksHandle | null = null;
    let mounted = true;
    const viewer = new Viewer(canvas, {
      onXrSessionStateChange(active) {
        if (!mounted) {
          return;
        }
        marksRuntime?.setXrPresenting(active);
        viewerStore.setXrSessionState(active ? 'active' : 'idle');
        if (active) {
          viewerStore.setXrError(null);
        }
      },
    });
    let lastPayload: PreviewPayload | null = null;

    const marks = installMarks({
      scene: viewer.scene,
      camera: viewer.camera,
      controls: viewer.controls,
      canvas,
      overlayHost: overlay,
      getMesh: () => viewer.getMesh(),
      requestRender: () => viewer.requestRender(),
      onModeChange: mode => viewerStore.setMarkMode(mode),
    });
    marksRuntime = marks;
    const removeMarksFrameHook = viewer.addPerFrameHook(() => marks.frame());

    viewerStore.setXrSupport('checking');
    viewerStore.setXrSessionState('idle');
    viewerStore.setXrError(null);
    const stopWatchingXrSupport = watchImmersiveVrSupport({
      onSupportChange(supported) {
        if (mounted) {
          viewerStore.setXrSupport(supported ? 'supported' : 'unsupported');
          viewerStore.setXrError(null);
        }
      },
      onError(error) {
        if (mounted) {
          viewerStore.setXrSupport('unsupported');
          viewerStore.setXrError(xrErrorMessage(error));
        }
      },
    });

    let feedHandle: MeshFeedHandle | null = null;
    const uplink = installAnnotationsUplink(marks.store, {
      send(msg) {
        feedHandle?.send(msg);
      },
      isOpen() {
        return feedHandle?.isOpen() ?? false;
      },
    });

    feedHandle = connectMeshFeed({
      onMesh: payload => {
        lastPayload = payload;
        viewerStore.setPayload(payload);
        viewer.setMesh(payload);
        marks.setPayload(payload);
      },
      onModelVersion: version => {
        viewerStore.setModelVersion(version);
        marks.setModelVersion(version);
      },
      onOpen: () => uplink.flushNow(),
      onStatusChange: status => viewerStore.setStatus(status),
    });

    // Dev-only offline preview. `npm run dev:viewer` runs Vite with
    // --mode demo, which sets import.meta.env.MODE to 'demo'. In every
    // other mode (development / production) this branch constant-folds
    // to false, so the demo module is tree-shaken out of real builds.
    // If no live mesh arrives shortly after mount, inject the built-in
    // bracket so the whole UI stays explorable without an MCP server.
    let demoTimer: number | undefined;
    if (import.meta.env.MODE === 'demo') {
      demoTimer = window.setTimeout(() => {
        if (lastPayload) {
          return;
        }
        void import('@/demo-payload').then(({ buildDemoPayload }) => {
          if (lastPayload) {
            return;
          }
          const demo = buildDemoPayload();
          lastPayload = demo;
          viewerStore.setStatus('connected');
          viewerStore.setPayload(demo);
          viewer.setMesh(demo);
          marks.setPayload(demo);
          marks.setModelVersion('demo');
          viewerStore.setModelVersion('demo');
        });
      }, 600);
    }

    viewerStore.setMarksRuntime({ store: marks.store, flyouts: marks.flyouts });
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
      async enterVr(): Promise<void> {
        if (viewerStore.getState().xrSessionState !== 'idle') {
          return;
        }
        viewerStore.setXrSessionState('starting');
        viewerStore.setXrError(null);
        // Cancel any in-flight desktop mark gesture before XrRuntime
        // snapshots OrbitControls.enabled for session restoration.
        marks.setXrPresenting(true);
        try {
          await viewer.enterVr();
        } catch (error) {
          if (mounted) {
            marks.setXrPresenting(false);
            viewerStore.setXrSessionState('idle');
            viewerStore.setXrError(xrErrorMessage(error));
          }
        }
      },
      // Exporters are dynamically imported on first use (~85 KB min).
      async export3mf(): Promise<void> {
        if (!lastPayload) {
          return;
        }
        const { export3mf } = await import('@/exporters/three-mf');
        download(export3mf(lastPayload), filename(lastPayload, '3mf'));
      },
      async exportStl(): Promise<void> {
        const mesh = viewer.getMesh();
        if (!mesh) {
          return;
        }
        const { exportStl } = await import('@/exporters/stl');
        download(exportStl(mesh), filename(lastPayload, 'stl'));
      },
    });

    return () => {
      mounted = false;
      stopWatchingXrSupport();
      if (demoTimer !== undefined) {
        window.clearTimeout(demoTimer);
      }
      viewerStore.setViewerApi(null);
      viewerStore.setMarksRuntime(null);
      feedHandle?.close();
      uplink.dispose();
      removeMarksFrameHook();
      marks.dispose();
      void viewer.dispose().catch(error => {
        console.error('Failed to dispose the 3D viewer cleanly.', error);
      });
      viewerStore.setPayload(null);
      viewerStore.setMarkMode('orbit');
      viewerStore.setStatus('disconnected');
      viewerStore.setXrSupport('checking');
      viewerStore.setXrSessionState('idle');
      viewerStore.setXrError(null);
    };
  }, []);

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

function filename(payload: PreviewPayload | null, ext: string): string {
  const slug =
    (payload?.description || 'model')
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
