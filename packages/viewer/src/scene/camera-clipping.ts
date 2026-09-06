export interface CameraClipping {
  near: number;
  far: number;
}

/** Desktop scene units are millimetres and scale with the loaded model. */
export function computeDesktopCameraClipping(maxDimensionMm: number): CameraClipping {
  return {
    near: Math.max(maxDimensionMm / 1000, 0.01),
    far: maxDimensionMm * 100,
  };
}
