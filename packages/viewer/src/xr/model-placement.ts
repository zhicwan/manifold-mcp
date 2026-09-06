import * as THREE from 'three';

export interface ObjectTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

const CAD_TO_XR = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const CAD_FRONT_AFTER_AXIS_CONVERSION = new THREE.Vector3(0, 0, 1);
const VIEWER_FORWARD = new THREE.Vector3(0, 0, -1);
const XR_METERS_PER_MILLIMETER = 0.001;

export function computeXrViewingDistance(maxDimensionMm: number): number {
  return Math.max(1, maxDimensionMm * XR_METERS_PER_MILLIMETER * 1.25);
}

export function computeXrHomeTransform(
  modelCenterMm: THREE.Vector3,
  viewerPosition: THREE.Vector3,
  viewerOrientation: THREE.Quaternion,
  distanceMeters = 1,
): ObjectTransform {
  const forward = VIEWER_FORWARD.clone().applyQuaternion(viewerOrientation).normalize();
  const target = viewerPosition.clone().addScaledVector(forward, distanceMeters);

  // Keep CAD vertical aligned with real-world up while rotating the
  // model around Y so its recognised front face points back at the user.
  const horizontalForward = forward.clone();
  horizontalForward.y = 0;
  if (horizontalForward.lengthSq() < 1e-8) {
    horizontalForward.set(0, 0, -1);
  } else {
    horizontalForward.normalize();
  }
  const desiredFront = horizontalForward.negate();
  const faceViewer = new THREE.Quaternion().setFromUnitVectors(CAD_FRONT_AFTER_AXIS_CONVERSION, desiredFront);
  const quaternion = faceViewer.multiply(CAD_TO_XR.clone()).normalize();
  const scale = new THREE.Vector3().setScalar(XR_METERS_PER_MILLIMETER);

  const transformedCenter = modelCenterMm.clone().multiplyScalar(XR_METERS_PER_MILLIMETER).applyQuaternion(quaternion);
  const position = target.sub(transformedCenter);

  return { position, quaternion, scale };
}

export function captureTransform(object: THREE.Object3D): ObjectTransform {
  return {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
  };
}

export function applyTransform(object: THREE.Object3D, transform: ObjectTransform): void {
  object.position.copy(transform.position);
  object.quaternion.copy(transform.quaternion);
  object.scale.copy(transform.scale);
  object.updateMatrixWorld(true);
}

export function interpolateTransform(
  object: THREE.Object3D,
  from: ObjectTransform,
  to: ObjectTransform,
  progress: number,
): void {
  object.position.lerpVectors(from.position, to.position, progress);
  object.quaternion.slerpQuaternions(from.quaternion, to.quaternion, progress);
  object.scale.lerpVectors(from.scale, to.scale, progress);
  object.updateMatrixWorld(true);
}

export function computeGrabbedTransform(current: ObjectTransform, grabPointLocal: THREE.Vector3): ObjectTransform {
  const offsetFromOrigin = grabPointLocal.clone().multiply(current.scale).applyQuaternion(current.quaternion);
  return {
    position: offsetFromOrigin.negate(),
    quaternion: current.quaternion.clone(),
    scale: current.scale.clone(),
  };
}

export function easeOutCubic(progress: number): number {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  return 1 - (1 - t) ** 3;
}
