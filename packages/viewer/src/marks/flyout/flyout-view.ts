import type { AnnotationKind } from '../types.js';
import { MAX_ANNOTATION_NOTE_LENGTH } from '@manifold3d/protocol/wire/annotations.js';

/**
 * Render-only state for one flyout. The controller owns the source of
 * truth (annotation + draft); this is what the view needs to show.
 */
export interface FlyoutViewModel {
  partLabel: string;
  /** Current displayed text (may be a draft, may be the saved note). */
  note: string;
  kind: AnnotationKind;
  expanded: boolean;
}

export interface FlyoutViewCallbacks {
  /** User clicked the pill (the collapsed/expanded toggle). */
  onPillClick(): void;
  /** Textarea value changed. */
  onInput(value: string): void;
  /** User pressed Enter (without Shift) or clicked Save. */
  onCommit(): void;
  /** User pressed Escape or clicked Cancel. */
  onCancel(): void;
}

/**
 * One DOM element rendering a single annotation flyout. Pure view: it
 * does not know about drafts, expansion routing, or the annotation
 * store. State changes are pushed in via {@link setView}; user input
 * is reported via the callbacks supplied at construction.
 */
export class FlyoutView {
  readonly element: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly labelEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private vm: FlyoutViewModel;

  constructor(annId: string, vm: FlyoutViewModel, callbacks: FlyoutViewCallbacks) {
    this.vm = vm;
    const wrap = document.createElement('div');
    wrap.className = 'marks-flyout';
    wrap.dataset.annId = annId;
    wrap.innerHTML = `
      <button class="marks-flyout-pill" type="button" data-kind="${escapeAttr(vm.kind)}" title="${escapeAttr(vm.partLabel)}">
        <span class="marks-flyout-dot"></span>
        <span class="marks-flyout-label"></span>
        <span class="marks-flyout-note-preview"></span>
      </button>
      <div class="marks-flyout-body">
        <textarea
          class="marks-flyout-textarea"
          rows="3"
          placeholder="say something about this..."
        ></textarea>
        <div class="marks-flyout-hint">Enter to save · Shift+Enter for newline · Esc to dismiss</div>
        <div class="marks-flyout-actions">
          <button type="button" class="marks-flyout-cancel marks-flyout-btn marks-flyout-btn-subtle">Cancel</button>
          <button type="button" class="marks-flyout-save marks-flyout-btn marks-flyout-btn-primary">Save</button>
        </div>
      </div>
    `;
    this.element = wrap;
    this.textarea = wrap.querySelector('textarea.marks-flyout-textarea') as HTMLTextAreaElement;
    this.textarea.maxLength = MAX_ANNOTATION_NOTE_LENGTH;
    this.labelEl = wrap.querySelector('.marks-flyout-label') as HTMLElement;
    this.previewEl = wrap.querySelector('.marks-flyout-note-preview') as HTMLElement;

    this.textarea.value = vm.note;
    this.textarea.addEventListener('input', () => callbacks.onInput(this.textarea.value));
    this.textarea.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        ev.stopPropagation();
        callbacks.onCommit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        callbacks.onCancel();
      }
    });
    const pill = wrap.querySelector('.marks-flyout-pill') as HTMLButtonElement;
    pill.addEventListener('click', ev => {
      ev.stopPropagation();
      callbacks.onPillClick();
    });
    const cancelBtn = wrap.querySelector('.marks-flyout-cancel') as HTMLButtonElement;
    cancelBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      callbacks.onCancel();
    });
    const saveBtn = wrap.querySelector('.marks-flyout-save') as HTMLButtonElement;
    saveBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      callbacks.onCommit();
    });
    this.applyVm();
  }

  /** Push a new model into the view. The view diffs against its prior vm. */
  setView(vm: FlyoutViewModel): void {
    this.vm = vm;
    this.applyVm();
  }

  /** Move focus into the textarea and select its contents. */
  focusTextarea(): void {
    this.textarea.focus();
    this.textarea.select?.();
  }

  /** True if the textarea currently has focus. */
  textareaHasFocus(): boolean {
    return document.activeElement === this.textarea;
  }

  /** Forcibly overwrite the textarea contents (used on Cancel revert). */
  setTextareaValue(value: string): void {
    this.textarea.value = value;
  }

  dispose(): void {
    this.element.remove();
  }

  private applyVm(): void {
    const vm = this.vm;
    this.labelEl.textContent = vm.partLabel;
    const trimmed = vm.note.trim();
    if (trimmed) {
      const short = trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
      this.previewEl.textContent = short;
      this.previewEl.style.display = '';
    } else {
      this.previewEl.textContent = '';
      this.previewEl.style.display = 'none';
    }
    if (!this.textareaHasFocus() && this.textarea.value !== vm.note) {
      this.textarea.value = vm.note;
    }
    if (vm.expanded) {
      this.element.classList.add('expanded');
    } else {
      this.element.classList.remove('expanded');
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
