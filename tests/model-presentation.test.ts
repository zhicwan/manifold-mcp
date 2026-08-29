import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { applyModelPresentation, getModelPresentationStyle } from '../packages/viewer/src/scene/model-presentation.js';

describe('Viewer model presentation', () => {
  it('maps semantic hover and held states onto the base model material', () => {
    const material = new THREE.MeshStandardMaterial();

    applyModelPresentation(material, 'hover');
    expect(material.emissive.getHex()).toBe(getModelPresentationStyle('hover').emissive);
    expect(material.emissiveIntensity).toBe(0.45);

    applyModelPresentation(material, 'held');
    expect(material.emissive.getHex()).toBe(getModelPresentationStyle('held').emissive);

    applyModelPresentation(material, 'idle');
    expect(material.emissive.getHex()).toBe(0);
    expect(material.emissiveIntensity).toBe(0);
  });
});
