import { Check, LoaderCircle, MessageSquare, Trash2, WandSparkles } from 'lucide-react';
import { useState } from 'react';

import { glass } from '@/components/glass';
import { useHostActionsSnapshot } from '@/components/host-actions';
import { Button } from '@/components/ui/button';
import { hasPendingHostActionRequest, hostActionDisabledReason } from '@/host-actions/client';
import { useAnnotations, useViewerState } from '@/store';
import { MAX_HOST_ACTION_ANNOTATION_IDS, type HostActionDescriptor } from '@manifold3d/protocol/wire/host-actions.js';

const ATTACH_BATCH_ACTION = 'attach-annotation-batch';
const FIX_BATCH_ACTION = 'fix-annotation-batch';

export function AnnotationBatchBar() {
  const markMode = useViewerState(state => state.markMode);
  const payload = useViewerState(state => state.payload);
  const viewerApi = useViewerState(state => state.viewerApi);
  const marks = useViewerState(state => state.marksRuntime);
  const client = useViewerState(state => state.hostActionsClient);
  const hostActions = useHostActionsSnapshot();
  useAnnotations(marks?.store ?? null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  if (markMode !== 'annotate' || !marks) {
    return null;
  }

  const batch = marks.store.getDraftBatch();
  const attachAction = hostActions.actions.find(action => action.id === ATTACH_BATCH_ACTION);
  const fixAction = hostActions.actions.find(action => action.id === FIX_BATCH_ACTION);
  const hasHostBatchActions = attachAction !== undefined || fixAction !== undefined;
  const batchEmpty = batch.annotationIds.length === 0;
  const batchTooLarge = batch.annotationIds.length > MAX_HOST_ACTION_ANNOTATION_IDS;
  const busy = pendingAction !== null;
  const disabledReason = (action: HostActionDescriptor): string | undefined =>
    batchTooLarge
      ? `A batch can contain at most ${MAX_HOST_ACTION_ANNOTATION_IDS} annotations.`
      : hostActionDisabledReason(action, {
          connected: hostActions.connected,
          protocolReady: hostActions.protocolState === 'ready',
          hasModel: payload !== null,
          annotationCount: batch.annotationIds.length,
          pending: hasPendingHostActionRequest(hostActions, action.id),
        });

  const finishLocally = (kind: 'freeze' | 'cancel'): void => {
    if (kind === 'freeze') {
      marks.commitOpenDraft();
      marks.store.freezeBatch(batch.batchId);
    } else {
      marks.store.cancelBatch(batch.batchId);
    }
    marks.flushAnnotations();
    viewerApi?.setMarkMode('orbit');
  };

  const invoke = (actionId: string): void => {
    if (!client || batchEmpty || busy) {
      return;
    }
    marks.commitOpenDraft();
    const committedDraft = marks.store.getDraftBatch();
    if (committedDraft.annotationIds.length === 0) {
      return;
    }
    if (!marks.store.sealBatch(committedDraft.batchId)) {
      return;
    }
    marks.flushAnnotations();
    viewerApi?.setMarkMode('orbit');
    setPendingAction(actionId);
    const operation = client
      .invokeAndWait(actionId, {
        annotationIds: committedDraft.annotationIds,
        input: { batchId: committedDraft.batchId },
      })
      .then(status => {
        if (status.state === 'succeeded') {
          marks.store.freezeBatch(committedDraft.batchId);
        } else {
          if (marks.store.restoreBatch(committedDraft.batchId)) {
            viewerApi?.setMarkMode('annotate');
          }
        }
        marks.flushAnnotations();
      })
      .catch(() => {
        const restored = marks.store.restoreBatch(committedDraft.batchId);
        marks.flushAnnotations();
        if (restored) {
          viewerApi?.setMarkMode('annotate');
        }
      });
    void operation.then(
      () => setPendingAction(null),
      () => setPendingAction(null),
    );
  };

  return (
    <section
      aria-label="Annotation batch actions"
      className={`${glass} fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-2xl p-2`}
    >
      <span className="px-2 text-xs font-medium text-muted-foreground">
        {batch.annotationIds.length} {batch.annotationIds.length === 1 ? 'annotation' : 'annotations'}
      </span>
      {fixAction && (
        <Button
          size="sm"
          disabled={batchEmpty || busy || disabledReason(fixAction) !== undefined}
          title={disabledReason(fixAction)}
          onClick={() => invoke(fixAction.id)}
        >
          {pendingAction === fixAction.id ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <WandSparkles aria-hidden="true" />
          )}
          Fix them
        </Button>
      )}
      {attachAction && (
        <Button
          variant="ghost"
          size="sm"
          disabled={batchEmpty || busy || disabledReason(attachAction) !== undefined}
          title={disabledReason(attachAction)}
          onClick={() => invoke(attachAction.id)}
        >
          {pendingAction === attachAction.id ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <MessageSquare aria-hidden="true" />
          )}
          Attach
        </Button>
      )}
      {!hasHostBatchActions && (
        <Button variant="ghost" size="sm" disabled={batchEmpty || busy} onClick={() => finishLocally('freeze')}>
          <Check aria-hidden="true" />
          Done
        </Button>
      )}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => finishLocally('cancel')}>
        <Trash2 aria-hidden="true" />
        Cancel
      </Button>
    </section>
  );
}
