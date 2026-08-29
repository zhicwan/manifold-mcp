import { useEffect } from 'react';
import { useTheme } from 'next-themes';

import { useViewerState, ViewerStoreProvider } from '@/store';
import { ViewerCanvas } from './viewer-canvas';
import { TopBar } from './top-bar';
import { RightRail } from './right-rail';
import { ModeHint } from './mode-hint';
import { EmptyState } from './empty-state';
import { HostActionStatusRegion } from './host-actions';
import { AnnotationBatchBar } from './annotation-batch-bar';
import { ViewerRuntimeProvider } from '@/viewer-runtime';
import type { ViewerSlots } from './viewer-slots';

export interface ViewerAppProps {
  readonly slots?: ViewerSlots;
  /**
   * Stable sessionStorage namespace for this Viewer instance. The normal
   * one-Viewer-per-page entry uses "default".
   */
  readonly resumeIdentity?: string;
}

/**
 * Full-screen viewer shell: the three.js canvas fills the viewport and
 * every UI element floats above it as a frosted-glass island.
 *
 * Layout map:
 *   top-right — TopBar (identity / status / theme / export / info)
 *   right     — RightRail (tools + render-mode combo)
 *   center    — ModeHint while a mark tool is armed; EmptyState before
 *               any model arrives
 */
export function ViewerApp({ slots = {}, resumeIdentity = 'default' }: ViewerAppProps) {
  return (
    <ViewerStoreProvider>
      <ViewerRuntimeProvider>
        <ViewerShell slots={slots} resumeIdentity={resumeIdentity} />
      </ViewerRuntimeProvider>
    </ViewerStoreProvider>
  );
}

function ViewerShell({ slots, resumeIdentity }: { slots: ViewerSlots; resumeIdentity: string }) {
  const { resolvedTheme } = useTheme();
  const viewerApi = useViewerState(s => s.viewerApi);

  // Keep the 3D scene palette in lockstep with the UI theme.
  useEffect(() => {
    if (viewerApi && (resolvedTheme === 'light' || resolvedTheme === 'dark')) {
      viewerApi.setTheme(resolvedTheme);
    }
  }, [viewerApi, resolvedTheme]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background">
      <ViewerCanvas resumeIdentity={resumeIdentity} />
      {slots.sceneLayers}
      <EmptyState />
      <TopBar toolbarEnd={slots.toolbarEnd} />
      <RightRail />
      <ModeHint />
      <AnnotationBatchBar />
      <HostActionStatusRegion />
      {slots.overlays}
    </main>
  );
}
