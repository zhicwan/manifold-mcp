import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { ViewerModelFraming, ViewerSceneRuntime } from '../scene/runtime.js';
import { XR_CAMERA_CLIPPING } from './camera-clipping.js';
import { GrabStateMachine } from './grab-state.js';
import {
  applyTransform,
  captureTransform,
  computeGrabbedTransform,
  computeXrHomeTransform,
  computeXrViewingDistance,
  easeOutCubic,
  interpolateTransform,
  type ObjectTransform,
} from './model-placement.js';
import {
  captureDesktopCamera,
  restoreDesktopCamera,
  updateDesktopCameraFrame as updateSavedDesktopCameraFrame,
  type DesktopCameraState,
} from './desktop-camera.js';
import type { XrRendererOwnership } from './renderer-ownership.js';
import { watchImmersiveVrSupport, type XrNavigatorProbe, type XrSupportObserver } from './support.js';

type TargetRay = ReturnType<THREE.WebXRManager['getController']>;
type GripSpace = ReturnType<THREE.WebXRManager['getControllerGrip']>;

interface ControllerBinding {
  index: number;
  controller: TargetRay;
  grip: GripSpace;
  ray: THREE.Line;
  rayMaterial: THREE.LineBasicMaterial;
  reticle: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  source: XRInputSource | null;
  usable: boolean;
  hitDistance: number | null;
  removeListeners: Array<() => void>;
}

interface ReturnAnimation {
  from: ObjectTransform;
  startedAt: number | null;
}

interface GrabAnimation {
  from: ObjectTransform;
  to: ObjectTransform;
  startedAt: number | null;
}

export interface XrRuntimeOptions {
  runtime: ViewerSceneRuntime;
  ownership: XrRendererOwnership;
  navigator?: XrRuntimeNavigator;
  onSupportChange(supported: boolean): void;
  onSupportError(error: unknown): void;
  onRuntimeError(error: unknown): void;
  onSessionStateChange(active: boolean): void;
}

export interface XrRuntimeNavigator extends XrNavigatorProbe {
  xr?: XRSystem;
}

const MAX_RAY_METERS = 5;
const GRAB_DURATION_MS = 160;
const RETURN_DURATION_MS = 280;
const RAY_IDLE = 0xd4d4d8;
const RAY_HIT = 0x2dd4bf;
const RAY_LOCKED = 0xf59e0b;

class XrRuntimeDisposedDuringEntryError extends Error {
  constructor() {
    super('The viewer was disposed while VR was starting.');
    this.name = 'XrRuntimeDisposedDuringEntryError';
  }
}

const continuePendingSessionRequest = Symbol('continuePendingSessionRequest');
const completePendingSessionRequest = Symbol('completePendingSessionRequest');

interface PendingSessionRequestTicket {
  runtime: XrRuntime | null;
  requestPending: boolean;
  lateRejectionReported: boolean;
  readonly onRuntimeError: (error: unknown) => void;
}

export class XrRuntime {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly modelRoot: THREE.Group;
  private readonly runtime: ViewerSceneRuntime;
  private readonly ownership: XrRendererOwnership;
  private readonly navigator: XrRuntimeNavigator;
  private readonly onSupportChange: (supported: boolean) => void;
  private readonly onSupportError: (error: unknown) => void;
  private readonly onRuntimeError: (error: unknown) => void;
  private readonly onSessionStateChange: (active: boolean) => void;
  private readonly removeAnimationFrameHook: () => void;
  private readonly removeModelChangeHook: () => void;
  private readonly stopWatchingSupport: () => void;
  private readonly raycaster = new THREE.Raycaster();
  private readonly controllers: ControllerBinding[];
  private readonly grab = new GrabStateMachine();

  private active = false;
  private entering = false;
  private enterPromise: Promise<void> | null = null;
  private pendingSessionRequest: PendingSessionRequestTicket | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private session: XRSession | null = null;
  private modelCenterMm = new THREE.Vector3();
  private modelViewingDistanceMeters = 1;
  private homeTransform: ObjectTransform | null = null;
  private initialViewerPosition: THREE.Vector3 | null = null;
  private initialViewerOrientation: THREE.Quaternion | null = null;
  private grabAnimation: GrabAnimation | null = null;
  private returnAnimation: ReturnAnimation | null = null;
  private desktopTransform: ObjectTransform | null = null;
  private desktopCamera: DesktopCameraState | null = null;
  private desktopVisible = true;
  private desktopControlsEnabled = true;
  private desktopPrepared = false;
  private modelHighlight: 'idle' | 'hover' | 'held' = 'idle';

  constructor(options: XrRuntimeOptions) {
    this.runtime = options.runtime;
    this.ownership = options.ownership;
    this.renderer = options.runtime.renderer;
    this.scene = options.runtime.scene;
    this.camera = options.runtime.camera;
    this.controls = options.runtime.controls;
    this.modelRoot = options.runtime.modelRoot;
    this.navigator = options.navigator ?? (navigator as Navigator & XrRuntimeNavigator);
    this.onSupportChange = options.onSupportChange;
    this.onSupportError = options.onSupportError;
    this.onRuntimeError = options.onRuntimeError;
    this.onSessionStateChange = options.onSessionStateChange;

    if (!this.ownership.isCurrent()) {
      throw new Error('XR renderer ownership was released before runtime initialization.');
    }
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.renderer.xr.addEventListener('sessionend', this.handleSessionEnd);
    this.controllers = [0, 1].map(index => this.createController(index));
    this.removeAnimationFrameHook = this.runtime.addAnimationFrameHook(frame =>
      this.update(frame.time, frame.opaqueFrame),
    );
    this.removeModelChangeHook = this.runtime.addModelChangeHook(framing => this.onModelChanged(framing), true);
    const supportObserver: XrSupportObserver = {
      onSupportChange: supported => this.onSupportChange(supported),
      onError: error => this.onSupportError(error),
    };
    this.stopWatchingSupport = watchImmersiveVrSupport(supportObserver, this.navigator);
  }

  enter(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('The viewer has already been disposed.'));
    }
    if (this.active || this.entering || this.session) {
      return Promise.reject(new DOMException('An immersive session is already active.', 'InvalidStateError'));
    }
    const xr = this.navigator.xr;
    if (!xr) {
      return Promise.reject(new DOMException('WebXR is not available.', 'NotSupportedError'));
    }

    let sessionRequest: Promise<XRSession>;
    try {
      sessionRequest = xr.requestSession('immersive-vr');
    } catch (error) {
      return Promise.reject(error);
    }
    this.entering = true;
    const ticket: PendingSessionRequestTicket = {
      runtime: this,
      requestPending: true,
      lateRejectionReported: false,
      onRuntimeError: this.onRuntimeError,
    };
    this.pendingSessionRequest = ticket;
    const enterPromise = startPendingSessionRequest(sessionRequest, ticket);
    this.enterPromise = enterPromise;
    return enterPromise;
  }

  [continuePendingSessionRequest](session: XRSession): Promise<void> {
    return this.attachSession(session);
  }

  [completePendingSessionRequest](ticket: PendingSessionRequestTicket): void {
    if (this.pendingSessionRequest !== ticket) {
      return;
    }
    this.pendingSessionRequest = null;
    this.enterPromise = null;
    this.entering = false;
  }

  private async attachSession(session: XRSession): Promise<void> {
    let prepared = false;
    try {
      this.prepareDesktopForXr();
      prepared = true;
      this.session = session;
      await this.renderer.xr.setSession(session);
      if (this.disposed || !this.renderer.xr.isPresenting) {
        await session.end();
        throw new Error('The VR session ended before the viewer became active.');
      }
      this.active = true;
      this.onSessionStateChange(true);
      this.runtime.requestRender();
    } catch (error) {
      this.session = null;
      if (prepared) {
        this.restoreDesktop();
      }
      try {
        await session.end();
      } catch {
        // The setup error remains the actionable failure; the browser may
        // already have torn down the partially-created session.
      }
      throw error;
    }
  }

  private update(time: number, opaqueFrame: unknown): void {
    if (!this.active) {
      return;
    }
    const frame = opaqueFrame as XRFrame | undefined;
    if (!this.homeTransform && frame) {
      this.placeFromViewerPose(frame);
    }
    this.updateGrabAnimation(time);
    this.updateReturnAnimation(time);
    this.updateControllerRays();
  }

  private onModelChanged(framing: ViewerModelFraming): void {
    this.modelCenterMm.fromArray(framing.center);
    this.modelViewingDistanceMeters = computeXrViewingDistance(framing.maxDimension);
    if (this.desktopCamera) {
      updateSavedDesktopCameraFrame(
        this.desktopCamera,
        new THREE.Vector3().fromArray(framing.desktopCamera.position),
        new THREE.Vector3().fromArray(framing.desktopCamera.target),
        framing.desktopCamera.near,
        framing.desktopCamera.far,
      );
    }
    if (!this.active) {
      return;
    }
    this.cancelInteraction();
    if (this.initialViewerPosition && this.initialViewerOrientation) {
      this.homeTransform = computeXrHomeTransform(
        this.modelCenterMm,
        this.initialViewerPosition,
        this.initialViewerOrientation,
        this.modelViewingDistanceMeters,
      );
      applyTransform(this.modelRoot, this.homeTransform);
      this.modelRoot.visible = true;
    } else {
      this.homeTransform = null;
      this.modelRoot.visible = false;
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    const pendingSessionRequest = this.pendingSessionRequest;
    if (pendingSessionRequest?.requestPending) {
      pendingSessionRequest.runtime = null;
      this.pendingSessionRequest = null;
      const detachedEnter = this.enterPromise;
      this.enterPromise = null;
      this.entering = false;
      if (detachedEnter) {
        void detachedEnter.catch(ignorePromiseRejection);
      }
    }
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  private async finishDispose(): Promise<void> {
    this.stopWatchingSupport();
    this.removeAnimationFrameHook();
    this.removeModelChangeHook();
    try {
      const pendingEnter = this.enterPromise;
      if (pendingEnter) {
        await Promise.allSettled([pendingEnter]);
      }
      const activeSession = this.session;
      if (activeSession) {
        await this.endSession(activeSession);
      }
    } finally {
      try {
        this.active = false;
        this.session = null;
        this.restoreDesktop();
        this.renderer.xr.removeEventListener('sessionend', this.handleSessionEnd);
        for (const binding of this.controllers) {
          for (const remove of binding.removeListeners) {
            remove();
          }
          binding.controller.remove(binding.ray, binding.reticle);
          binding.ray.geometry.dispose();
          binding.rayMaterial.dispose();
          binding.reticle.geometry.dispose();
          binding.reticle.material.dispose();
        }
        if (this.ownership.isCurrent()) {
          this.renderer.xr.enabled = false;
        }
      } finally {
        this.ownership.release();
      }
    }
  }

  private createController(index: number): ControllerBinding {
    const controller = this.renderer.xr.getController(index);
    const grip = this.renderer.xr.getControllerGrip(index);

    const rayGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const rayMaterial = new THREE.LineBasicMaterial({ color: RAY_IDLE });
    const ray = new THREE.Line(rayGeometry, rayMaterial);
    ray.scale.z = MAX_RAY_METERS;
    ray.visible = false;
    controller.add(ray);

    const reticleMaterial = new THREE.MeshBasicMaterial({
      color: RAY_HIT,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.008, 0.014, 24), reticleMaterial);
    reticle.renderOrder = 1000;
    reticle.visible = false;
    controller.add(reticle);

    const binding: ControllerBinding = {
      index,
      controller,
      grip,
      ray,
      rayMaterial,
      reticle,
      source: null,
      usable: false,
      hitDistance: null,
      removeListeners: [],
    };

    const onConnected = (event: { data: XRInputSource }): void => {
      binding.source = event.data;
      binding.usable = event.data.targetRayMode === 'tracked-pointer' && event.data.gripSpace !== undefined;
      this.resetRay(binding);
    };
    const onDisconnected = (): void => {
      if (this.grab.getOwner() === index) {
        this.startReturn(index);
      }
      binding.source = null;
      binding.usable = false;
      this.resetRay(binding);
    };
    const onSqueezeStart = (): void => this.startGrab(binding);
    const onSqueezeEnd = (): void => this.startReturn(index);

    controller.addEventListener('connected', onConnected);
    controller.addEventListener('disconnected', onDisconnected);
    controller.addEventListener('squeezestart', onSqueezeStart);
    controller.addEventListener('squeezeend', onSqueezeEnd);
    binding.removeListeners.push(
      () => controller.removeEventListener('connected', onConnected),
      () => controller.removeEventListener('disconnected', onDisconnected),
      () => controller.removeEventListener('squeezestart', onSqueezeStart),
      () => controller.removeEventListener('squeezeend', onSqueezeEnd),
    );

    this.scene.add(controller);
    this.scene.add(grip);
    return binding;
  }

  private prepareDesktopForXr(): void {
    this.desktopTransform = captureTransform(this.modelRoot);
    this.desktopCamera = captureDesktopCamera(this.camera, this.controls.target);
    this.desktopVisible = this.modelRoot.visible;
    this.desktopControlsEnabled = this.controls.enabled;
    this.desktopPrepared = true;

    this.runtime.setImmersivePresenting(true);
    this.controls.enabled = false;
    this.camera.near = XR_CAMERA_CLIPPING.near;
    this.camera.far = XR_CAMERA_CLIPPING.far;
    this.camera.updateProjectionMatrix();
    this.runtime.setDesktopDecorationsVisible(false);

    this.homeTransform = null;
    this.initialViewerPosition = null;
    this.initialViewerOrientation = null;
    this.modelRoot.visible = false;
    this.grab.reset();
    this.grabAnimation = null;
    this.returnAnimation = null;
  }

  private restoreDesktop(): void {
    if (!this.desktopPrepared) {
      return;
    }
    this.cancelInteraction();
    if (this.desktopTransform) {
      applyTransform(this.modelRoot, this.desktopTransform);
      this.modelRoot.visible = this.desktopVisible;
      this.desktopTransform = null;
    }
    if (this.desktopCamera) {
      restoreDesktopCamera(this.camera, this.controls.target, this.desktopCamera);
      this.desktopCamera = null;
    }
    this.controls.enabled = this.desktopControlsEnabled;
    this.controls.update();
    this.runtime.setDesktopDecorationsVisible(true);
    this.runtime.setImmersivePresenting(false);
    this.homeTransform = null;
    this.initialViewerPosition = null;
    this.initialViewerOrientation = null;
    for (const binding of this.controllers) {
      this.resetRay(binding);
    }
    this.desktopPrepared = false;
    this.onSessionStateChange(false);
    this.runtime.requestRender();
  }

  private async endSession(session: XRSession): Promise<void> {
    if (this.renderer.xr.getSession() !== session) {
      return;
    }

    let resolveEnded: () => void;
    const ended = new Promise<void>(resolve => {
      resolveEnded = resolve;
    });
    const handleEnd = (): void => resolveEnded();
    session.addEventListener('end', handleEnd, { once: true });
    try {
      let alreadyEnded = false;
      try {
        await session.end();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
          throw error;
        }
        alreadyEnded = true;
      }
      if (!alreadyEnded && this.renderer.xr.getSession() === session) {
        await ended;
      }
    } finally {
      session.removeEventListener('end', handleEnd);
    }
  }

  private placeFromViewerPose(frame: XRFrame): void {
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) {
      return;
    }
    const pose = frame.getViewerPose(referenceSpace);
    if (!pose) {
      return;
    }
    const transform = pose.transform;
    this.initialViewerPosition = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z);
    this.initialViewerOrientation = new THREE.Quaternion(
      transform.orientation.x,
      transform.orientation.y,
      transform.orientation.z,
      transform.orientation.w,
    );
    this.homeTransform = computeXrHomeTransform(
      this.modelCenterMm,
      this.initialViewerPosition,
      this.initialViewerOrientation,
      this.modelViewingDistanceMeters,
    );
    applyTransform(this.modelRoot, this.homeTransform);
    this.modelRoot.visible = true;
  }

  private updateControllerRays(): void {
    const mesh = this.runtime.getMesh();
    const returning = this.grab.getPhase() === 'returning';
    let anyHover = false;

    for (const binding of this.controllers) {
      if (!mesh || !this.homeTransform || !binding.usable) {
        this.resetRay(binding);
        continue;
      }
      if (this.grab.getOwner() === binding.index) {
        binding.hitDistance = null;
        binding.ray.visible = false;
        binding.reticle.visible = false;
        binding.rayMaterial.color.setHex(RAY_LOCKED);
        continue;
      }
      if (returning) {
        binding.hitDistance = null;
        binding.ray.visible = true;
        binding.ray.scale.z = MAX_RAY_METERS;
        binding.rayMaterial.color.setHex(RAY_IDLE);
        binding.reticle.visible = false;
        continue;
      }

      binding.controller.updateMatrixWorld(true);
      this.raycaster.setFromXRController(binding.controller);
      const hit = this.raycaster.intersectObject(mesh, false)[0];
      binding.ray.visible = true;
      binding.hitDistance = hit?.distance ?? null;

      if (hit) {
        anyHover = true;
        binding.ray.scale.z = hit.distance;
        binding.rayMaterial.color.setHex(RAY_HIT);
        binding.reticle.position.set(0, 0, -hit.distance);
        binding.reticle.visible = true;
      } else {
        binding.ray.scale.z = MAX_RAY_METERS;
        binding.rayMaterial.color.setHex(RAY_IDLE);
        binding.reticle.visible = false;
      }
    }

    this.setModelHighlight(this.grab.getPhase() === 'grabbed' ? 'held' : anyHover ? 'hover' : 'idle');
  }

  private startGrab(binding: ControllerBinding): void {
    if (
      !this.active ||
      !this.homeTransform ||
      !binding.usable ||
      binding.hitDistance === null ||
      !this.grab.tryGrab(binding.index)
    ) {
      return;
    }
    const mesh = this.runtime.getMesh();
    if (!mesh) {
      this.grab.reset();
      return;
    }
    binding.controller.updateMatrixWorld(true);
    this.raycaster.setFromXRController(binding.controller);
    const hit = this.raycaster.intersectObject(mesh, false)[0];
    if (!hit) {
      this.grab.reset();
      return;
    }
    this.scene.updateMatrixWorld(true);
    const grabPointLocal = this.modelRoot.worldToLocal(hit.point.clone());
    binding.grip.updateMatrixWorld(true);
    binding.grip.attach(this.modelRoot);
    const from = captureTransform(this.modelRoot);
    this.grabAnimation = {
      from,
      to: computeGrabbedTransform(from, grabPointLocal),
      startedAt: null,
    };
    binding.ray.visible = false;
    binding.reticle.visible = false;
    this.setModelHighlight('held');
  }

  private startReturn(controllerIndex: number): void {
    if (!this.homeTransform || !this.grab.release(controllerIndex)) {
      return;
    }
    this.scene.attach(this.modelRoot);
    this.grabAnimation = null;
    this.returnAnimation = {
      from: captureTransform(this.modelRoot),
      startedAt: null,
    };
    this.setModelHighlight('idle');
  }

  private updateGrabAnimation(time: number): void {
    if (!this.grabAnimation || this.grab.getPhase() !== 'grabbed') {
      return;
    }
    this.grabAnimation.startedAt ??= time;
    const progress = (time - this.grabAnimation.startedAt) / GRAB_DURATION_MS;
    if (progress >= 1) {
      applyTransform(this.modelRoot, this.grabAnimation.to);
      this.grabAnimation = null;
      return;
    }
    interpolateTransform(this.modelRoot, this.grabAnimation.from, this.grabAnimation.to, easeOutCubic(progress));
  }

  private updateReturnAnimation(time: number): void {
    if (!this.returnAnimation || !this.homeTransform) {
      return;
    }
    this.returnAnimation.startedAt ??= time;
    const progress = (time - this.returnAnimation.startedAt) / RETURN_DURATION_MS;
    if (progress >= 1) {
      applyTransform(this.modelRoot, this.homeTransform);
      this.returnAnimation = null;
      this.grab.finishReturn();
      return;
    }
    interpolateTransform(this.modelRoot, this.returnAnimation.from, this.homeTransform, easeOutCubic(progress));
  }

  private cancelInteraction(): void {
    if (this.modelRoot.parent !== this.scene) {
      this.scene.attach(this.modelRoot);
    }
    this.grab.reset();
    this.grabAnimation = null;
    this.returnAnimation = null;
    this.setModelHighlight('idle');
  }

  private resetRay(binding: ControllerBinding): void {
    binding.hitDistance = null;
    binding.ray.scale.z = MAX_RAY_METERS;
    binding.rayMaterial.color.setHex(RAY_IDLE);
    binding.ray.visible = this.active && binding.usable;
    binding.reticle.visible = false;
  }

  private setModelHighlight(state: 'idle' | 'hover' | 'held'): void {
    if (this.modelHighlight === state) {
      return;
    }
    this.modelHighlight = state;
    this.runtime.setModelPresentationState(state);
  }

  private readonly handleSessionEnd = (): void => {
    this.active = false;
    this.session = null;
    this.restoreDesktop();
  };
}

function startPendingSessionRequest(
  sessionRequest: Promise<XRSession>,
  ticket: PendingSessionRequestTicket,
): Promise<void> {
  return sessionRequest
    .then(
      session => continueSessionRequest(ticket, session),
      error => rejectSessionRequest(ticket, error),
    )
    .finally(() => finishSessionRequest(ticket));
}

async function continueSessionRequest(ticket: PendingSessionRequestTicket, session: XRSession): Promise<void> {
  ticket.requestPending = false;
  const runtime = ticket.runtime;
  if (!runtime) {
    await endDetachedSession(session, ticket.onRuntimeError);
    throw new XrRuntimeDisposedDuringEntryError();
  }
  await runtime[continuePendingSessionRequest](session);
}

function rejectSessionRequest(ticket: PendingSessionRequestTicket, error: unknown): never {
  ticket.requestPending = false;
  if (!ticket.runtime && !ticket.lateRejectionReported) {
    ticket.lateRejectionReported = true;
    ticket.onRuntimeError(
      new Error('XR session request rejected after runtime disposal.', {
        cause: error,
      }),
    );
  }
  throw error;
}

function finishSessionRequest(ticket: PendingSessionRequestTicket): void {
  const runtime = ticket.runtime;
  ticket.runtime = null;
  runtime?.[completePendingSessionRequest](ticket);
}

async function endDetachedSession(session: XRSession, onRuntimeError: (error: unknown) => void): Promise<void> {
  try {
    await session.end();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
      onRuntimeError(
        new Error('Failed to end a session returned after XR disposal.', {
          cause: error,
        }),
      );
    }
  }
}

const ignorePromiseRejection = (): undefined => undefined;
