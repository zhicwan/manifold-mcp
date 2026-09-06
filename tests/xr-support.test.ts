import { describe, expect, it, vi } from 'vitest';

import { isImmersiveVrSupported, watchImmersiveVrSupport, xrErrorMessage } from '../packages/viewer/src/xr/support.js';

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

  it('rechecks support when XR devices change and removes the listener on cleanup', async () => {
    let supported = false;
    const deviceChangeListeners = new Set<EventListener>();
    const results: boolean[] = [];
    const errors: unknown[] = [];
    const stop = watchImmersiveVrSupport(
      {
        onSupportChange(value) {
          results.push(value);
        },
        onError(error) {
          errors.push(error);
        },
      },
      {
        xr: {
          isSessionSupported() {
            return Promise.resolve(supported);
          },
          addEventListener(_type, listener) {
            deviceChangeListeners.add(listener);
          },
          removeEventListener(_type, listener) {
            deviceChangeListeners.delete(listener);
          },
        },
      },
    );

    await vi.waitFor(() => expect(results).toEqual([false]));
    supported = true;
    for (const listener of deviceChangeListeners) {
      listener(new Event('devicechange'));
    }
    await vi.waitFor(() => expect(results).toEqual([false, true]));

    stop();
    expect(deviceChangeListeners.size).toBe(0);
    expect(errors).toEqual([]);
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
