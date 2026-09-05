import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import type { ViewerModel } from '../packages/protocol/src/wire/model.js';
import { exportStl } from '../packages/viewer/src/exporters/stl.js';
import { payloadToGeometry } from '../packages/viewer/src/scene/mesh-bridge.js';
import { applyTransform, computeXrHomeTransform } from '../packages/viewer/src/xr/model-placement.js';

function model(): ViewerModel {
  return {
    numProp: 5,
    triangles: 4,
    vertices: 4,
    vertProperties: new Float32Array([0, 0, 0, 9, 8, 10, 0, 0, 9, 8, 0, 20, 0, 9, 8, 0, 0, 30, 9, 8]),
    triVerts: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    features: [],
    triFeatureIds: new Uint32Array(4),
    volume: 1000,
    surfaceArea: 600,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [10, 20, 30],
  };
}

describe('canonical STL export', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains CAD dimensions while the live model is placed and scaled in XR', async () => {
    const payload = model();
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(payloadToGeometry(payload), new THREE.MeshBasicMaterial());
    root.add(mesh);
    applyTransform(
      root,
      computeXrHomeTransform(new THREE.Vector3(5, 10, 15), new THREE.Vector3(1, 2, 3), new THREE.Quaternion()),
    );
    const worldMatrix = mesh.matrixWorld.clone();
    const liveGeometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const liveMaterialDispose = vi.spyOn(mesh.material, 'dispose');
    const positions = payload.vertProperties.slice();
    const indices = payload.triVerts.slice();

    const blob = exportStl(payload);
    const geometry = new STLLoader().parse(await blob.arrayBuffer());
    geometry.computeBoundingBox();
    expect(blob.type).toBe('model/stl');
    expect(geometry.boundingBox?.min.toArray()).toEqual([0, 0, 0]);
    expect(geometry.boundingBox?.max.toArray()).toEqual([10, 20, 30]);
    expect(mesh.matrixWorld.equals(worldMatrix)).toBe(true);
    expect(root.scale.toArray()).toEqual([0.001, 0.001, 0.001]);
    expect(payload.vertProperties).toEqual(positions);
    expect(payload.triVerts).toEqual(indices);
    expect(liveGeometryDispose).not.toHaveBeenCalled();
    expect(liveMaterialDispose).not.toHaveBeenCalled();

    geometry.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it.each([false, true])('releases its transient geometry and material (export failure: %s)', fail => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.MeshBasicMaterial.prototype, 'dispose');
    if (fail) {
      vi.spyOn(STLExporter.prototype, 'parse').mockImplementation(() => {
        throw new Error('export failed');
      });
      expect(() => exportStl(model())).toThrow('export failed');
    } else {
      expect(exportStl(model())).toBeInstanceOf(Blob);
    }
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
