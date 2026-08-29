import * as THREE from 'three';

import type { AnnotationStore } from '../annotation-store.js';
import type { Annotation } from '../types.js';
import { FlyoutController } from './flyout-controller.js';
import { updatePositions as projectFlyouts } from './flyout-projection.js';
import { FlyoutView, type FlyoutViewModel } from './flyout-view.js';

/**
 * Top-level flyout subsystem -- the facade that wires together the
 * three concerns the original monolithic `flyout.ts` used to mix:
 *
 *   - {@link FlyoutController} owns the draft state machine (which
 *     annotation is open, what unsaved text each draft holds, the
 *     open/commit/cancel/dismissAll lifecycle).
 *   - {@link FlyoutView} owns each annotation's DOM (template, event
 *     wiring, focus). One view instance per visible annotation.
 *   - {@link updatePositions} (in `flyout-projection.ts`) is the pure
 *     per-frame screen-projection helper.
 *
 * The facade subscribes to the {@link AnnotationStore} to create and
 * dispose views as annotations come and go, and exposes the small
 * public surface the rest of the viewer (mark tool, React controls,
 * `installMarks`) actually needs.
 *
 * We intentionally avoid CSS2DRenderer here: a small bespoke layer is
 * simpler, gives us full control over events (mark gestures should not
 * start when the user clicks inside the flyout), and avoids
 * pulling another three.js addon.
 *
 * Save semantics for draft comments:
 *  - opening a flyout puts focus in the textarea
 *  - clicking outside the flyout (or pressing Esc) "dismisses" it
 *  - on dismiss: if the textarea is non-empty, we save; if empty, we
 *    discard the annotation (so accidental marks leave no trace)
 *  - committed comments retain a subdued read-only pill
 *  - selection annotations never create flyouts
 */
export class FlyoutLayer {
  private readonly host: HTMLDivElement;
  private readonly views = new Map<string, FlyoutView>();
  private readonly controller: FlyoutController;
  private unsubscribe: (() => void) | null = null;

  /**
   * Cached canvas bounding rect. Refreshed on `window.resize` only --
   * computing it every frame in {@link frame} forces a synchronous
   * layout in browsers and shows up as a hot spot when the model and
   * camera are idle. The rect can become stale if the canvas is moved
   * by something other than a resize (e.g. an animated panel slide);
   * if that becomes a real concern, the right fix is a ResizeObserver
   * on the canvas, not going back to per-frame measurement.
   */
  private readonly screenSize = { x: 0, y: 0 };
  private readonly projectionScratch = new THREE.Vector3();
  private readonly onResize = () => this.refreshScreenSize();

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly store: AnnotationStore,
    private readonly requestRender: () => void,
    onCommit?: () => void,
  ) {
    this.host = document.createElement('div');
    this.host.className = 'marks-flyout-layer';
    parent.appendChild(this.host);

    this.controller = new FlyoutController(
      store,
      {
        refresh: id => this.refreshView(id),
        focus: id => this.focusView(id),
        setTextareaValue: (id, value) => {
          const v = this.views.get(id);
          v?.setTextareaValue(value);
        },
      },
      onCommit,
    );

    this.refreshScreenSize();
    window.addEventListener('resize', this.onResize);
    this.unsubscribe = store.subscribe(items => this.sync(items));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    window.removeEventListener('resize', this.onResize);
    for (const v of this.views.values()) {
      v.dispose();
    }
    this.views.clear();
    this.host.remove();
  }

  /**
   * Update screen positions for every flyout. Called once per render
   * frame from the viewer loop so labels follow the model.
   */
  updatePositions(): void {
    const elements: Map<string, HTMLElement> = new Map();
    for (const [id, v] of this.views) {
      elements.set(id, v.element);
    }
    projectFlyouts(this.camera, this.store, elements, this.screenSize, this.projectionScratch);
  }

  /** Open the flyout for a freshly created annotation in expanded mode. */
  openExpanded(id: string): void {
    this.controller.open(id);
  }

  /** Returns true if the click target is inside any flyout DOM. */
  ownsTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) {
      return false;
    }
    return this.host.contains(target);
  }

  /** Called when the user clicks somewhere outside any flyout. */
  dismissAll(): void {
    this.controller.dismissAll();
  }

  private sync(items: readonly Annotation[]): void {
    const aliveIds = new Set(items.map(a => a.id));
    const editableIds = new Set(
      items
        .filter(annotation => annotation.intent === 'comment' && annotation.state === 'draft')
        .map(annotation => annotation.id),
    );
    for (const [id, v] of this.views) {
      if (!aliveIds.has(id)) {
        v.dispose();
        this.views.delete(id);
      }
    }
    this.controller.syncAlive(editableIds);
    for (const ann of items) {
      if (ann.intent === 'selection') {
        continue;
      }
      const existing = this.views.get(ann.id);
      if (existing) {
        existing.setView(this.toViewModel(ann));
      } else {
        const view = new FlyoutView(ann.id, this.toViewModel(ann), {
          onPillClick: () => {
            if (this.controller.getExpandedId() === ann.id) {
              this.controller.commit(ann.id);
            } else {
              this.controller.open(ann.id);
            }
          },
          onInput: value => {
            this.controller.setDraft(ann.id, value);
            const cur = this.store.get(ann.id);
            if (cur) {
              const v = this.views.get(ann.id);
              v?.setView(this.toViewModelWithNote(cur, value));
            }
          },
          onCommit: () => this.controller.commit(ann.id),
          onCancel: () => this.controller.cancel(ann.id),
        });
        this.views.set(ann.id, view);
        this.host.appendChild(view.element);
      }
    }
    this.updatePositions();
    this.requestRender();
  }

  private refreshView(id: string): void {
    const view = this.views.get(id);
    const ann = this.store.get(id);
    if (!view || !ann) {
      return;
    }
    view.setView(this.toViewModel(ann));
  }

  private focusView(id: string): void {
    const v = this.views.get(id);
    if (!v) {
      return;
    }
    requestAnimationFrame(() => v.focusTextarea());
  }

  private toViewModel(ann: Annotation): FlyoutViewModel {
    const draft = this.controller.getDraft(ann.id);
    return this.toViewModelWithNote(ann, draft ?? ann.note);
  }

  private toViewModelWithNote(ann: Annotation, note: string): FlyoutViewModel {
    return {
      partLabel: ann.partLabel,
      note,
      kind: ann.kind,
      expanded: ann.state === 'draft' && this.controller.getExpandedId() === ann.id,
      readOnly: ann.state !== 'draft',
    };
  }

  private refreshScreenSize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.screenSize.x = rect.width;
    this.screenSize.y = rect.height;
  }
}
