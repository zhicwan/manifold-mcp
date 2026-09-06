import type * as THREE from 'three';

import type { ModelPresentationState } from './runtime.js';

export interface ModelPresentationStyle {
  readonly emissive: number;
  readonly emissiveIntensity: number;
}

const PRESENTATION_STYLES: Record<ModelPresentationState, ModelPresentationStyle> = {
  idle: { emissive: 0x000000, emissiveIntensity: 0 },
  hover: { emissive: 0x003f3a, emissiveIntensity: 0.45 },
  held: { emissive: 0x5b3a00, emissiveIntensity: 0.45 },
};

export function getModelPresentationStyle(state: ModelPresentationState): ModelPresentationStyle {
  return PRESENTATION_STYLES[state];
}

export function applyModelPresentation(material: THREE.MeshStandardMaterial, state: ModelPresentationState): void {
  const style = getModelPresentationStyle(state);
  material.emissive.setHex(style.emissive);
  material.emissiveIntensity = style.emissiveIntensity;
  material.needsUpdate = true;
}
