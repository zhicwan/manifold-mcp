import { MapPin, Send } from 'lucide-react';

import { glassPill } from '@/components/glass';
import { cn } from '@/lib/utils';
import { useViewerState } from '@/store';

/**
 * Floating hint shown while a marking tool is active, so the modal
 * state is never invisible: what to do, and how to get out.
 */
export function ModeHint() {
  const markMode = useViewerState(s => s.markMode);

  if (markMode === 'orbit') {
    return null;
  }

  const isAnnotate = markMode === 'annotate';
  const Icon = isAnnotate ? MapPin : Send;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(glassPill, 'fixed left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-2 px-4 py-2 text-sm')}
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <span>
        {isAnnotate ? 'Click for a point or drag for a commented region' : 'Click or drag to attach a location to chat'}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">Esc</kbd>
        to exit
      </span>
    </div>
  );
}
