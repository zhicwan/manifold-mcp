import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  captureDesktopCamera,
  restoreDesktopCamera,
  updateDesktopCameraFrame,
} from '../src/viewer/src/xr/desktop-camera.js';

describe('XR desktop camera preservation', () => {
  it('restores the complete perspective camera and orbit target after XR mutation', () => {
    const camera = new THREE.PerspectiveCamera(47, 1.6, 0.3, 9000);
    camera.position.set(14, -28, 42);
    camera.scale.set(1.1, 1.2, 1.3);
    camera.up.set(0, 0, 1);
    camera.zoom = 1.25;
    camera.focus = 7;
    camera.filmGauge = 38;
    camera.filmOffset = 2;
    camera.setViewOffset(1920, 1080, 10, 20, 1800, 1000);
    const target = new THREE.Vector3(2, 3, 4);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    const expectedProjection = camera.projectionMatrix.clone();
    const state = captureDesktopCamera(camera, target);

    camera.position.set(0, 1.7, 0);
    camera.quaternion.identity();
    camera.scale.setScalar(1);
    camera.up.set(0, 1, 0);
    camera.fov = 90;
    camera.zoom = 1;
    camera.near = 0.01;
    camera.far = 100;
    camera.clearViewOffset();
    target.set(0, 0, -1);

    restoreDesktopCamera(camera, target, state);

    expect(camera.position).toEqual(state.position);
    expect(camera.quaternion.angleTo(state.quaternion)).toBeCloseTo(0);
    expect(camera.scale).toEqual(state.scale);
    expect(camera.up).toEqual(state.up);
    expect(target).toEqual(state.target);
    expect(camera.fov).toBe(47);
    expect(camera.zoom).toBe(1.25);
    expect(camera.focus).toBe(7);
    expect(camera.aspect).toBe(state.aspect);
    expect(camera.near).toBe(0.3);
    expect(camera.far).toBe(9000);
    expect(camera.filmGauge).toBe(38);
    expect(camera.filmOffset).toBe(2);
    expect(camera.view).toEqual(state.view);
    expect(camera.projectionMatrix.equals(expectedProjection)).toBe(true);
  });

  it('updates the saved desktop framing without mutating the live XR camera', () => {
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    camera.position.set(0, 1.7, 0);
    const xrPosition = camera.position.clone();
    const target = new THREE.Vector3();
    const state = captureDesktopCamera(camera, target);
    const desktopPosition = new THREE.Vector3(140, -140, 160);
    const desktopTarget = new THREE.Vector3(10, 20, 30);

    updateDesktopCameraFrame(state, desktopPosition, desktopTarget, 0.5, 5000);

    expect(camera.position).toEqual(xrPosition);
    restoreDesktopCamera(camera, target, state);
    expect(camera.position).toEqual(desktopPosition);
    expect(target).toEqual(desktopTarget);
    expect(camera.near).toBe(0.5);
    expect(camera.far).toBe(5000);
    expect(
      camera.getWorldDirection(new THREE.Vector3()).angleTo(desktopTarget.clone().sub(desktopPosition)),
    ).toBeCloseTo(0);
  });
});
