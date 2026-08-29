import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react';

import type { ViewerSlots } from '../components/viewer-slots.js';
import { createXrExperienceState, type XrExperienceState } from './state.js';

export interface XrExperience {
  readonly Provider: ComponentType<{ children: ReactNode }>;
  readonly slots: ViewerSlots;
}

const XrExperienceContext = createContext<XrExperienceState | null>(null);

export function createXrExperienceScope(slots: ViewerSlots): XrExperience {
  const state = createXrExperienceState();

  function Provider({ children }: { children: ReactNode }) {
    return createElement(XrExperienceContext.Provider, { value: state }, children);
  }

  return { Provider, slots };
}

export function useXrExperienceState(): XrExperienceState {
  const state = useContext(XrExperienceContext);
  if (!state) {
    throw new Error('XR Viewer slots must be rendered inside their experience Provider.');
  }
  return state;
}
