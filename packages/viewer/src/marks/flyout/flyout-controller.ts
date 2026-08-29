import type { AnnotationStore } from '../annotation-store.js';
import { MAX_ANNOTATION_NOTE_LENGTH } from '@manifold3d/protocol/wire/annotations.js';

/**
 * Bridges the controller to whatever view layer is in use. The default
 * view implementation is {@link FlyoutView} (DOM-based), but tests can
 * supply a fake to assert on controller behaviour without DOM.
 */
export interface FlyoutControllerViewBridge {
  /**
   * Re-render the given annotation's view if one exists. Called after
   * the controller mutates expansion or draft state and wants the UI
   * to catch up. The bridge is responsible for resolving the current
   * view + annotation and pushing the merged view-model into it.
   */
  refresh(id: string): void;
  /** Move focus into the given annotation's textarea, if it exists. */
  focus(id: string): void;
  /**
   * Forcibly overwrite the textarea contents for the given annotation
   * (used on Cancel to revert the in-flight edit back to the saved
   * note). May be a no-op if the view is not present.
   */
  setTextareaValue(id: string, value: string): void;
}

/**
 * Owns the flyout draft state machine: which annotation (if any) is
 * currently expanded, and the in-flight unsaved text per annotation.
 *
 * The controller is intentionally DOM-free so it can be unit tested in
 * a Node environment with only the {@link AnnotationStore} and a fake
 * {@link FlyoutControllerViewBridge}.
 *
 * Lifecycle of an editable comment draft:
 *  - {@link open} snapshots the current note as the draft baseline so
 *    {@link cancel} can revert.
 *  - {@link setDraft} updates the in-flight text as the user types.
 *  - {@link commit} writes the draft to the store. Empty notes on a
 *    never-saved annotation are removed entirely (so accidental marks
 *    leave no trace).
 *  - {@link cancel} discards the draft. If the annotation has never
 *    been saved (`note === ''`) it is also removed.
 *  - {@link dismissAll} commits the currently-expanded draft (the
 *    "click outside to save" behaviour).
 *
 * Selection annotations and committed comments are read-only and ignored by
 * every editing entry point.
 */
export class FlyoutController {
  private expandedId: string | null = null;
  private readonly drafts = new Map<string, string>();

  constructor(
    private readonly store: AnnotationStore,
    private readonly view: FlyoutControllerViewBridge,
    private readonly onCommit?: () => void,
  ) {}

  /** Currently-expanded annotation id, or null if none is open. */
  getExpandedId(): string | null {
    return this.expandedId;
  }

  /** Returns the in-flight draft for the given annotation, if any. */
  getDraft(id: string): string | undefined {
    return this.drafts.get(id);
  }

  /**
   * Open the flyout for `id` in expanded mode and seed the draft with
   * the annotation's current note. If another flyout was already open,
   * its draft is committed first (matching the "click outside to save"
   * semantics applied between siblings).
   */
  open(id: string): void {
    const ann = this.store.get(id);
    if (!ann || ann.intent !== 'comment' || ann.state !== 'draft') {
      return;
    }
    if (this.expandedId !== null && this.expandedId !== id) {
      this.commit(this.expandedId);
    }
    this.drafts.set(id, ann.note);
    const previous = this.expandedId;
    this.expandedId = id;
    if (previous !== null && previous !== id) {
      this.view.refresh(previous);
    }
    this.view.refresh(id);
    this.view.focus(id);
  }

  /** Update the in-flight draft text for `id`. View refresh is left to the caller. */
  setDraft(id: string, value: string): void {
    const ann = this.store.get(id);
    if (!ann || ann.intent !== 'comment' || ann.state !== 'draft') {
      return;
    }
    this.drafts.set(id, value.slice(0, MAX_ANNOTATION_NOTE_LENGTH));
  }

  /**
   * Commit the in-flight draft to the store. If the resulting note is
   * empty AND the annotation never had any saved content, delete it
   * entirely so accidental marks leave no trace.
   */
  commit(id: string): void {
    const ann = this.store.get(id);
    if (!ann || ann.intent !== 'comment' || ann.state !== 'draft') {
      this.drafts.delete(id);
      if (this.expandedId === id) {
        this.expandedId = null;
        this.view.refresh(id);
      }
      return;
    }
    const draft = this.drafts.get(id) ?? ann.note;
    const trimmed = draft.trim();
    if (trimmed === '') {
      this.store.remove(id);
    } else if (draft !== ann.note) {
      this.store.update(id, { note: draft });
      this.onCommit?.();
    }
    this.collapseAfterFinish(id);
  }

  /**
   * Discard the draft and collapse. If the annotation has never had a
   * non-empty note (i.e. was just created), it is removed entirely;
   * otherwise the view is reverted to the saved value.
   */
  cancel(id: string): void {
    const ann = this.store.get(id);
    if (!ann || ann.intent !== 'comment' || ann.state !== 'draft') {
      this.collapseAfterFinish(id);
      return;
    }
    if (ann.note.trim() === '') {
      this.store.remove(id);
    } else {
      this.view.setTextareaValue(id, ann.note);
    }
    this.collapseAfterFinish(id);
  }

  /**
   * Dismiss any currently-open flyout. By design this commits the
   * in-flight draft -- "click outside to save" -- which is why the
   * tool layer routes plain (non-Ctrl) document clicks here.
   */
  dismissAll(): void {
    if (this.expandedId !== null) {
      this.commit(this.expandedId);
    }
  }

  /**
   * Reconcile internal state with the current editable-comment ids. Drops
   * drafts/expansion for annotations that were removed or became committed.
   */
  syncAlive(editableIds: ReadonlySet<string>): void {
    for (const id of [...this.drafts.keys()]) {
      if (!editableIds.has(id)) {
        this.drafts.delete(id);
      }
    }
    if (this.expandedId !== null && !editableIds.has(this.expandedId)) {
      this.expandedId = null;
    }
  }

  private collapseAfterFinish(id: string): void {
    this.drafts.delete(id);
    const wasExpanded = this.expandedId === id;
    if (wasExpanded) {
      this.expandedId = null;
    }
    if (wasExpanded) {
      this.view.refresh(id);
    }
  }
}
