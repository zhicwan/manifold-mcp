import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type {
  ViewerAnimationFrame,
  ViewerModelFraming,
  ViewerSceneRuntime,
} from '../packages/viewer/src/scene/runtime.js';
import { acquireXrRendererOwnership } from '../packages/viewer/src/xr/renderer-ownership.js';
import { XrRuntime, xrRuntimeTestHooks, type XrRuntimeNavigator } from '../packages/viewer/src/xr/xr-runtime.js';

describe('XrRuntime leaf-context lifecycle', () => {
  it('restores updated desktop framing and removes hooks, listeners, and controllers', async () => {
    const sessionTarget = new EventTarget();
    const session = Object.assign(sessionTarget, {
      end: vi.fn(() => {
        sessionTarget.dispatchEvent(new Event('end'));
        return Promise.resolve();
      }),
    }) as unknown as XRSession;
    const controllerGroups = [new THREE.Group(), new THREE.Group()];
    const gripGroups = [new THREE.Group(), new THREE.Group()];
    const managerListeners = new Set<EventListener>();
    let managerSession: XRSession | null = null;
    const xrManager = {
      enabled: false,
      isPresenting: false,
      setReferenceSpaceType: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListener) => managerListeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => managerListeners.delete(listener)),
      getController: (index: number) => controllerGroups[index]!,
      getControllerGrip: (index: number) => gripGroups[index]!,
      setSession: vi.fn((next: XRSession) => {
        managerSession = next;
        xrManager.isPresenting = true;
        return Promise.resolve();
      }),
      getSession: () => managerSession,
      getReferenceSpace: () => null,
    };
    const renderer = { xr: xrManager } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.2, 5000);
    camera.position.set(80, -80, 120);
    const modelRoot = new THREE.Group();
    modelRoot.position.set(3, 4, 5);
    scene.add(modelRoot);
    const controls = {
      enabled: true,
      target: new THREE.Vector3(),
      update: vi.fn(),
    } as unknown as OrbitControls;
    const removeAnimationHook = vi.fn();
    const removeModelHook = vi.fn();
    const modelHook: { current: ((framing: ViewerModelFraming) => void) | null } = { current: null };
    const initialFraming = framing([0, 0, 0], [80, -80, 120], [0, 0, 0]);
    const immersiveStates: boolean[] = [];
    const decorationStates: boolean[] = [];
    const sessionStates: boolean[] = [];
    const presentationStates: string[] = [];
    const runtime: ViewerSceneRuntime = {
      renderer,
      scene,
      camera,
      controls,
      modelRoot,
      getMesh: () => null,
      getModelFraming: () => initialFraming,
      addAnimationFrameHook(_hook: (frame: ViewerAnimationFrame) => void) {
        return removeAnimationHook;
      },
      addModelChangeHook(hook, emitCurrent) {
        modelHook.current = hook;
        if (emitCurrent) {
          hook(initialFraming);
        }
        return removeModelHook;
      },
      setImmersivePresenting: state => immersiveStates.push(state),
      setDesktopDecorationsVisible: state => decorationStates.push(state),
      setModelPresentationState: state => presentationStates.push(state),
      requestRender: vi.fn(),
    };
    const deviceListeners = new Set<EventListener>();
    const xrSystem = {
      isSessionSupported: vi.fn(() => Promise.resolve(true)),
      requestSession: vi.fn(() => Promise.resolve(session)),
      addEventListener: vi.fn((_type: string, listener: EventListener) => deviceListeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => deviceListeners.delete(listener)),
    } as unknown as XRSystem;
    const nav = { xr: xrSystem } as XrRuntimeNavigator;
    const supportChanges: boolean[] = [];
    const ownership = await acquireXrRendererOwnership(renderer).acquired;
    if (!ownership) {
      throw new Error('Expected XR renderer ownership.');
    }
    const runtimeInstance = new XrRuntime({
      runtime,
      ownership,
      navigator: nav,
      onSupportChange: supported => supportChanges.push(supported),
      onSupportError: vi.fn(),
      onRuntimeError: vi.fn(),
      onSessionStateChange: active => sessionStates.push(active),
    });

    await vi.waitFor(() => expect(supportChanges).toEqual([true]));
    expect(scene.children).toHaveLength(5);
    await runtimeInstance.enter();
    expect(immersiveStates).toEqual([true]);
    expect(decorationStates).toEqual([false]);
    expect(sessionStates).toEqual([true]);

    const updatedFraming = framing([10, 20, 30], [140, -140, 160], [10, 20, 30]);
    modelHook.current?.(updatedFraming);
    const firstDispose = runtimeInstance.dispose();
    const secondDispose = runtimeInstance.dispose();
    expect(firstDispose).toBe(secondDispose);
    await firstDispose;

    expect(camera.position.toArray()).toEqual([140, -140, 160]);
    expect(controls.target.toArray()).toEqual([10, 20, 30]);
    expect(camera.near).toBe(updatedFraming.desktopCamera.near);
    expect(camera.far).toBe(updatedFraming.desktopCamera.far);
    expect(modelRoot.position.toArray()).toEqual([3, 4, 5]);
    expect(modelRoot.visible).toBe(true);
    expect(immersiveStates).toEqual([true, false]);
    expect(decorationStates).toEqual([false, true]);
    expect(sessionStates).toEqual([true, false]);
    expect(presentationStates).toEqual([]);
    expect(removeAnimationHook).toHaveBeenCalledOnce();
    expect(removeModelHook).toHaveBeenCalledOnce();
    expect(deviceListeners.size).toBe(0);
    expect(managerListeners.size).toBe(0);
    expect(xrManager.enabled).toBe(false);
    expect(scene.children).toEqual([modelRoot, controllerGroups[0], gripGroups[0], controllerGroups[1], gripGroups[1]]);
    expect(controllerGroups.map(controller => controller.children.length)).toEqual([0, 0]);
  });

  it('releases ownership before a pending session request resolves and ends the late session', async () => {
    const request = deferred<XRSession>();
    const fixture = await createPendingRuntimeFixture(request.promise);
    const lateSession = Object.assign(new EventTarget(), {
      end: vi.fn(() => Promise.resolve()),
    }) as unknown as XRSession;
    const enterPromise = fixture.runtime.enter();
    const ticket = xrRuntimeTestHooks.pendingSessionRequest(fixture.runtime);
    expect(ticket?.isAttached()).toBe(true);

    const disposePromise = fixture.runtime.dispose();
    expect(ticket?.isAttached()).toBe(false);
    await disposePromise;
    const replacement = await acquireXrRendererOwnership(fixture.renderer).acquired;
    expect(replacement?.isCurrent()).toBe(true);
    fixture.xrManager.enabled = true;
    expect(fixture.xrManager.setSession).not.toHaveBeenCalled();

    request.resolve(lateSession);
    await expect(enterPromise).rejects.toThrow(/disposed while VR was starting/i);

    expect(lateSession.end).toHaveBeenCalledOnce();
    expect(fixture.xrManager.setSession).not.toHaveBeenCalled();
    expect(fixture.xrManager.enabled).toBe(true);
    expect(fixture.onRuntimeError).not.toHaveBeenCalled();
    replacement?.release();
  });

  it('observes a late pending session request rejection after disposal', async () => {
    const request = deferred<XRSession>();
    const fixture = await createPendingRuntimeFixture(request.promise);
    const enterPromise = fixture.runtime.enter();

    await fixture.runtime.dispose();
    request.reject(new Error('late denial'));
    await expect(enterPromise).rejects.toThrow('late denial');
    await vi.waitFor(() => expect(fixture.onRuntimeError).toHaveBeenCalledOnce());
    expect(fixture.onRuntimeError.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: 'XR session request rejected after runtime disposal.' }),
    );
  });
});

function framing(
  center: readonly [number, number, number],
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): ViewerModelFraming {
  return {
    center,
    maxDimension: 100,
    desktopCamera: {
      position,
      target,
      near: 0.1,
      far: 10_000,
    },
  };
}

async function createPendingRuntimeFixture(sessionRequest: Promise<XRSession>) {
  const controllerGroups = [new THREE.Group(), new THREE.Group()];
  const gripGroups = [new THREE.Group(), new THREE.Group()];
  const xrManager = {
    enabled: false,
    isPresenting: false,
    setReferenceSpaceType: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getController: (index: number) => controllerGroups[index]!,
    getControllerGrip: (index: number) => gripGroups[index]!,
    setSession: vi.fn(() => Promise.resolve()),
    getSession: () => null,
    getReferenceSpace: () => null,
  };
  const renderer = { xr: xrManager } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const modelRoot = new THREE.Group();
  scene.add(modelRoot);
  const controls = {
    enabled: true,
    target: new THREE.Vector3(),
    update: vi.fn(),
  } as unknown as OrbitControls;
  const runtimeContext: ViewerSceneRuntime = {
    renderer,
    scene,
    camera,
    controls,
    modelRoot,
    getMesh: () => null,
    getModelFraming: () => null,
    addAnimationFrameHook: () => () => undefined,
    addModelChangeHook: () => () => undefined,
    setImmersivePresenting: () => undefined,
    setDesktopDecorationsVisible: () => undefined,
    setModelPresentationState: () => undefined,
    requestRender: () => undefined,
  };
  const xrSystem = {
    isSessionSupported: () => Promise.resolve(true),
    requestSession: () => sessionRequest,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as XRSystem;
  const ownership = await acquireXrRendererOwnership(renderer).acquired;
  if (!ownership) {
    throw new Error('Expected XR renderer ownership.');
  }
  const onRuntimeError = vi.fn();
  const runtime = new XrRuntime({
    runtime: runtimeContext,
    ownership,
    navigator: { xr: xrSystem },
    onSupportChange: () => undefined,
    onSupportError: () => undefined,
    onRuntimeError,
    onSessionStateChange: () => undefined,
  });
  return { runtime, renderer, xrManager, onRuntimeError };
}

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
