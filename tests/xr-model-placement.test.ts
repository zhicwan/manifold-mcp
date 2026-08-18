import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  applyTransform,
  computeGrabbedTransform,
  computeXrHomeTransform,
  computeXrViewingDistance,
  easeOutCubic,
  interpolateTransform,
} from '../src/viewer/src/xr/model-placement.js';

const EPSILON = 1e-6;

describe('XR model placement', () => {
  it('keeps small models at one meter and backs away from world-scale models', () => {
    expect(computeXrViewingDistance(400)).toBe(1);
    expect(computeXrViewingDistance(2400)).toBe(3);
  });

  it('places the model center one meter forward at true millimeter scale', () => {
    const centerMm = new THREE.Vector3(20, -10, 40);
    const home = computeXrHomeTransform(centerMm, new THREE.Vector3(), new THREE.Quaternion());
    const transformedCenter = centerMm.clone().multiply(home.scale).applyQuaternion(home.quaternion).add(home.position);

    expect(home.scale.toArray()).toEqual([0.001, 0.001, 0.001]);
    expectVector(transformedCenter, new THREE.Vector3(0, 0, -1));
  });

  it('maps CAD Z-up to XR Y-up and keeps the CAD front facing the viewer', () => {
    const home = computeXrHomeTransform(new THREE.Vector3(), new THREE.Vector3(), new THREE.Quaternion());
    const xrUp = new THREE.Vector3(0, 0, 1).applyQuaternion(home.quaternion);
    const xrFront = new THREE.Vector3(0, -1, 0).applyQuaternion(home.quaternion);

    expectVector(xrUp, new THREE.Vector3(0, 1, 0));
    expectVector(xrFront, new THREE.Vector3(0, 0, 1));
  });

  it('uses the initial headset orientation for target distance and model yaw', () => {
    const viewerOrientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const home = computeXrHomeTransform(new THREE.Vector3(), new THREE.Vector3(0.2, 1.6, -0.3), viewerOrientation);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(viewerOrientation);
    const modelFront = new THREE.Vector3(0, -1, 0).applyQuaternion(home.quaternion);

    expectVector(home.position, new THREE.Vector3(0.2, 1.6, -0.3).add(forward));
    expectVector(modelFront, forward.clone().negate());
  });
});

describe('XR return animation helpers', () => {
  it('moves the selected local point to the controller grip origin', () => {
    const current = {
      position: new THREE.Vector3(2, 3, 4),
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
      scale: new THREE.Vector3(0.5, 0.5, 0.5),
    };
    const grabPoint = new THREE.Vector3(0, 0, 2);
    const grabbed = computeGrabbedTransform(current, grabPoint);
    const pointInGripSpace = grabPoint
      .clone()
      .multiply(grabbed.scale)
      .applyQuaternion(grabbed.quaternion)
      .add(grabbed.position);

    expectVector(pointInGripSpace, new THREE.Vector3());
    expect(Math.abs(grabbed.quaternion.dot(current.quaternion))).toBeCloseTo(1, 8);
    expectVector(grabbed.scale, current.scale);
  });

  it('interpolates and lands exactly on the home transform', () => {
    const object = new THREE.Object3D();
    const from = {
      position: new THREE.Vector3(2, 3, 4),
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      scale: new THREE.Vector3(2, 2, 2),
    };
    const to = {
      position: new THREE.Vector3(-1, 0.5, -2),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(0.001, 0.001, 0.001),
    };

    applyTransform(object, from);
    interpolateTransform(object, from, to, easeOutCubic(1));

    expectVector(object.position, to.position);
    expectVector(object.scale, to.scale);
    expect(Math.abs(object.quaternion.dot(to.quaternion))).toBeCloseTo(1, 8);
  });

  it('uses a monotonic ease-out curve', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(1)).toBe(1);
  });
});

function expectVector(actual: THREE.Vector3, expected: THREE.Vector3): void {
  expect(actual.distanceTo(expected)).toBeLessThan(EPSILON);
}
