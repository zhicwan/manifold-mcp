import type { ReactNode } from 'react';

export interface ViewerSlots {
  /** Controls appended to the existing toolbar action cluster. */
  readonly toolbarEnd?: ReactNode;
  /** Browser-local scene contributions mounted beside ViewerCanvas. */
  readonly sceneLayers?: ReactNode;
  /** Floating UI owned by an optional viewer contribution. */
  readonly overlays?: ReactNode;
}
