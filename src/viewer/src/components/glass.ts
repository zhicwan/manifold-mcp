/**
 * Shared frosted-glass surface treatment for every floating panel in
 * the viewer. Semi-transparent background + heavy backdrop blur +
 * hairline border reads as "light layer over the 3D scene" in both
 * themes.
 */
export const glass =
  'pointer-events-auto rounded-2xl border border-border/60 bg-background/60 shadow-lg backdrop-blur-xl';

export const glassPill =
  'pointer-events-auto rounded-full border border-border/60 bg-background/60 shadow-lg backdrop-blur-xl';
