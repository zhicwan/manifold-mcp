import { Box, Check, Download, Info, Moon, Sun, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExportMenuHostActions, ToolbarHostActions } from '@/components/host-actions';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { glass, glassPill } from '@/components/glass';
import { cn } from '@/lib/utils';
import { useViewerState, type ViewerApi } from '@/store';
import type { PreviewPayload } from '@/types';

/**
 * Top-right control cluster: everything that identifies the model or acts
 * on it lives here. Left of the actions pill sits the identity pill
 * (name + live-connection dot); the actions pill holds theme, export and
 * a collapsible model-info card.
 */
export function TopBar({ toolbarEnd }: { toolbarEnd?: ReactNode }) {
  const payload = useViewerState(s => s.payload);
  const status = useViewerState(s => s.status);
  const modelVersion = useViewerState(s => s.modelVersion);
  const api = useViewerState(s => s.viewerApi);
  const protocolError = useViewerState(s => s.protocolError);
  const annotationSyncError = useViewerState(s => s.annotationSyncError);
  const actionsEnabled = payload !== null && api !== null;

  const isDemo = modelVersion === 'demo';
  const statusLabel = isDemo
    ? 'Demo'
    : status === 'connected'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'protocol-error'
          ? 'Protocol error'
          : 'Disconnected';

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-end gap-3 p-4">
      {/* Identity pill */}
      <div className={cn(glassPill, 'flex h-11 min-w-0 items-center gap-2.5 pl-3.5 pr-4')}>
        <Box className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-sm font-medium">{payload?.description || 'manifold3d viewer'}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex size-4 shrink-0 items-center justify-center"
                role="status"
                aria-live="polite"
                aria-label={`Status: ${statusLabel}`}
              />
            }
          >
            <span
              className={cn(
                'size-2 rounded-full',
                status === 'connected' && 'bg-teal-500',
                status === 'connecting' && 'animate-pulse bg-amber-500',
                (status === 'disconnected' || status === 'protocol-error') && 'bg-destructive',
              )}
            />
          </TooltipTrigger>
          <TooltipContent side="bottom">{statusLabel}</TooltipContent>
        </Tooltip>
      </div>

      {/* Actions pill + collapsible info card */}
      <ActionsCluster
        payload={payload}
        actionsEnabled={actionsEnabled}
        api={api}
        toolbarEnd={toolbarEnd}
        error={protocolError ?? annotationSyncError}
      />
    </header>
  );
}

function ActionsCluster({
  payload,
  actionsEnabled,
  api,
  toolbarEnd,
  error,
}: {
  payload: PreviewPayload | null;
  actionsEnabled: boolean;
  api: ViewerApi | null;
  toolbarEnd?: ReactNode;
  error: string | null;
}) {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <div className="relative">
      <div className={cn(glassPill, 'flex h-11 items-center gap-1 px-1.5')}>
        <ToolbarHostActions />
        <ThemeToggle />
        {toolbarEnd}
        <div className="h-5 w-px bg-border/70" aria-hidden="true" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="h-8 gap-1.5 rounded-full px-3" disabled={!actionsEnabled} />
            }
          >
            <Download className="size-4" aria-hidden="true" />
            Export
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onClick={() => void api?.export3mf()}>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">3MF</span>
                <span className="text-xs text-muted-foreground">
                  Preserves manifold topology — recommended for slicers
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void api?.exportStl()}>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">STL</span>
                <span className="text-xs text-muted-foreground">Widely supported, but vertices duplicate per face</span>
              </span>
            </DropdownMenuItem>
            <ExportMenuHostActions />
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="h-5 w-px bg-border/70" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-8 gap-1.5 rounded-full px-3', infoOpen && 'bg-muted text-foreground')}
                aria-expanded={infoOpen}
                aria-label={infoOpen ? 'Hide model information' : 'Show model information'}
                disabled={!payload}
                onClick={() => setInfoOpen(v => !v)}
              />
            }
          >
            <Info className="size-4" aria-hidden="true" />
            Info
          </TooltipTrigger>
          <TooltipContent side="bottom">Model information</TooltipContent>
        </Tooltip>
      </div>

      {(error || (infoOpen && payload)) && (
        <div className="pointer-events-none absolute right-0 top-full mt-2 flex w-72 flex-col items-end gap-2">
          {error && (
            <p role="alert" className={cn(glass, 'pointer-events-auto w-full px-3 py-2 text-xs text-destructive')}>
              {error}
            </p>
          )}
          {infoOpen && payload && (
            <section aria-label="Model information" className={cn(glass, 'pointer-events-auto w-64 p-4')}>
              <ModelStats payload={payload} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ModelStats({ payload }: { payload: PreviewPayload }) {
  const sx = payload.bboxMax[0] - payload.bboxMin[0];
  const sy = payload.bboxMax[1] - payload.bboxMin[1];
  const sz = payload.bboxMax[2] - payload.bboxMin[2];
  const watertight = payload.genus === 0;

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">Bounding box</dt>
      <dd className="truncate text-right font-mono tabular-nums">
        {fmt(sx)} x {fmt(sy)} x {fmt(sz)} mm
      </dd>
      <dt className="text-muted-foreground">Volume</dt>
      <dd className="text-right font-mono tabular-nums">{(payload.volume / 1000).toFixed(2)} cm3</dd>
      <dt className="text-muted-foreground">Surface area</dt>
      <dd className="text-right font-mono tabular-nums">{(payload.surfaceArea / 100).toFixed(1)} cm2</dd>
      <dt className="text-muted-foreground">Triangles</dt>
      <dd className="text-right font-mono tabular-nums">{payload.triangles.toLocaleString()}</dd>
      <dt className="text-muted-foreground">Watertight</dt>
      <dd className="flex items-center justify-end gap-1">
        {watertight ? (
          <Check className="size-3 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        ) : (
          <X className="size-3 text-destructive" aria-hidden="true" />
        )}
        {watertight ? 'Yes' : `No (genus ${payload.genus})`}
      </dd>
    </dl>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          />
        }
      >
        {isDark ? <Moon className="size-4" aria-hidden="true" /> : <Sun className="size-4" aria-hidden="true" />}
      </TooltipTrigger>
      <TooltipContent side="bottom">{isDark ? 'Light theme' : 'Dark theme'}</TooltipContent>
    </Tooltip>
  );
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return '-';
  }
  if (Math.abs(n) >= 100) {
    return n.toFixed(0);
  }
  return n.toFixed(1);
}
