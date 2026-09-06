import { MAX_ANNOTATION_NOTE_LENGTH } from '@manifold3d/protocol/wire/annotations.js';

import type {
  Annotation,
  AnnotationKind,
  CommentAnnotation,
  CommentAnnotationInput,
  CommentBatchSnapshot,
  SelectionAnnotation,
  SelectionAnnotationInput,
} from './types.js';

type Listener = (annotations: readonly Annotation[]) => void;

/**
 * In-memory transactional store for the viewer's active annotations.
 *
 * Comment annotations accumulate in one active draft batch. Freezing the
 * batch commits every draft atomically and rotates to a fresh batch; cancel
 * removes only the active drafts. Selection annotations use a separate
 * pending -> committed/failed lifecycle.
 */
export class AnnotationStore {
  private readonly items = new Map<string, Annotation>();
  private readonly listeners = new Set<Listener>();
  private seqByKind: Record<AnnotationKind, number> = { point: 0, region: 0 };
  private idSequence = 0;
  private batchSequence = 0;
  private currentCommentBatchId = this.createBatchId('comments');
  private modelVersion = 'unknown';
  private revision = 0;
  private snapshot: readonly Annotation[] = Object.freeze([]);

  /** Immutable snapshot of the active draft comment transaction. */
  getDraftBatch(): CommentBatchSnapshot {
    return makeBatchSnapshot(this.currentCommentBatchId, this.getDraftComments(this.currentCommentBatchId));
  }

  /**
   * Commit every draft comment in the active (or explicitly captured) batch.
   * A non-empty successful freeze rotates the active batch.
   */
  freezeBatch(batchId: string): boolean {
    const comments = this.getBatchComments(batchId, new Set(['draft', 'pending']));
    if (comments.length === 0) {
      return false;
    }
    for (const comment of comments) {
      this.items.set(comment.id, freezeAnnotation({ ...comment, state: 'committed' }));
    }
    if (batchId === this.currentCommentBatchId) {
      this.rotateCommentBatch();
    }
    this.commit();
    return true;
  }

  /** Seal the current batch while a host action is in flight and rotate writes. */
  sealBatch(batchId: string): boolean {
    const drafts = this.getDraftComments(batchId);
    if (drafts.length === 0) {
      return false;
    }
    for (const draft of drafts) {
      this.items.set(draft.id, freezeAnnotation({ ...draft, state: 'pending' }));
    }
    if (batchId === this.currentCommentBatchId) {
      this.rotateCommentBatch();
    }
    this.commit();
    return true;
  }

  /** Merge a failed sealed batch back into the active editable transaction. */
  restoreBatch(batchId: string): boolean {
    const pending = this.getBatchComments(batchId, new Set(['pending']));
    if (pending.length === 0) {
      return false;
    }
    for (const comment of pending) {
      this.items.set(
        comment.id,
        freezeAnnotation({
          ...comment,
          state: 'draft',
          batchId: this.currentCommentBatchId,
        }),
      );
    }
    this.commit();
    return true;
  }

  /** Cancel a captured batch only if it is still the active draft batch. */
  cancelBatch(batchId: string): boolean {
    if (batchId !== this.currentCommentBatchId) {
      return false;
    }
    const ids = this.getDraftBatch().annotationIds;
    for (const id of ids) {
      this.items.delete(id);
    }
    this.rotateCommentBatch();
    if (ids.length > 0) {
      this.commit();
    }
    return true;
  }

  /** Transition one pending selection to committed after attachment succeeds. */
  commitSelection(id: string): boolean {
    const current = this.items.get(id);
    if (!current || current.intent !== 'selection' || current.state !== 'pending') {
      return false;
    }
    const committed: SelectionAnnotation = freezeAnnotation({ ...current, state: 'committed' });
    this.items.set(id, committed);
    this.commit();
    return true;
  }

  /** Remove one pending selection after attachment fails. */
  removeSelection(id: string): boolean {
    const current = this.items.get(id);
    if (!current || current.intent !== 'selection' || current.state !== 'pending') {
      return false;
    }
    this.items.delete(id);
    this.commit();
    return true;
  }

  /** Reset stale annotations only when the host advances to a new model. */
  setModelVersion(v: string): void {
    if (this.modelVersion === v) {
      return;
    }
    this.modelVersion = v;
    this.items.clear();
    this.seqByKind = { point: 0, region: 0 };
    this.idSequence = 0;
    this.rotateCommentBatch();
    this.commit();
  }

  getModelVersion(): string {
    return this.modelVersion;
  }

  getRevision(): number {
    return this.revision;
  }

  /**
   * Rebase a reloaded page above the revision retained by Viewer Host.
   * The next local commit will advance beyond this floor.
   */
  rebaseRevision(committedRevision: number): void {
    if (!Number.isSafeInteger(committedRevision) || committedRevision < 0) {
      throw new RangeError('Committed annotation revision must be a nonnegative safe integer.');
    }
    this.revision = Math.max(this.revision, committedRevision);
  }

  /** Create a draft comment in the current transaction batch. */
  addComment(input: CommentAnnotationInput): CommentAnnotation {
    assertNoteLength(input.note);
    const ann: CommentAnnotation = freezeAnnotation({
      ...this.createBase(input),
      intent: 'comment',
      state: 'draft',
      batchId: this.currentCommentBatchId,
      note: input.note,
    });
    this.items.set(ann.id, ann);
    this.commit();
    return ann;
  }

  /** Create a geometry-only selection awaiting attachment by ViewerCanvas. */
  addSelection(input: SelectionAnnotationInput): SelectionAnnotation {
    const ann: SelectionAnnotation = freezeAnnotation({
      ...this.createBase(input),
      intent: 'selection',
      state: 'pending',
      batchId: this.createBatchId('selection'),
      note: '',
    });
    this.items.set(ann.id, ann);
    this.commit();
    return ann;
  }

  /** Normal note edits are allowed only for draft comments. */
  update(id: string, patch: Partial<Pick<CommentAnnotation, 'note'>>): boolean {
    const cur = this.items.get(id);
    if (!cur || cur.intent !== 'comment' || cur.state !== 'draft') {
      return false;
    }
    if (patch.note !== undefined) {
      assertNoteLength(patch.note);
    }

    this.items.set(id, freezeAnnotation({ ...cur, ...patch }));
    this.commit();
    return true;
  }

  /** Normal removal cannot mutate committed annotations. */
  remove(id: string): boolean {
    const current = this.items.get(id);
    if (!current || current.intent !== 'comment' || current.state !== 'draft') {
      return false;
    }
    this.items.delete(id);
    this.commit();
    return true;
  }

  get(id: string): Annotation | undefined {
    return this.items.get(id);
  }

  list(): readonly Annotation[] {
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  private commit(): void {
    this.revision += 1;
    const snapshot = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    Object.freeze(snapshot);
    this.snapshot = snapshot;
    const snap = this.snapshot;
    for (const fn of this.listeners) {
      fn(snap);
    }
  }

  private createBase(input: SelectionAnnotationInput): Omit<Annotation, 'intent' | 'state' | 'batchId' | 'note'> {
    const seq = ++this.seqByKind[input.kind];
    return {
      id: `ann_${Date.now().toString(36)}_${(++this.idSequence).toString(36)}`,
      createdAt: Date.now(),
      modelVersion: this.modelVersion,
      kind: input.kind,
      anchorWorld: frozenTuple3(input.anchorWorld),
      worldCoord: frozenTuple3(input.worldCoord),
      triIds: frozenNumbers(input.triIds),
      partLabel: input.partLabel && input.partLabel.length > 0 ? input.partLabel : `${input.kind}#${seq}`,
    };
  }

  private getDraftComments(batchId: string): CommentAnnotation[] {
    return this.getBatchComments(batchId, new Set(['draft']));
  }

  private getBatchComments(batchId: string, states: ReadonlySet<CommentAnnotation['state']>): CommentAnnotation[] {
    return this.snapshot.filter(
      (annotation): annotation is CommentAnnotation =>
        annotation.intent === 'comment' && states.has(annotation.state) && annotation.batchId === batchId,
    );
  }

  private rotateCommentBatch(): void {
    this.currentCommentBatchId = this.createBatchId('comments');
  }

  private createBatchId(intent: 'comments' | 'selection'): string {
    this.batchSequence += 1;
    return `batch_${intent}_${Date.now().toString(36)}_${this.batchSequence.toString(36)}`;
  }
}

function assertNoteLength(note: string): void {
  if (note.length > MAX_ANNOTATION_NOTE_LENGTH) {
    throw new RangeError(`Annotation note cannot exceed ${MAX_ANNOTATION_NOTE_LENGTH} characters.`);
  }
}

function makeBatchSnapshot(batchId: string, annotations: readonly CommentAnnotation[]): CommentBatchSnapshot {
  const annotationIds = annotations.map(annotation => annotation.id);
  Object.freeze(annotationIds);
  const snapshot = {
    batchId,
    annotationIds,
  };
  Object.freeze(snapshot);
  return snapshot;
}

function freezeAnnotation<T extends Annotation>(annotation: T): T {
  Object.freeze(annotation);
  return annotation;
}

function frozenTuple3(value: readonly [number, number, number]): [number, number, number] {
  const copy: [number, number, number] = [value[0], value[1], value[2]];
  Object.freeze(copy);
  return copy;
}

function frozenNumbers(value: readonly number[]): number[] {
  const copy = [...value];
  Object.freeze(copy);
  return copy;
}
