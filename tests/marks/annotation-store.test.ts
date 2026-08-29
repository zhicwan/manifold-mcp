import { describe, expect, it } from 'vitest';

import { AnnotationStore } from '../../packages/viewer/src/marks/annotation-store.js';
import type {
  Annotation,
  CommentAnnotation,
  CommentAnnotationInput,
  SelectionAnnotationInput,
} from '../../packages/viewer/src/marks/types.js';

const point: CommentAnnotationInput = {
  kind: 'point',
  anchorWorld: [1, 2, 3],
  worldCoord: [1, 2, 3],
  triIds: [],
  note: '',
};

const region: SelectionAnnotationInput = {
  kind: 'region',
  anchorWorld: [4, 5, 6],
  worldCoord: [4, 5, 6],
  triIds: [1, 2, 3],
};

describe('AnnotationStore transactions', () => {
  it('isolates the current draft comment batch from selections and later batches', () => {
    const store = new AnnotationStore();
    const batchId = store.getCurrentCommentBatchId();
    const first = store.addComment({ ...point, note: 'first' });
    const second = store.addComment({ ...point, note: 'second' });
    store.addSelection(region);

    expect(first.batchId).toBe(batchId);
    expect(store.getCurrentDraftBatchSnapshot()).toEqual([first, second]);
    expect(store.getCurrentDraftBatchIds()).toEqual([first.id, second.id]);
    expect(store.getCurrentDraftBatchCount()).toBe(2);
    expect(store.getDraftBatch()).toMatchObject({
      batchId,
      annotationIds: [first.id, second.id],
      count: 2,
    });

    const frozen = store.freezeBatch(batchId);
    const next = store.addComment({ ...point, note: 'next' });
    expect(frozen).toMatchObject({ batchId, ids: [first.id, second.id], count: 2 });
    expect(next.batchId).not.toBe(batchId);
    expect(store.getCurrentDraftBatchIds()).toEqual([next.id]);
    expect(store.freezeBatch(batchId)).toBeUndefined();
  });

  it('freezes a batch atomically and makes committed comments immutable', () => {
    const store = new AnnotationStore();
    const originalBatch = store.getCurrentCommentBatchId();
    const first = store.addComment({ ...point, note: 'alpha' });
    const second = store.addComment({ ...point, note: 'beta' });

    const frozen = store.freezeBatch();

    expect(frozen?.annotations.map(annotation => annotation.state)).toEqual(['committed', 'committed']);
    expect(store.get(first.id)?.state).toBe('committed');
    expect(store.get(second.id)?.state).toBe('committed');
    expect(store.getCurrentCommentBatchId()).not.toBe(originalBatch);
    expect(store.update(first.id, { note: 'changed' })).toBe(false);
    expect(store.remove(first.id)).toBe(false);
    expect(store.get(first.id)?.note).toBe('alpha');
    const committed = store.get(first.id) as CommentAnnotation;
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.worldCoord)).toBe(true);
    expect(Object.isFrozen(committed.triIds)).toBe(true);
    expect(() => {
      committed.note = 'external mutation';
    }).toThrow();
    expect(() => {
      committed.worldCoord[0] = 99;
    }).toThrow();
    expect(() => {
      (store.list() as Annotation[]).push(committed);
    }).toThrow();
    expect(store.getRevision()).toBe(3);
    expect(store.get(first.id)?.note).toBe('alpha');
  });

  it('seals an exact submitted batch and restores it into the current batch on failure', () => {
    const store = new AnnotationStore();
    const submitted = store.addComment({ ...point, note: 'submitted' });
    const submittedBatch = submitted.batchId;

    expect(store.sealBatch(submittedBatch)).toMatchObject({
      batchId: submittedBatch,
      annotations: [expect.objectContaining({ id: submitted.id, state: 'pending' })],
    });
    expect(store.getCurrentCommentBatchId()).not.toBe(submittedBatch);
    expect(store.update(submitted.id, { note: 'unsent edit' })).toBe(false);

    const later = store.addComment({ ...point, note: 'later' });
    store.restoreBatch(submittedBatch);
    const restored = store.getDraftBatch();
    expect(restored.annotationIds).toEqual([submitted.id, later.id]);
    expect(store.get(submitted.id)).toMatchObject({
      state: 'draft',
      batchId: restored.batchId,
      note: 'submitted',
    });
  });

  it('commits only a sealed submitted batch while later drafts remain editable', () => {
    const store = new AnnotationStore();
    const submitted = store.addComment({ ...point, note: 'submitted' });
    store.sealBatch(submitted.batchId);
    const later = store.addComment({ ...point, note: 'later' });

    store.freezeBatch(submitted.batchId);

    expect(store.get(submitted.id)?.state).toBe('committed');
    expect(store.get(later.id)?.state).toBe('draft');
    expect(store.getDraftBatch().annotationIds).toEqual([later.id]);
  });

  it('cancels only the active draft batch and preserves committed comments', () => {
    const store = new AnnotationStore();
    const committed = store.addComment({ ...point, note: 'keep' });
    store.freezeBatch();
    const cancelledBatch = store.getCurrentCommentBatchId();
    const firstDraft = store.addComment({ ...point, note: 'discard one' });
    const secondDraft = store.addComment({ ...point, note: 'discard two' });

    expect(store.cancelBatch('stale-batch')).toEqual([]);
    expect(store.getCurrentDraftBatchCount()).toBe(2);
    expect(store.cancelCurrentBatch()).toEqual([firstDraft.id, secondDraft.id]);
    expect(store.get(committed.id)?.state).toBe('committed');
    expect(store.get(firstDraft.id)).toBeUndefined();
    expect(store.get(secondDraft.id)).toBeUndefined();
    expect(store.getCurrentCommentBatchId()).not.toBe(cancelledBatch);
  });

  it('handles pending selection success and failure with guarded transitions', () => {
    const store = new AnnotationStore();
    const success = store.addSelection(region);
    const failure = store.addSelection(region);

    expect(success).toMatchObject({ intent: 'selection', state: 'pending', note: '' });
    expect(success.batchId).not.toBe(failure.batchId);
    expect(store.update(success.id, { note: 'not allowed' })).toBe(false);

    expect(store.commitPendingSelection(success.id)).toMatchObject({ state: 'committed' });
    expect(store.commitSelection(success.id)).toBeUndefined();
    expect(store.remove(success.id)).toBe(false);
    expect(store.removeFailedSelection(success.id)).toBe(false);

    expect(store.removeSelection(failure.id)).toBe(true);
    expect(store.get(failure.id)).toBeUndefined();
    expect(store.commitPendingSelection(failure.id)).toBeUndefined();
  });

  it('resets every annotation and rotates the batch for a new model', () => {
    const store = new AnnotationStore();
    store.setModelVersion('v1');
    const oldBatch = store.getCurrentCommentBatchId();
    store.addComment(point);
    store.addSelection(region);

    store.resetForModelVersion('v2');

    expect(store.getModelVersion()).toBe('v2');
    expect(store.list()).toEqual([]);
    expect(store.getCurrentDraftBatchCount()).toBe(0);
    expect(store.getCurrentCommentBatchId()).not.toBe(oldBatch);
    expect(store.addComment(point).partLabel).toBe('point#1');
  });
});
