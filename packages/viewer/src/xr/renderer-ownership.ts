import type * as THREE from 'three';

type AcquisitionStatus = 'pending' | 'granted' | 'cancelled';

interface OwnershipRequest {
  readonly generation: number;
  status: AcquisitionStatus;
  resolve(ownership: XrRendererOwnership | null): void;
}

interface RendererOwnershipState {
  generation: number;
  current: OwnershipRequest | null;
  readonly pending: OwnershipRequest[];
}

export interface XrRendererOwnership {
  readonly generation: number;
  isCurrent(): boolean;
  release(): void;
}

export interface XrRendererOwnershipAcquisition {
  readonly acquired: Promise<XrRendererOwnership | null>;
  cancel(): void;
}

const ownershipByRenderer = new WeakMap<THREE.WebGLRenderer, RendererOwnershipState>();

/**
 * Serialize access to a renderer's shared WebXR manager and cached controller
 * groups. Pending acquisitions can be cancelled without waiting for the active
 * owner to finish.
 */
export function acquireXrRendererOwnership(renderer: THREE.WebGLRenderer): XrRendererOwnershipAcquisition {
  const state = ownershipByRenderer.get(renderer) ?? {
    generation: 0,
    current: null,
    pending: [],
  };
  ownershipByRenderer.set(renderer, state);

  let resolveAcquired: (ownership: XrRendererOwnership | null) => void = () => undefined;
  const acquired = new Promise<XrRendererOwnership | null>(resolve => {
    resolveAcquired = resolve;
  });
  const request: OwnershipRequest = {
    generation: ++state.generation,
    status: 'pending',
    resolve: resolveAcquired,
  };
  state.pending.push(request);
  grantNext(renderer, state);

  return {
    acquired,
    cancel(): void {
      if (request.status !== 'pending') {
        return;
      }
      request.status = 'cancelled';
      const index = state.pending.indexOf(request);
      if (index !== -1) {
        state.pending.splice(index, 1);
      }
      request.resolve(null);
      releaseEmptyState(renderer, state);
    },
  };
}

function grantNext(renderer: THREE.WebGLRenderer, state: RendererOwnershipState): void {
  if (state.current) {
    return;
  }
  while (state.pending.length > 0) {
    const request = state.pending.shift()!;
    if (request.status === 'cancelled') {
      continue;
    }
    request.status = 'granted';
    state.current = request;
    let released = false;
    const ownership: XrRendererOwnership = {
      generation: request.generation,
      isCurrent(): boolean {
        return !released && state.current === request;
      },
      release(): void {
        if (released) {
          return;
        }
        released = true;
        if (state.current !== request) {
          return;
        }
        state.current = null;
        grantNext(renderer, state);
        releaseEmptyState(renderer, state);
      },
    };
    request.resolve(ownership);
    return;
  }
  releaseEmptyState(renderer, state);
}

function releaseEmptyState(renderer: THREE.WebGLRenderer, state: RendererOwnershipState): void {
  if (!state.current && state.pending.length === 0 && ownershipByRenderer.get(renderer) === state) {
    ownershipByRenderer.delete(renderer);
  }
}
