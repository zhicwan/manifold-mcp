export interface XrSystemProbe {
  isSessionSupported(mode: XRSessionMode): Promise<boolean>;
}

export interface XrNavigatorProbe {
  xr?: XrSystemProbe;
}

export async function isImmersiveVrSupported(
  nav: XrNavigatorProbe = navigator as Navigator & XrNavigatorProbe,
): Promise<boolean> {
  if (!nav.xr) {
    return false;
  }
  return nav.xr.isSessionSupported('immersive-vr');
}

export function xrErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'VR access was not allowed. Check the browser and headset permission prompt.';
    }
    if (error.name === 'NotSupportedError') {
      return 'This browser or connected headset cannot start an immersive VR session.';
    }
    if (error.name === 'InvalidStateError') {
      return 'A VR session is already active or still shutting down.';
    }
  }
  if (error instanceof Error && error.message) {
    return `Unable to enter VR: ${error.message}`;
  }
  return 'Unable to enter VR.';
}
