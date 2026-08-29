import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationStore } from '../../packages/viewer/src/marks/annotation-store.js';
import {
  FlyoutController,
  type FlyoutControllerViewBridge,
} from '../../packages/viewer/src/marks/flyout/flyout-controller.js';

function makeBridge(): {
  bridge: FlyoutControllerViewBridge;
  refresh: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setTextareaValue: ReturnType<typeof vi.fn>;
} {
  const refresh = vi.fn<(id: string) => void>();
  const focus = vi.fn<(id: string) => void>();
  const setTextareaValue = vi.fn<(id: string, value: string) => void>();
  return {
    bridge: { refresh, focus, setTextareaValue },
    refresh,
    focus,
    setTextareaValue,
  };
}

function seed(store: AnnotationStore, note = ''): string {
  const ann = store.addComment({
    kind: 'point',
    worldCoord: [0, 0, 0],
    anchorWorld: [0, 0, 0],
    triIds: [],
    note,
  });
  return ann.id;
}

describe('FlyoutController', () => {
  let store: AnnotationStore;
  let bridge: ReturnType<typeof makeBridge>;
  let controller: FlyoutController;

  beforeEach(() => {
    store = new AnnotationStore();
    bridge = makeBridge();
    controller = new FlyoutController(store, bridge.bridge);
  });

  it('open() seeds a draft from the saved note and marks the annotation expanded', () => {
    const id = seed(store, 'hello');
    controller.open(id);

    expect(controller.getExpandedId()).toBe(id);
    expect(controller.getDraft(id)).toBe('hello');
    expect(bridge.refresh).toHaveBeenCalledWith(id);
    expect(bridge.focus).toHaveBeenCalledWith(id);
  });

  it('open() ignores unknown ids', () => {
    controller.open('nope');
    expect(controller.getExpandedId()).toBeNull();
    expect(bridge.focus).not.toHaveBeenCalled();
  });

  it('commit() writes the draft to the annotation store and clears state', () => {
    const id = seed(store);
    controller.open(id);
    controller.setDraft(id, 'final note');
    controller.commit(id);

    expect(store.get(id)?.note).toBe('final note');
    expect(controller.getDraft(id)).toBeUndefined();
    expect(controller.getExpandedId()).toBeNull();
  });

  it('notifies the host bridge immediately after a changed draft is saved', () => {
    const onCommit = vi.fn();
    const notifyingController = new FlyoutController(store, bridge.bridge, onCommit);
    const id = seed(store);
    notifyingController.open(id);
    notifyingController.setDraft(id, 'send this to the host');
    notifyingController.commit(id);

    expect(onCommit).toHaveBeenCalledOnce();
    notifyingController.open(id);
    notifyingController.commit(id);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('commit() with an empty draft on a never-saved annotation removes it', () => {
    const id = seed(store);
    controller.open(id);
    controller.setDraft(id, '   ');
    controller.commit(id);

    expect(store.get(id)).toBeUndefined();
    expect(controller.getExpandedId()).toBeNull();
  });

  it('commit() with an empty draft removes an uncommitted annotation', () => {
    const id = seed(store, 'existing');
    controller.open(id);
    controller.setDraft(id, '');
    controller.commit(id);

    expect(store.get(id)).toBeUndefined();
    expect(controller.getExpandedId()).toBeNull();
  });

  it('cancel() discards a never-saved annotation entirely', () => {
    const id = seed(store);
    controller.open(id);
    controller.setDraft(id, 'typed but cancelled');
    controller.cancel(id);

    expect(store.get(id)).toBeUndefined();
    expect(controller.getExpandedId()).toBeNull();
    expect(bridge.setTextareaValue).not.toHaveBeenCalled();
  });

  it('cancel() reverts the textarea to the saved note when one exists', () => {
    const id = seed(store, 'saved');
    controller.open(id);
    controller.setDraft(id, 'typed but cancelled');
    controller.cancel(id);

    expect(store.get(id)?.note).toBe('saved');
    expect(bridge.setTextareaValue).toHaveBeenCalledWith(id, 'saved');
  });

  it('opening a second annotation commits the first', () => {
    const a = seed(store);
    const b = seed(store);
    controller.open(a);
    controller.setDraft(a, 'first');
    controller.open(b);

    expect(store.get(a)?.note).toBe('first');
    expect(controller.getExpandedId()).toBe(b);
  });

  it('dismissAll() commits the currently-open draft', () => {
    const id = seed(store);
    controller.open(id);
    controller.setDraft(id, 'autosaved on outside click');
    controller.dismissAll();

    expect(store.get(id)?.note).toBe('autosaved on outside click');
    expect(controller.getExpandedId()).toBeNull();
  });

  it('dismissAll() with nothing open is a no-op', () => {
    expect(() => controller.dismissAll()).not.toThrow();
    expect(controller.getExpandedId()).toBeNull();
  });

  it('syncAlive() drops drafts and expansion for missing ids', () => {
    const a = seed(store);
    const b = seed(store);
    controller.open(a);
    controller.setDraft(b, 'orphan');

    controller.syncAlive(new Set([b]));

    expect(controller.getExpandedId()).toBeNull();
    expect(controller.getDraft(a)).toBeUndefined();
    expect(controller.getDraft(b)).toBe('orphan');
  });

  it('does not open or edit committed comments', () => {
    const id = seed(store, 'frozen');
    store.freezeBatch(store.getDraftBatch().batchId);

    controller.open(id);
    controller.setDraft(id, 'changed');
    controller.commit(id);
    controller.cancel(id);

    expect(controller.getExpandedId()).toBeNull();
    expect(controller.getDraft(id)).toBeUndefined();
    expect(store.get(id)?.note).toBe('frozen');
    expect(bridge.focus).not.toHaveBeenCalled();
  });

  it('drops an open draft when the comment batch becomes committed', () => {
    const id = seed(store, 'ready');
    controller.open(id);
    controller.setDraft(id, 'in flight');

    store.freezeBatch(store.getDraftBatch().batchId);
    controller.syncAlive(new Set());

    expect(controller.getExpandedId()).toBeNull();
    expect(controller.getDraft(id)).toBeUndefined();
    expect(store.get(id)?.note).toBe('ready');
  });

  it('does not open or edit selection annotations', () => {
    const selection = store.addSelection({
      kind: 'point',
      worldCoord: [0, 0, 0],
      anchorWorld: [0, 0, 0],
      triIds: [],
    });

    controller.open(selection.id);
    controller.setDraft(selection.id, 'changed');
    controller.commit(selection.id);
    controller.cancel(selection.id);

    expect(controller.getExpandedId()).toBeNull();
    expect(controller.getDraft(selection.id)).toBeUndefined();
    expect(store.get(selection.id)).toMatchObject({ state: 'pending', note: '' });
    expect(bridge.focus).not.toHaveBeenCalled();
  });
});
