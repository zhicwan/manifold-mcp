export interface XrSystemProbe {
  isSessionSupported(mode: XRSessionMode): Promise<boolean>;
  addEventListener?(type: 'devicechange', listener: EventListener): void;
  removeEventListener?(type: 'devicechange', listener: EventListener): void;
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

export interface XrSupportObserver {
  onSupportChange(supported: boolean): void;
  onError(error: unknown): void;
}

export function watchImmersiveVrSupport(
  observer: XrSupportObserver,
  nav: XrNavigatorProbe = navigator as Navigator & XrNavigatorProbe,
): () => void {
  let stopped = false;
  let probeVersion = 0;
  const probe = (): void => {
    const version = ++probeVersion;
    void isImmersiveVrSupported(nav).then(
      supported => {
        if (!stopped && version === probeVersion) {
          observer.onSupportChange(supported);
        }
      },
      error => {
        if (!stopped && version === probeVersion) {
          observer.onError(error);
        }
      },
    );
  };
  const handleDeviceChange: EventListener = () => probe();

  nav.xr?.addEventListener?.('devicechange', handleDeviceChange);
  probe();
  return () => {
    stopped = true;
    nav.xr?.removeEventListener?.('devicechange', handleDeviceChange);
  };
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
