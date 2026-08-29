import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

  it('keeps immersive feedback behind the semantic Viewer callback', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../packages/viewer/src/xr/xr-runtime.ts'), 'utf8');

    expect(source).toContain('this.runtime.setModelPresentationState(state)');
    expect(source).not.toContain('MeshStandardMaterial');
    expect(source).not.toMatch(/material\.emissive/);
  });
});
