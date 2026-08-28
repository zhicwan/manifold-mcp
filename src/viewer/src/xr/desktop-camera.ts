import * as THREE from 'three';

type CameraView = NonNullable<THREE.PerspectiveCamera['view']>;

export interface DesktopCameraState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  up: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  zoom: number;
  focus: number;
  aspect: number;
  near: number;
  far: number;
  filmGauge: number;
  filmOffset: number;
  view: CameraView | null;
}

export function captureDesktopCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3): DesktopCameraState {
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    scale: camera.scale.clone(),
    up: camera.up.clone(),
    target: target.clone(),
    fov: camera.fov,
    zoom: camera.zoom,
    focus: camera.focus,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
    filmGauge: camera.filmGauge,
    filmOffset: camera.filmOffset,
    view: camera.view ? { ...camera.view } : null,
  };
}

export function updateDesktopCameraFrame(
  state: DesktopCameraState,
  position: THREE.Vector3,
  target: THREE.Vector3,
  near: number,
  far: number,
): void {
  state.position.copy(position);
  state.up.set(0, 0, 1);
  state.target.copy(target);
  state.near = near;
  state.far = far;

  const rotation = new THREE.Matrix4().lookAt(state.position, state.target, state.up);
  state.quaternion.setFromRotationMatrix(rotation);
}

export function restoreDesktopCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  state: DesktopCameraState,
): void {
  camera.position.copy(state.position);
  camera.quaternion.copy(state.quaternion);
  camera.scale.copy(state.scale);
  camera.up.copy(state.up);
  camera.fov = state.fov;
  camera.zoom = state.zoom;
  camera.focus = state.focus;
  camera.aspect = state.aspect;
  camera.near = state.near;
  camera.far = state.far;
  camera.filmGauge = state.filmGauge;
  camera.filmOffset = state.filmOffset;
  camera.view = state.view ? { ...state.view } : null;
  target.copy(state.target);
  camera.updateProjectionMatrix();
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
}
