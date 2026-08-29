/**
 * Annotation domain types shared across the viewer's marks subsystem.
 *
 * An annotation is a user-created spatial pin with an attached free-form
 * note. M1 supports two kinds: a single point (Ctrl+click) and a region
 * defined by a screen-space rectangle (Ctrl+drag).
 *
 * In M1 the partLabel is a generic sequence-based name (point#1, region#2);
 * in M3 it gets upgraded to semantic part names (bowl#1, handle#2) once the
 * feature recognition system lands.
 */
export type AnnotationKind = 'point' | 'region';

export interface Annotation {
  id: string;
  createdAt: number;
  /** Identifies the model version this annotation was made against. */
  modelVersion: string;
  kind: AnnotationKind;

  /** World-space anchor for the marker and flyout. */
  anchorWorld: [number, number, number];

  /**
   * Original picked surface point (for kind=point). For region this is
   * the same as anchorWorld (the centroid of selected triangles).
   */
  worldCoord: [number, number, number];

  /** Triangle indices selected (for kind=region). Empty for kind=point. */
  triIds: number[];

  /**
   * Display label. M1: point#N / region#N. M3: semantic (bowl#1, handle#2).
   * Always present so the UI never has to handle a missing label.
   */
  partLabel: string;

  /** User's free-form note. Empty string means "not yet written". */
  note: string;
}
