import {
  Bot,
  Check,
  CircleAlert,
  Download,
  LoaderCircle,
  MessageSquare,
  Play,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { glass } from '@/components/glass';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getLatestHostActionStatus,
  hasPendingHostActionRequest,
  hostActionDisabledReason,
  type HostActionsSnapshot,
} from '@/host-actions/client';
import { cn } from '@/lib/utils';
import { useAnnotations, useViewerState } from '@/store';
import type { HostActionDescriptor, HostActionIcon, HostActionTone } from '@manifold3d/protocol/wire/host-actions.js';

const EMPTY_HOST_ACTIONS: HostActionsSnapshot = {
  actions: [],
  statuses: {},
  requestOrder: [],
  latestStatus: null,
  clientId: null,
  connected: false,
  protocolState: 'awaiting-manifest',
};

const ICONS: Record<HostActionIcon, LucideIcon> = {
  bot: Bot,
  check: Check,
  download: Download,
  message: MessageSquare,
  play: Play,
  sparkles: Sparkles,
  wand: WandSparkles,
};

export function ToolbarHostActions() {
  const view = useHostActionsView();
  const actions = view.snapshot.actions.filter(action => action.slot === 'toolbar');
  if (actions.length === 0) {
    return null;
  }
  return (
    <>
      {actions.map(action => {
        const status = getLatestHostActionStatus(view.snapshot, action.id);
        const pending = view.pending(action);
        const disabledReason = view.disabledReason(action);
        const Icon = status?.state === 'failed' ? CircleAlert : ICONS[action.icon];
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger
              render={
                <Button
                  variant={buttonVariant(action.tone)}
                  size="sm"
                  className="h-8 rounded-full px-3"
                  disabled={disabledReason !== undefined}
                  aria-label={action.label}
                  aria-busy={pending}
                  onClick={() => view.invoke(action)}
                />
              }
            >
              {pending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Icon className={cn('size-4', status?.state === 'failed' && 'text-destructive')} aria-hidden="true" />
              )}
              {action.label}
            </TooltipTrigger>
            <TooltipContent side="bottom">{disabledReason ?? status?.message ?? action.label}</TooltipContent>
          </Tooltip>
        );
      })}
      <div className="h-5 w-px bg-border/70" aria-hidden="true" />
    </>
  );
}

export function ExportMenuHostActions() {
  const view = useHostActionsView();
  const actions = view.snapshot.actions.filter(action => action.slot === 'export-menu');
  if (actions.length === 0) {
    return null;
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Viewer Host</DropdownMenuLabel>
      {actions.map(action => {
        const status = getLatestHostActionStatus(view.snapshot, action.id);
        const pending = view.pending(action);
        const disabledReason = view.disabledReason(action);
        const Icon = pending ? LoaderCircle : ICONS[action.icon];
        return (
          <DropdownMenuItem
            key={action.id}
            disabled={disabledReason !== undefined}
            title={disabledReason}
            onClick={() => view.invoke(action)}
          >
            <Icon className={cn(pending && 'animate-spin')} aria-hidden="true" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{action.label}</span>
              {(disabledReason || status?.message) && (
                <span
                  className={cn(
                    'truncate text-xs text-muted-foreground',
                    status?.state === 'failed' && 'text-destructive',
                  )}
                >
                  {disabledReason ?? status?.message}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export function HostActionStatusRegion() {
  const { snapshot } = useHostActionsView();
  const markMode = useViewerState(state => state.markMode);
  const status = snapshot.latestStatus;
  if (!status) {
    return null;
  }
  const action = snapshot.actions.find(item => item.id === status.actionId);
  const label = action?.label ?? 'Viewer Host action';
  const message =
    status.message ??
    (status.state === 'accepted'
      ? 'Accepted'
      : status.state === 'running'
        ? 'Running'
        : status.state === 'succeeded'
          ? 'Succeeded'
          : 'Failed');
  return (
    <div
      role={status.state === 'failed' ? 'alert' : 'status'}
      aria-live={status.state === 'failed' ? 'assertive' : 'polite'}
      className={cn(
        glass,
        'pointer-events-none fixed left-1/2 z-40 max-w-md -translate-x-1/2 px-3 py-2 text-xs',
        markMode === 'annotate' ? 'bottom-20' : 'bottom-4',
        status.state === 'failed' && 'text-destructive',
      )}
    >
      <span className="font-medium">{label}:</span> {message}
    </div>
  );
}

export function useHostActionsSnapshot(): HostActionsSnapshot {
  const client = useViewerState(state => state.hostActionsClient);
  return useSyncExternalStore(
    client?.subscribe ?? subscribeNoop,
    client?.getSnapshot ?? getEmptySnapshot,
    getEmptySnapshot,
  );
}

function useHostActionsView() {
  const client = useViewerState(state => state.hostActionsClient);
  const payload = useViewerState(state => state.payload);
  const marksRuntime = useViewerState(state => state.marksRuntime);
  const annotations = useAnnotations(marksRuntime?.store ?? null);
  const snapshot = useHostActionsSnapshot();

  return {
    snapshot,
    invoke(action: HostActionDescriptor): void {
      client?.invoke(action.id);
    },
    pending(action: HostActionDescriptor): boolean {
      return hasPendingHostActionRequest(snapshot, action.id);
    },
    disabledReason(action: HostActionDescriptor): string | undefined {
      return hostActionDisabledReason(action, {
        connected: snapshot.connected,
        protocolReady: snapshot.protocolState === 'ready',
        hasModel: payload !== null,
        annotationCount: annotations.length,
        pending: hasPendingHostActionRequest(snapshot, action.id),
      });
    },
  };
}

function buttonVariant(tone: HostActionTone): 'ghost' | 'default' | 'destructive' {
  if (tone === 'primary') {
    return 'default';
  }
  if (tone === 'danger') {
    return 'destructive';
  }
  return 'ghost';
}

function subscribeNoop(): () => void {
  return () => undefined;
}

function getEmptySnapshot(): HostActionsSnapshot {
  return EMPTY_HOST_ACTIONS;
}
