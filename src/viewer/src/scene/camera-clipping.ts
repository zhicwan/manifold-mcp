export interface CameraClipping {
  near: number;
  far: number;
}

/** WebXR world units are metres, independent of CAD model dimensions. */
export const XR_CAMERA_CLIPPING: Readonly<CameraClipping> = {
  near: 0.01,
  far: 100,
};

/** Desktop scene units are millimetres and scale with the loaded model. */
export function computeDesktopCameraClipping(maxDimensionMm: number): CameraClipping {
  return {
    near: Math.max(maxDimensionMm / 1000, 0.01),
    far: maxDimensionMm * 100,
  };
}
