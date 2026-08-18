import { describe, expect, it } from 'vitest';

import { computeDesktopCameraClipping, XR_CAMERA_CLIPPING } from '../src/viewer/src/scene/camera-clipping.js';

describe('camera clipping policies', () => {
  it('keeps XR clipping in metres regardless of model dimensions', () => {
    expect(XR_CAMERA_CLIPPING).toEqual({ near: 0.01, far: 100 });

    const crocodile = computeDesktopCameraClipping(459.5);
    expect(crocodile.near).toBeCloseTo(0.4595);
    expect(XR_CAMERA_CLIPPING.near).not.toBe(crocodile.near);
  });

  it('derives desktop clipping from millimetre model dimensions', () => {
    expect(computeDesktopCameraClipping(20)).toEqual({ near: 0.02, far: 2000 });
    expect(computeDesktopCameraClipping(5)).toEqual({ near: 0.01, far: 500 });
  });
});
