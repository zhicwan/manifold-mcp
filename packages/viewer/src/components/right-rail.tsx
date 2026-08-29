import { useEffect, useRef, useState } from 'react';
import { Box, Grid3X3, MapPin, MousePointer2, PenLine, Scan, Send, ZoomIn, ZoomOut } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHostActionsSnapshot } from '@/components/host-actions';
import { glass } from '@/components/glass';
import { cn } from '@/lib/utils';
import type { RenderMode } from '@/scene/viewer';
import { useViewerState, useViewerStore, type MarkMode } from '@/store';

const TOOLS: Array<{ mode: MarkMode; label: string; shortcut: string; hint: string; icon: typeof MousePointer2 }> = [
  { mode: 'orbit', label: 'Orbit', shortcut: 'V', hint: 'Rotate, pan and zoom the camera', icon: MousePointer2 },
  {
    mode: 'annotate',
    label: 'Annotate',
    shortcut: 'M',
    hint: 'Click for a point or drag for a commented region',
    icon: MapPin,
  },
  {
    mode: 'select',
    label: 'Select to chat',
    shortcut: 'S',
    hint: 'Click or drag to attach a location without a comment',
    icon: Send,
  },
];

const RENDER_OPTIONS: Array<{ value: RenderMode; label: string; icon: typeof Box }> = [
  { value: 'solid', label: 'Solid', icon: Box },
  { value: 'wireframe', label: 'Wireframe', icon: Grid3X3 },
  { value: 'edges', label: 'Edges', icon: PenLine },
  { value: 'xray', label: 'X-Ray', icon: Scan },
];

/**
 * Right-edge control column. Annotation editing remains on the model; hosts
 * contribute transactional actions through the bottom batch bar.
 */
export function RightRail() {
  const viewerStore = useViewerStore();
  const markMode = useViewerState(s => s.markMode);
  const renderMode = useViewerState(s => s.renderMode);
  const api = useViewerState(s => s.viewerApi);
  const payload = useViewerState(s => s.payload);
  const hostActions = useHostActionsSnapshot();
  const supportsSelect = hostActions.actions.some(action => action.id === 'attach-location-selection');
  const enabled = api !== null && payload !== null;

  const [renderOpen, setRenderOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const openRender = (v: boolean) => {
    setRenderOpen(v);
  };

  // Keyboard shortcuts V / M / S (skipped while typing).
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setRenderOpen(false);
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const tool = TOOLS.find(
        t => (t.mode !== 'select' || supportsSelect) && t.shortcut.toLowerCase() === ev.key.toLowerCase(),
      );
      if (tool) {
        viewerStore.getState().viewerApi?.setMarkMode(tool.mode);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [supportsSelect, viewerStore]);

  useEffect(() => {
    if (markMode === 'select' && !supportsSelect) {
      api?.setMarkMode('orbit');
    }
  }, [api, markMode, supportsSelect]);

  // Close flyouts on outside pointer press.
  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setRenderOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const ActiveRenderIcon = RENDER_OPTIONS.find(o => o.value === renderMode)?.icon ?? Box;

  return (
    <div ref={rootRef} className="contents">
      <nav
        aria-label="Viewer tools"
        className={cn(glass, 'fixed right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 p-1.5')}
      >
        {/* Interaction tools */}
        {TOOLS.filter(tool => tool.mode !== 'select' || supportsSelect).map(tool => {
          const Icon = tool.icon;
          const active = markMode === tool.mode;
          return (
            <Tooltip key={tool.mode}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${tool.label} (${tool.shortcut})`}
                    aria-pressed={active}
                    disabled={!enabled}
                    className={railBtn(active, !enabled)}
                    onClick={() => api?.setMarkMode(tool.mode)}
                  />
                }
              >
                <Icon className="size-4" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="left">
                <span className="flex items-center gap-2">
                  {tool.label}
                  <kbd className="rounded bg-background/20 px-1 font-mono text-[10px]">{tool.shortcut}</kbd>
                </span>
                <span className="block text-[11px] opacity-80">{tool.hint}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}

        <div className="mx-1 my-0.5 h-px bg-border/60" aria-hidden="true" />

        {/* Controller-friendly zoom controls for flat browser mode. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Zoom in"
                disabled={!enabled}
                className={railBtn(false, !enabled)}
                onClick={() => api?.zoomIn()}
              />
            }
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="left">Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Zoom out"
                disabled={!enabled}
                className={railBtn(false, !enabled)}
                onClick={() => api?.zoomOut()}
              />
            }
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="left">Zoom out</TooltipContent>
        </Tooltip>

        <div className="mx-1 my-0.5 h-px bg-border/60" aria-hidden="true" />

        {/* Render-mode combo */}
        <div className="relative">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={renderOpen}
                  aria-label="Render mode"
                  disabled={!enabled}
                  className={railBtn(renderOpen, !enabled)}
                  onClick={() => openRender(!renderOpen)}
                />
              }
            >
              <ActiveRenderIcon className="size-4" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent side="left">Render mode</TooltipContent>
          </Tooltip>

          {renderOpen && (
            <div
              role="radiogroup"
              aria-label="Render mode"
              className={cn(glass, 'absolute right-full top-1/2 mr-2 flex w-40 -translate-y-1/2 flex-col gap-0.5 p-1')}
            >
              {RENDER_OPTIONS.map(opt => {
                const Icon = opt.icon;
                const active = renderMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    onClick={() => {
                      api?.setRenderMode(opt.value);
                      setRenderOpen(false);
                    }}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </nav>
    </div>
  );
}

function railBtn(active: boolean, disabled: boolean): string {
  return cn(
    'flex size-9 items-center justify-center rounded-xl transition-colors',
    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    disabled && 'pointer-events-none opacity-40',
  );
}
