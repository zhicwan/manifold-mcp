import { useEffect, useRef, useState } from 'react';
import {
  Box,
  BoxSelect,
  Grid3X3,
  MapPin,
  MousePointer2,
  NotebookPen,
  PanelRightOpen,
  PenLine,
  Scan,
  SquareDashed,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { glass } from '@/components/glass';
import { cn } from '@/lib/utils';
import type { Annotation } from '@/marks/types';
import type { RenderMode } from '@/scene/viewer';
import { useAnnotations, useViewerState, viewerStore, type MarkMode } from '@/store';

const TOOLS: Array<{ mode: MarkMode; label: string; shortcut: string; hint: string; icon: typeof MousePointer2 }> = [
  { mode: 'orbit', label: 'Orbit', shortcut: 'V', hint: 'Rotate, pan and zoom the camera', icon: MousePointer2 },
  { mode: 'point', label: 'Point mark', shortcut: 'M', hint: 'Click the model to drop a pin', icon: MapPin },
  { mode: 'region', label: 'Region mark', shortcut: 'R', hint: 'Drag a box to mark an area', icon: BoxSelect },
];

const RENDER_OPTIONS: Array<{ value: RenderMode; label: string; icon: typeof Box }> = [
  { value: 'solid', label: 'Solid', icon: Box },
  { value: 'wireframe', label: 'Wireframe', icon: Grid3X3 },
  { value: 'edges', label: 'Edges', icon: PenLine },
  { value: 'xray', label: 'X-Ray', icon: Scan },
];

/**
 * Right-edge control column. Collapses the former left tool rail, bottom
 * render bar and right annotation drawer into one vertical rail whose
 * secondary panels (render-mode combo, marks list) slide out to the
 * left, toward the model.
 */
export function RightRail() {
  const markMode = useViewerState(s => s.markMode);
  const renderMode = useViewerState(s => s.renderMode);
  const api = useViewerState(s => s.viewerApi);
  const payload = useViewerState(s => s.payload);
  const marksRuntime = useViewerState(s => s.marksRuntime);
  const annotations = useAnnotations(marksRuntime?.store ?? null);
  const count = annotations.length;
  const enabled = api !== null && payload !== null;

  const [renderOpen, setRenderOpen] = useState(false);
  const [marksOpen, setMarksOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const openRender = (v: boolean) => {
    setRenderOpen(v);
    if (v) {
      setMarksOpen(false);
    }
  };
  const openMarks = (v: boolean) => {
    setMarksOpen(v);
    if (v) {
      setRenderOpen(false);
    }
  };

  // Keyboard shortcuts V / M / R (skipped while typing).
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setRenderOpen(false);
        setMarksOpen(false);
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const tool = TOOLS.find(t => t.shortcut.toLowerCase() === ev.key.toLowerCase());
      if (tool) {
        viewerStore.getState().viewerApi?.setMarkMode(tool.mode);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Auto-open the marks list the first time a mark is created.
  useEffect(() => {
    if (count === 1) {
      setMarksOpen(true);
    }
  }, [count]);

  // Close flyouts on outside pointer press.
  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setRenderOpen(false);
        setMarksOpen(false);
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
        {TOOLS.map(tool => {
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

        {/* Marks list toggle */}
        {marksRuntime && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={marksOpen}
                  aria-label="标注列表"
                  className={cn(railBtn(marksOpen, false), 'relative')}
                  onClick={() => openMarks(!marksOpen)}
                />
              }
            >
              <NotebookPen className="size-4" aria-hidden="true" />
              {count > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                  {count}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="left">标注 · {count}</TooltipContent>
          </Tooltip>
        )}
      </nav>

      {/* Marks list flyout (slides out to the left of the rail) */}
      {marksOpen && marksRuntime && (
        <aside
          aria-label="标注列表"
          className={cn(
            glass,
            'pointer-events-auto fixed right-20 top-1/2 z-30 flex max-h-[70vh] w-72 -translate-y-1/2 flex-col overflow-hidden rounded-2xl',
          )}
        >
          <header className="flex items-center justify-between border-b border-border/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <NotebookPen className="size-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-foreground">标注</h2>
              <span className="text-xs text-muted-foreground">{count}</span>
            </div>
            <button
              type="button"
              onClick={() => setMarksOpen(false)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              aria-label="收起标注列表"
            >
              <PanelRightOpen className="size-4" aria-hidden="true" />
            </button>
          </header>

          {count === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <MapPin className="size-6 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                使用「点标注」或「框选标注」工具在模型上添加标注,它们会出现在这里。
              </p>
            </div>
          ) : (
            <ul className="flex-1 overflow-y-auto p-2">
              {annotations.map(a => (
                <MarkRow key={a.id} annotation={a} onRemove={() => marksRuntime.store.remove(a.id)} />
              ))}
            </ul>
          )}
        </aside>
      )}
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

function MarkRow({ annotation, onRemove }: { annotation: Annotation; onRemove: () => void }) {
  const isRegion = annotation.kind === 'region';
  return (
    <li className="group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-accent/50">
      {isRegion ? (
        <SquareDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{annotation.note || annotation.partLabel}</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {isRegion ? `区域 · ${annotation.triIds.length} 三角面` : '点'} · {formatAnchor(annotation)}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="删除标注"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

function formatAnchor(a: Annotation): string {
  const p = a.anchorWorld;
  return `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`;
}
