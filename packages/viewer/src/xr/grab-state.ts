export type GrabPhase = 'idle' | 'grabbed' | 'returning';

export class GrabStateMachine {
  private phase: GrabPhase = 'idle';
  private owner: number | null = null;

  getPhase(): GrabPhase {
    return this.phase;
  }

  getOwner(): number | null {
    return this.owner;
  }

  tryGrab(controllerIndex: number): boolean {
    if (this.phase !== 'idle') {
      return false;
    }
    this.phase = 'grabbed';
    this.owner = controllerIndex;
    return true;
  }

  release(controllerIndex: number): boolean {
    if (this.phase !== 'grabbed' || this.owner !== controllerIndex) {
      return false;
    }
    this.phase = 'returning';
    this.owner = null;
    return true;
  }

  forceReturn(): boolean {
    if (this.phase === 'idle') {
      return false;
    }
    this.phase = 'returning';
    this.owner = null;
    return true;
  }

  finishReturn(): void {
    if (this.phase !== 'returning') {
      return;
    }
    this.phase = 'idle';
  }

  reset(): void {
    this.phase = 'idle';
    this.owner = null;
  }
}
