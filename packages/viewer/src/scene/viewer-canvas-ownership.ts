type AcquisitionStatus = 'pending' | 'granted' | 'cancelled';

interface OwnershipRequest {
  readonly generation: number;
  status: AcquisitionStatus;
  resolve(ownership: ViewerCanvasOwnership | null): void;
}

interface CanvasOwnershipState {
  generation: number;
  current: OwnershipRequest | null;
  readonly pending: OwnershipRequest[];
}

export interface ViewerCanvasOwnership {
  readonly generation: number;
  isCurrent(): boolean;
  release(): void;
  releaseAfter(cleanup: () => Promise<void>): Promise<void>;
}

export interface ViewerCanvasOwnershipAcquisition {
  readonly acquired: Promise<ViewerCanvasOwnership | null>;
  cancel(): void;
}

const ownershipByCanvas = new WeakMap<HTMLCanvasElement, CanvasOwnershipState>();

/** Serialize complete Viewer/WebGL generations that reuse one canvas element. */
export function acquireViewerCanvasOwnership(canvas: HTMLCanvasElement): ViewerCanvasOwnershipAcquisition {
  const state = ownershipByCanvas.get(canvas) ?? {
    generation: 0,
    current: null,
    pending: [],
  };
  ownershipByCanvas.set(canvas, state);

  let resolveAcquired: (ownership: ViewerCanvasOwnership | null) => void = () => undefined;
  const acquired = new Promise<ViewerCanvasOwnership | null>(resolve => {
    resolveAcquired = resolve;
  });
  const request: OwnershipRequest = {
    generation: ++state.generation,
    status: 'pending',
    resolve: resolveAcquired,
  };
  state.pending.push(request);
  grantNext(canvas, state);

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
      releaseEmptyState(canvas, state);
    },
  };
}

function grantNext(canvas: HTMLCanvasElement, state: CanvasOwnershipState): void {
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
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      if (state.current !== request) {
        return;
      }
      state.current = null;
      grantNext(canvas, state);
      releaseEmptyState(canvas, state);
    };
    const ownership: ViewerCanvasOwnership = {
      generation: request.generation,
      isCurrent(): boolean {
        return !released && state.current === request;
      },
      release,
      async releaseAfter(cleanup: () => Promise<void>): Promise<void> {
        try {
          await cleanup();
        } finally {
          release();
        }
      },
    };
    request.resolve(ownership);
    return;
  }
  releaseEmptyState(canvas, state);
}

function releaseEmptyState(canvas: HTMLCanvasElement, state: CanvasOwnershipState): void {
  if (!state.current && state.pending.length === 0 && ownershipByCanvas.get(canvas) === state) {
    ownershipByCanvas.delete(canvas);
  }
}
