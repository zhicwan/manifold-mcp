import type { Annotation, AnnotationKind } from './types.js';
import { MAX_ANNOTATION_NOTE_LENGTH } from '@manifold3d/protocol/wire/annotations.js';

type Listener = (annotations: Annotation[]) => void;

/**
 * In-memory store for the viewer's active annotations, with a small
 * pub/sub interface so the sidebar, marker layer, and (in M2) the
 * WS uplink can all stay in sync without explicit wiring.
 *
 * The store is intentionally minimal: no undo stack, no persistence.
 * M1 keeps annotations only for the lifetime of the page.
 */
export class AnnotationStore {
  private readonly items = new Map<string, Annotation>();
  private readonly listeners = new Set<Listener>();
  private seqByKind: Record<AnnotationKind, number> = { point: 0, region: 0 };
  private modelVersion = 'unknown';
  private revision = 0;
  private snapshot: Annotation[] = [];

  /** Replace every annotation with the empty set; used on new model push. */
  clear(): void {
    if (this.items.size === 0) {
      return;
    }
    this.items.clear();
    this.seqByKind = { point: 0, region: 0 };
    this.commit();
  }

  /** Update model version and clear stale annotations. */
  setModelVersion(v: string): void {
    if (this.modelVersion === v) {
      return;
    }
    this.modelVersion = v;
    this.items.clear();
    this.seqByKind = { point: 0, region: 0 };
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

  add(input: Omit<Annotation, 'id' | 'createdAt' | 'modelVersion' | 'partLabel'> & { partLabel?: string }): Annotation {
    assertNoteLength(input.note);
    const seq = ++this.seqByKind[input.kind];
    const partLabel = input.partLabel && input.partLabel.length > 0 ? input.partLabel : `${input.kind}#${seq}`;
    const ann: Annotation = {
      id: `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      modelVersion: this.modelVersion,
      ...input,
      partLabel,
    };
    this.items.set(ann.id, ann);
    this.commit();
    return ann;
  }

  update(id: string, patch: Partial<Pick<Annotation, 'note'>>): void {
    if (patch.note !== undefined) {
      assertNoteLength(patch.note);
    }
    const cur = this.items.get(id);
    if (!cur) {
      return;
    }

    this.items.set(id, { ...cur, ...patch });
    this.commit();
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.commit();
    }
  }

  get(id: string): Annotation | undefined {
    return this.items.get(id);
  }

  list(): Annotation[] {
    return this.snapshot;
  }

  size(): number {
    return this.items.size;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  private commit(): void {
    this.revision += 1;
    this.snapshot = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    const snap = this.snapshot;
    for (const fn of this.listeners) {
      fn(snap);
    }
  }
}

function assertNoteLength(note: string): void {
  if (note.length > MAX_ANNOTATION_NOTE_LENGTH) {
    throw new RangeError(`Annotation note cannot exceed ${MAX_ANNOTATION_NOTE_LENGTH} characters.`);
  }
}
