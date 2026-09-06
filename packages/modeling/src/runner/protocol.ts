/**
 * Shared protocol types between runner/host (main thread) and runner/worker.
 * Both ValidateRequest and ExecuteRequest go over `parentPort.postMessage`.
 */

import type { ViewerFeature } from '@manifold3d/protocol/wire/model.js';
import type { Report } from '../validation/report.js';

type RunMode = 'validate' | 'execute';

export const MILLIMETRES_HINT = 'Manifold has no intrinsic units; this server interprets coordinates as millimetres.';

export interface RunRequest {
  mode: RunMode;
  code: string;
  description?: string;
  /**
   * When true, no `Issue.snippet` field is emitted on diagnostics. Set by the
   * MCP server when source was loaded via `filePath` so reports cannot leak
   * file contents back to a (potentially prompt-injected) caller.
   */
  suppressSnippet?: boolean;
}

export interface ModelArtifact {
  description?: string;
  numProp: number;
  triangles: number;
  vertices: number;
  vertProperties: ArrayBuffer; // Float32Array buffer (transferred)
  triVerts: ArrayBuffer; // Uint32Array buffer (transferred)
  /**
   * One Uint32 per triangle: index into `features`. Empty buffer when
   * the geometry stage produced no recognizable features (e.g. raw
   * Mesh-imported geometry).
   */
  triFeatureIds: ArrayBuffer; // Uint32Array buffer (transferred)
  /** Recognised primitive instances. May be empty. */
  features: ViewerFeature[];
  /**
   * Geometry stats — mirror what the worker already computes for the
   * report. Surfaces in the viewer's control panel without re-walking
   * the mesh. Volume in mm^3, surface area in mm^2.
   */
  volume: number;
  surfaceArea: number;
  /** Genus (number of through-holes). 0 = simply connected, watertight. */
  genus: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/** What the worker sends back. The main thread converts this into a Report. */
export interface RunResult {
  // From the worker's view of the report (errors/warnings/hints/stats etc.)
  report: Report;
  // Present on successful execute mode.
  artifact?: ModelArtifact;
}
