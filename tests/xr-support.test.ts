import { describe, expect, it } from 'vitest';

import { isImmersiveVrSupported, xrErrorMessage } from '../src/viewer/src/xr/support.js';

describe('WebXR support detection', () => {
  it('returns false when navigator has no XR system', async () => {
    await expect(isImmersiveVrSupported({})).resolves.toBe(false);
  });

  it('probes immersive-vr support', async () => {
    let requestedMode: XRSessionMode | null = null;
    const supported = await isImmersiveVrSupported({
      xr: {
        isSessionSupported(mode) {
          requestedMode = mode;
          return Promise.resolve(true);
        },
      },
    });

    expect(supported).toBe(true);
    expect(requestedMode).toBe('immersive-vr');
  });

  it('propagates probe failures for the UI to surface', async () => {
    const error = new DOMException('blocked', 'SecurityError');
    await expect(
      isImmersiveVrSupported({
        xr: {
          isSessionSupported() {
            return Promise.reject(error);
          },
        },
      }),
    ).rejects.toBe(error);
  });
});

describe('WebXR error messages', () => {
  it('explains denied session requests', () => {
    expect(xrErrorMessage(new DOMException('denied', 'NotAllowedError'))).toMatch(/not allowed/i);
  });

  it('keeps useful implementation errors', () => {
    expect(xrErrorMessage(new Error('runtime unavailable'))).toBe('Unable to enter VR: runtime unavailable');
  });
});
