import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const pickerMocks = vi.hoisted(() => ({
  pickPoint: vi.fn(),
  pickRegion: vi.fn(),
}));

vi.mock('../../packages/viewer/src/marks/picker.js', async () => {
  const threeModule = await import('three');
  return {
    eventToNdc: (event: { clientX: number; clientY: number }) =>
      new threeModule.Vector2(event.clientX / 100, event.clientY / 100),
    pickPoint: pickerMocks.pickPoint,
    pickRegion: pickerMocks.pickRegion,
  };
});

import { AnnotationStore } from '../../packages/viewer/src/marks/annotation-store.js';
import type { FlyoutLayer } from '../../packages/viewer/src/marks/flyout/index.js';
import { MarkTool } from '../../packages/viewer/src/marks/mark-tool.js';
import type { MarkMode } from '../../packages/viewer/src/marks/types.js';

type EventListener = (event: Record<string, unknown>) => void;

class FakeEventTarget {
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeElement extends FakeEventTarget {
  className = '';
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  removed = false;

  appendChild(child: FakeElement): void {
    this.children.push(child);
  }

  remove(): void {
    this.removed = true;
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 100, height: 100 } as DOMRect;
  }
}

function mouse(clientX: number, clientY: number): Record<string, unknown> {
  return {
    button: 0,
    clientX,
    clientY,
    ctrlKey: false,
    metaKey: false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe('MarkTool annotate/select gestures', () => {
  let fakeWindow: FakeEventTarget;
  let body: FakeElement;
  let overlay: FakeElement;
  let canvas: FakeElement;
  let store: AnnotationStore;
  let flyouts: {
    ownsTarget: ReturnType<typeof vi.fn>;
    openExpanded: ReturnType<typeof vi.fn>;
    dismissAll: ReturnType<typeof vi.fn>;
  };
  let controls: { enabled: boolean };
  let modeChanged: ReturnType<typeof vi.fn<(mode: MarkMode) => void>>;
  let selectionCreated: ReturnType<typeof vi.fn<(id: string) => void>>;
  let tool: MarkTool;

  beforeEach(() => {
    fakeWindow = new FakeEventTarget();
    body = new FakeElement();
    overlay = new FakeElement();
    canvas = new FakeElement();
    store = new AnnotationStore();
    flyouts = {
      ownsTarget: vi.fn(() => false),
      openExpanded: vi.fn(),
      dismissAll: vi.fn(),
    };
    controls = { enabled: true };
    modeChanged = vi.fn();
    selectionCreated = vi.fn();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      body,
      createElement: () => new FakeElement(),
    });
    pickerMocks.pickPoint.mockReturnValue({
      triId: 7,
      worldCoord: new THREE.Vector3(1, 2, 3),
    });
    pickerMocks.pickRegion.mockReturnValue({
      triIds: [1, 2],
      centroidWorld: new THREE.Vector3(4, 5, 6),
    });
    tool = new MarkTool(
      overlay as unknown as HTMLElement,
      canvas as unknown as HTMLCanvasElement,
      new THREE.PerspectiveCamera(),
      controls as unknown as OrbitControls,
      store,
      flyouts as unknown as FlyoutLayer,
      () => ({}) as THREE.Mesh,
      () => null,
      modeChanged,
      selectionCreated,
    );
  });

  afterEach(() => {
    tool.dispose();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { mode: 'annotate' as const, drag: false, kind: 'point' as const },
    { mode: 'annotate' as const, drag: true, kind: 'region' as const },
    { mode: 'select' as const, drag: false, kind: 'point' as const },
    { mode: 'select' as const, drag: true, kind: 'region' as const },
  ])('$mode gesture (drag=$drag) creates a $kind annotation', ({ mode, drag, kind }) => {
    performGesture(mode, drag);

    const annotation = store.list()[0]!;
    expect(annotation.kind).toBe(kind);
    if (mode === 'annotate') {
      expect(annotation).toMatchObject({ intent: 'comment', state: 'draft' });
      expect(flyouts.openExpanded).toHaveBeenCalledWith(annotation.id);
      expect(selectionCreated).not.toHaveBeenCalled();
    } else {
      expect(annotation).toMatchObject({ intent: 'selection', state: 'pending', note: '' });
      expect(selectionCreated).toHaveBeenCalledWith(annotation.id);
      expect(flyouts.openExpanded).not.toHaveBeenCalled();
    }
  });

  it('does not let modifier keys bypass orbit mode', () => {
    canvas.emit('mousedown', mouse(10, 10));
    fakeWindow.emit('mouseup', mouse(10, 10));
    canvas.emit('mousedown', { ...mouse(10, 10), ctrlKey: true });
    fakeWindow.emit('mouseup', { ...mouse(10, 10), ctrlKey: true });

    expect(store.list()).toEqual([]);
    expect(controls.enabled).toBe(true);
  });

  it('returns an armed tool to orbit on Escape', () => {
    tool.setMode('annotate');
    expect(body.dataset.markMode).toBe('annotate');

    fakeWindow.emit('keydown', { key: 'Escape', target: null });

    expect(body.dataset.markMode).toBeUndefined();
    expect(modeChanged).toHaveBeenNthCalledWith(1, 'annotate');
    expect(modeChanged).toHaveBeenNthCalledWith(2, 'orbit');
  });

  function performGesture(mode: Exclude<MarkMode, 'orbit'>, drag: boolean): void {
    tool.setMode(mode);
    canvas.emit('mousedown', mouse(10, 10));
    if (drag) {
      fakeWindow.emit('mousemove', mouse(30, 30));
    }
    fakeWindow.emit('mouseup', mouse(drag ? 30 : 10, drag ? 30 : 10));
  }
});
