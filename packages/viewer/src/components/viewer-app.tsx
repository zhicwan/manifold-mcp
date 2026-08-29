import { useEffect } from 'react';
import { useTheme } from 'next-themes';

import { useViewerState, ViewerStoreProvider } from '@/store';
import { ViewerCanvas } from './viewer-canvas';
import { TopBar } from './top-bar';
import { RightRail } from './right-rail';
import { ModeHint } from './mode-hint';
import { EmptyState } from './empty-state';
import { HostActionStatusRegion } from './host-actions';
import { ViewerRuntimeProvider } from '@/viewer-runtime';
import type { ViewerSlots } from './viewer-slots';

export type { ViewerSlots } from './viewer-slots';

export interface ViewerAppProps {
  readonly slots?: ViewerSlots;
  /**
   * Stable sessionStorage namespace for this Viewer instance. The normal
   * one-Viewer-per-page entry uses "default".
   */
  readonly resumeIdentity?: string;
  /** Compact, manually-opened annotation UI for narrow embedded canvases. */
  readonly annotationUi?: 'standard' | 'compact';
}

/**
 * Full-screen viewer shell: the three.js canvas fills the viewport and
 * every UI element floats above it as a frosted-glass island.
 *
 * Layout map:
 *   top-right — TopBar (identity / status / theme / export / info)
 *   right     — RightRail (tools + render-mode combo + marks flyout)
 *   center    — ModeHint while a mark tool is armed; EmptyState before
 *               any model arrives
 */
export function ViewerApp({ slots = {}, resumeIdentity = 'default', annotationUi = 'standard' }: ViewerAppProps) {
  return (
    <ViewerStoreProvider>
      <ViewerRuntimeProvider>
        <ViewerShell slots={slots} resumeIdentity={resumeIdentity} annotationUi={annotationUi} />
      </ViewerRuntimeProvider>
    </ViewerStoreProvider>
  );
}

function ViewerShell({
  slots,
  resumeIdentity,
  annotationUi,
}: {
  slots: ViewerSlots;
  resumeIdentity: string;
  annotationUi: 'standard' | 'compact';
}) {
  const { resolvedTheme } = useTheme();
  const viewerApi = useViewerState(s => s.viewerApi);

  // Keep the 3D scene palette in lockstep with the UI theme.
  useEffect(() => {
    if (viewerApi && (resolvedTheme === 'light' || resolvedTheme === 'dark')) {
      viewerApi.setTheme(resolvedTheme);
    }
  }, [viewerApi, resolvedTheme]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background" data-annotation-ui={annotationUi}>
      <ViewerCanvas resumeIdentity={resumeIdentity} />
      {slots.sceneLayers}
      <EmptyState />
      <TopBar toolbarEnd={slots.toolbarEnd} />
      <RightRail autoOpenAnnotations={annotationUi === 'standard'} />
      <ModeHint />
      <HostActionStatusRegion />
      {slots.overlays}
    </main>
  );
}
