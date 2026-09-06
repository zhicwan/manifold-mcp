import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { AnnotationStore } from '../../packages/viewer/src/marks/annotation-store.js';
import { updatePositions } from '../../packages/viewer/src/marks/flyout/flyout-projection.js';

interface FakeStyle {
  display: string;
  transform: string;
}

function fakeElement(): { style: FakeStyle } {
  return { style: { display: '', transform: '' } };
}

function makeCamera(): THREE.PerspectiveCamera {
  // Camera at z=5 looking at origin. With default fov/aspect/near/far, a
  // point at the origin lands dead-centre and is in front of the camera.
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('updatePositions', () => {
  it('places an anchor at the origin in the centre of the screen', () => {
    const store = new AnnotationStore();
    const ann = store.addComment({
      kind: 'point',
      worldCoord: [0, 0, 0],
      anchorWorld: [0, 0, 0],
      triIds: [],
      note: '',
    });
    const el = fakeElement();
    const elements = new Map<string, HTMLElement>([[ann.id, el as unknown as HTMLElement]]);

    updatePositions(makeCamera(), store, elements, { x: 800, y: 600 });

    expect(el.style.display).toBe('');
    // Center of the screen → translate(400, 300)
    expect(el.style.transform).toMatch(/^translate\(400(\.\d+)?px,\s*300(\.\d+)?px\)$/);
  });

  it('hides anchors that project behind the camera', () => {
    const store = new AnnotationStore();
    // Behind the camera (camera at z=5 looks down -z, so positive z way
    // beyond the camera lies behind).
    const ann = store.addComment({
      kind: 'point',
      worldCoord: [0, 0, 50],
      anchorWorld: [0, 0, 50],
      triIds: [],
      note: '',
    });
    const el = fakeElement();
    el.style.display = '';
    const elements = new Map<string, HTMLElement>([[ann.id, el as unknown as HTMLElement]]);

    updatePositions(makeCamera(), store, elements, { x: 800, y: 600 });

    expect(el.style.display).toBe('none');
  });

  it('skips elements whose annotation no longer exists in the store', () => {
    const store = new AnnotationStore();
    const el = fakeElement();
    el.style.display = 'preserved';
    el.style.transform = 'preserved';
    const elements = new Map<string, HTMLElement>([['ghost', el as unknown as HTMLElement]]);

    updatePositions(makeCamera(), store, elements, { x: 800, y: 600 });

    expect(el.style.display).toBe('preserved');
    expect(el.style.transform).toBe('preserved');
  });
});
