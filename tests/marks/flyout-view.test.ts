import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlyoutView, type FlyoutViewModel } from '../../packages/viewer/src/marks/flyout/flyout-view.js';

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

interface ViewInternals {
  vm: FlyoutViewModel;
  element: {
    classList: FakeClassList;
    dataset: Record<string, string>;
    style: Record<string, string>;
  };
  textarea: {
    value: string;
    readOnly: boolean;
  };
  pill: {
    disabled: boolean;
    style: Record<string, string>;
  };
  labelEl: { textContent: string };
  previewEl: { textContent: string; style: Record<string, string> };
}

function makeView(vm: FlyoutViewModel): { view: FlyoutView; internals: ViewInternals } {
  const view = Object.create(FlyoutView.prototype) as FlyoutView;
  const internals = view as unknown as ViewInternals;
  internals.vm = vm;
  internals.element = { classList: new FakeClassList(), dataset: {}, style: {} };
  internals.textarea = { value: vm.note, readOnly: false };
  internals.pill = { disabled: false, style: {} };
  internals.labelEl = { textContent: '' };
  internals.previewEl = { textContent: '', style: {} };
  return { view, internals };
}

describe('FlyoutView read-only state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subdues and disables a flyout when its comment becomes committed', () => {
    vi.stubGlobal('document', { activeElement: null });
    const { view, internals } = makeView({
      partLabel: 'point#1',
      note: 'review',
      kind: 'point',
      expanded: true,
      readOnly: false,
    });
    view.setView({
      partLabel: 'point#1',
      note: 'review',
      kind: 'point',
      expanded: false,
      readOnly: true,
    });

    expect(internals.element.classList.contains('expanded')).toBe(false);
    expect(internals.element.dataset.state).toBe('committed');
    expect(internals.element.style.opacity).toBe('0.58');
    expect(internals.pill.disabled).toBe(true);
    expect(internals.pill.style.cursor).toBe('default');
    expect(internals.textarea.readOnly).toBe(true);
  });
});
