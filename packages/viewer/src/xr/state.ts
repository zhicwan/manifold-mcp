export type XrSupport = 'checking' | 'supported' | 'unsupported';
export type XrSessionState = 'idle' | 'starting' | 'active';

export interface XrExperienceSnapshot {
  readonly support: XrSupport;
  readonly sessionState: XrSessionState;
  readonly error: string | null;
  readonly runtimeReady: boolean;
  readonly hasModel: boolean;
}

type Listener = () => void;
type EnterHandler = () => Promise<void>;

interface EnterBindingState {
  readonly generation: number;
  readonly handler: EnterHandler;
}

export interface XrEnterBinding {
  readonly generation: number;
  setSessionState(sessionState: XrSessionState): void;
  unbind(): void;
}

const INITIAL: XrExperienceSnapshot = {
  support: 'checking',
  sessionState: 'idle',
  error: null,
  runtimeReady: false,
  hasModel: false,
};

export interface XrExperienceState {
  getSnapshot(): XrExperienceSnapshot;
  subscribe(listener: Listener): () => void;
  bindEnterHandler(handler: EnterHandler): XrEnterBinding;
  enter(): Promise<void>;
  setSupport(supported: boolean): void;
  setSupportError(error: string): void;
  setHasModel(hasModel: boolean): void;
}

export function createXrExperienceState(): XrExperienceState {
  let snapshot = INITIAL;
  let binding: EnterBindingState | null = null;
  let nextGeneration = 0;
  const listeners = new Set<Listener>();

  const update = (patch: Partial<XrExperienceSnapshot>): void => {
    const next = { ...snapshot, ...patch };
    if (
      next.support === snapshot.support &&
      next.sessionState === snapshot.sessionState &&
      next.error === snapshot.error &&
      next.runtimeReady === snapshot.runtimeReady &&
      next.hasModel === snapshot.hasModel
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot(): XrExperienceSnapshot {
      return snapshot;
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindEnterHandler(handler: EnterHandler): XrEnterBinding {
      const bound: EnterBindingState = {
        generation: ++nextGeneration,
        handler,
      };
      binding = bound;
      update({ runtimeReady: true });
      return {
        generation: bound.generation,
        setSessionState(sessionState: XrSessionState): void {
          if (binding === bound) {
            update({ sessionState, error: sessionState === 'active' ? null : snapshot.error });
          }
        },
        unbind(): void {
          if (binding !== bound) {
            return;
          }
          binding = null;
          update({ ...INITIAL });
        },
      };
    },
    async enter(): Promise<void> {
      const attempt = binding;
      if (!attempt || snapshot.sessionState !== 'idle' || !snapshot.hasModel) {
        return;
      }
      update({ sessionState: 'starting', error: null });
      try {
        await attempt.handler();
      } catch (error) {
        if (binding === attempt) {
          update({
            sessionState: 'idle',
            error: error instanceof Error ? error.message : 'Unable to enter VR.',
          });
        }
        throw error;
      }
    },
    setSupport(supported: boolean): void {
      update({ support: supported ? 'supported' : 'unsupported', error: null });
    },
    setSupportError(error: string): void {
      update({ support: 'unsupported', error });
    },
    setHasModel(hasModel: boolean): void {
      update({ hasModel });
    },
  };
}
