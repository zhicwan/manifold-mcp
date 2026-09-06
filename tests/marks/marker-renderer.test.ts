import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { AnnotationStore } from '../../packages/viewer/src/marks/annotation-store.js';
import { MarkerRenderer } from '../../packages/viewer/src/marks/marker-renderer.js';

function markerMaterial(scene: THREE.Scene): THREE.MeshBasicMaterial {
  const group = scene.getObjectByName('marks-overlay');
  return (group?.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
}

describe('MarkerRenderer transaction styles', () => {
  it('refreshes a draft comment marker to a subdued committed style', () => {
    const scene = new THREE.Scene();
    const store = new AnnotationStore();
    const renderer = new MarkerRenderer(scene, store, () => null, vi.fn());
    try {
      store.addComment({
        kind: 'point',
        anchorWorld: [0, 0, 0],
        worldCoord: [0, 0, 0],
        triIds: [],
        note: 'review',
      });
      const draftMaterial = markerMaterial(scene);
      expect(draftMaterial.color.getHex()).toBe(0xff3030);
      expect(draftMaterial.opacity).toBe(0.95);

      store.freezeBatch(store.getDraftBatch().batchId);
      const committedMaterial = markerMaterial(scene);
      expect(committedMaterial).not.toBe(draftMaterial);
      expect(committedMaterial.color.getHex()).toBe(0x94a3b8);
      expect(committedMaterial.opacity).toBe(0.42);
    } finally {
      renderer.dispose();
    }
  });

  it('distinguishes pending and committed selection markers', () => {
    const scene = new THREE.Scene();
    const store = new AnnotationStore();
    const renderer = new MarkerRenderer(scene, store, () => null, vi.fn());
    try {
      const selection = store.addSelection({
        kind: 'point',
        anchorWorld: [0, 0, 0],
        worldCoord: [0, 0, 0],
        triIds: [],
      });
      expect(markerMaterial(scene).color.getHex()).toBe(0x22d3ee);

      store.commitSelection(selection.id);
      expect(markerMaterial(scene).color.getHex()).toBe(0x3b82f6);
      expect(markerMaterial(scene).opacity).toBe(0.52);
    } finally {
      renderer.dispose();
    }
  });
});
