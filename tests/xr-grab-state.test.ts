import { describe, expect, it } from 'vitest';

import { GrabStateMachine } from '../packages/viewer/src/xr/grab-state.js';

describe('XR grab state', () => {
  it('allows one controller owner at a time', () => {
    const state = new GrabStateMachine();

    expect(state.tryGrab(0)).toBe(true);
    expect(state.getOwner()).toBe(0);
    expect(state.tryGrab(1)).toBe(false);
    expect(state.getOwner()).toBe(0);
  });

  it('only releases the controller that owns the model', () => {
    const state = new GrabStateMachine();
    state.tryGrab(1);

    expect(state.release(0)).toBe(false);
    expect(state.getPhase()).toBe('grabbed');
    expect(state.release(1)).toBe(true);
    expect(state.getPhase()).toBe('returning');
    expect(state.getOwner()).toBeNull();
  });

  it('blocks re-grab until the return animation finishes', () => {
    const state = new GrabStateMachine();
    state.tryGrab(0);
    state.release(0);

    expect(state.tryGrab(1)).toBe(false);
    state.finishReturn();
    expect(state.tryGrab(1)).toBe(true);
  });

  it('forces a held model into return state on disconnect or replacement', () => {
    const state = new GrabStateMachine();
    state.tryGrab(0);

    expect(state.forceReturn()).toBe(true);
    expect(state.getPhase()).toBe('returning');
    expect(state.getOwner()).toBeNull();
  });
});
