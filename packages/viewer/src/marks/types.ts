/**
 * Annotation domain types shared across the viewer's marks subsystem.
 *
 * Spatial annotations are either comments authored in draft batches or
 * selections attached to a single interaction. Their transaction metadata
 * is browser-local and is deliberately omitted by the wire serializer.
 *
 * The partLabel falls back to a generic sequence name (point#1, region#2)
 * when the feature resolver cannot provide a semantic label.
 */
export type AnnotationKind = 'point' | 'region';
export type AnnotationIntent = 'comment' | 'selection';
export type AnnotationState = 'draft' | 'pending' | 'committed';

interface SpatialAnnotation {
  id: string;
  createdAt: number;
  /** Identifies the model version this annotation was made against. */
  modelVersion: string;
  kind: AnnotationKind;
  /** Browser-local transaction grouping. Never serialized to WireAnnotation. */
  batchId: string;

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
   * Display label: generic point#N / region#N or a semantic feature label.
   * Always present so the UI never has to handle a missing label.
   */
  partLabel: string;
}

export interface CommentAnnotation extends SpatialAnnotation {
  intent: 'comment';
  state: 'draft' | 'pending' | 'committed';
  /** User's free-form note. Empty string means "not yet written". */
  note: string;
}

export interface SelectionAnnotation extends SpatialAnnotation {
  intent: 'selection';
  state: 'pending' | 'committed';
  /** Selections are geometry-only and never own editable note text. */
  note: '';
}

export type Annotation = CommentAnnotation | SelectionAnnotation;

export interface AnnotationGeometryInput {
  kind: AnnotationKind;
  anchorWorld: [number, number, number];
  worldCoord: [number, number, number];
  triIds: number[];
  partLabel?: string;
}

export interface CommentAnnotationInput extends AnnotationGeometryInput {
  note: string;
}

export type SelectionAnnotationInput = AnnotationGeometryInput;

export interface CommentBatchSnapshot {
  batchId: string;
  annotations: readonly CommentAnnotation[];
  annotationIds: readonly string[];
  /** Alias retained for callers that prefer the shorter domain name. */
  ids: readonly string[];
  count: number;
}
