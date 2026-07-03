import { useEffect } from 'react';
import { useTheme } from 'next-themes';

import { useViewerState } from '@/store';
import { ViewerCanvas } from './viewer-canvas';
import { TopBar } from './top-bar';
import { RightRail } from './right-rail';
import { ModeHint } from './mode-hint';
import { EmptyState } from './empty-state';

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
export function ViewerApp() {
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
      <ViewerCanvas />
      <EmptyState />
      <TopBar />
      <RightRail />
      <ModeHint />
    </main>
  );
}
