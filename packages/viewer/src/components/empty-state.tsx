import { Box } from 'lucide-react';
import { useViewerState } from '@/store';
import { glass } from '@/components/glass';
import { cn } from '@/lib/utils';

/**
 * Centered onboarding card shown when no model has been pushed yet.
 * Once the MCP server streams a mesh over the live WebSocket, the card
 * disappears and the model takes over the viewport.
 */
export function EmptyState() {
  const payload = useViewerState(s => s.payload);
  const status = useViewerState(s => s.status);

  if (payload) {
    return null;
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className={cn(glass, 'flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl p-8 text-center')}>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
          <Box className="size-6 text-primary" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-base font-semibold text-foreground text-balance">等待模型推送</h1>
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            {status === 'connected'
              ? '已连接到 MCP 服务器。在对话中生成模型后,它会自动出现在这里。'
              : '正在连接 MCP 服务器…模型生成后会自动出现在这里。'}
          </p>
        </div>
      </div>
    </div>
  );
}
