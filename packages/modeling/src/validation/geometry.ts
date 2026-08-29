/**
 * Stage 3+4: geometric / print readiness checks.
 *
 * Consumes the bbox/triangle/volume/etc. snapshot produced by the worker
 * after `result` is materialised, and merges error/warning/hint
 * findings into the `Report` in-place.
 */
import { type Report, type Stats, ERROR_STATUS_TO_CODE, addError, addHint, addWarning } from './report.js';

interface GeomCheckInput {
  status: string; // ErrorStatus from manifold
  isEmpty: boolean;
  triangles: number;
  vertices: number;
  volume: number;
  surfaceArea: number;
  genus: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

/** Surfaced in script-conventions.md and validation-report.md — keep docs in sync. */
const TRIANGLE_BUDGET = 500_000;
const BBOX_MIN_MM = 0.1;
/** Surfaced in script-conventions.md and validation-report.md — keep docs in sync. */
const BBOX_MAX_MM = 500;

/** Stage 3+4: geometric / print readiness checks. Mutates `report`. */
export function runGeometryStage(report: Report, info: GeomCheckInput): Stats {
  const size: [number, number, number] = [
    info.bbox.max[0] - info.bbox.min[0],
    info.bbox.max[1] - info.bbox.min[1],
    info.bbox.max[2] - info.bbox.min[2],
  ];
  const stats: Stats = {
    triangles: info.triangles,
    vertices: info.vertices,
    volume: info.volume,
    surfaceArea: info.surfaceArea,
    genus: info.genus,
    bbox: { min: info.bbox.min, max: info.bbox.max, size },
  };
  const statsAreFinite = isFiniteStats(stats);

  if (info.status !== 'NoError') {
    if (statsAreFinite) {
      report.stats = stats;
    } else {
      addHint(
        report,
        'Geometry stats are unavailable because construction failed before a finite bounding box existed.',
      );
    }
    addError(report, {
      stage: 'geometry',
      code: ERROR_STATUS_TO_CODE[info.status] ?? 'NOT_MANIFOLD',
      category: 'geometry',
      message: geometryStatusMessage(info.status),
    });
    return stats;
  }
  if (info.isEmpty) {
    if (statsAreFinite) {
      report.stats = stats;
    } else {
      addHint(report, 'Geometry stats are unavailable because the result is empty and has no finite bounding box.');
    }
    addError(report, {
      stage: 'geometry',
      code: 'EMPTY_RESULT',
      category: 'geometry',
      message:
        'Result is empty. Common causes include disjoint boolean operands, subtracting a shape from itself, invalid/non-finite warp output, or fully removing the part.',
    });
    addHint(
      report,
      'Check recent boolean operations, cutter/part bounding boxes, translation direction, subtract/intersect order, and any warp callbacks that can create NaN or Infinity.',
    );
    return stats;
  }
  report.stats = stats;
  if (info.volume <= 0) {
    addWarning(report, {
      stage: 'geometry',
      code: 'ZERO_VOLUME',
      category: 'geometry',
      message: 'Result has zero or negative volume; likely a degenerate / planar shape.',
    });
  }
  if (info.triangles > TRIANGLE_BUDGET) {
    addWarning(report, {
      stage: 'geometry',
      code: 'TRIANGLE_BUDGET',
      category: 'geometry',
      message: `Result has ${info.triangles} triangles (> ${TRIANGLE_BUDGET}); consider lowering circular segments.`,
    });
  }
  const minDim = Math.min(...size);
  const maxDim = Math.max(...size);
  if (minDim > 0 && minDim < BBOX_MIN_MM) {
    addWarning(report, {
      stage: 'geometry',
      code: 'BBOX_TOO_SMALL',
      category: 'geometry',
      message: `Smallest bounding box dimension is ${minDim.toFixed(3)} mm (< ${BBOX_MIN_MM} mm); likely too small for FDM printing.`,
    });
  }
  if (maxDim > BBOX_MAX_MM) {
    addWarning(report, {
      stage: 'geometry',
      code: 'BBOX_TOO_LARGE',
      category: 'geometry',
      message: `Largest bounding box dimension is ${maxDim.toFixed(1)} mm (> ${BBOX_MAX_MM} mm); exceeds most consumer printers.`,
    });
  }
  // Stage 4 (print readiness) hints — non-blocking.
  const featureSize = info.surfaceArea > 0 ? Math.cbrt(info.volume / Math.max(1, info.triangles)) : 0;
  if (featureSize > 0 && featureSize < 0.4) {
    addHint(
      report,
      `Estimated minimum feature size ~${featureSize.toFixed(2)} mm; smaller than a typical 0.4 mm nozzle.`,
    );
  }
  // VAL-4: the worker emits the millimetres reminder after a successful
  // geometry pass; Runner filters it to once per Runner/session.

  if (report.ok) {
    report.stage = 'ok';
  }
  return stats;
}

function isFiniteStats(stats: Stats): boolean {
  return [
    stats.triangles,
    stats.vertices,
    stats.volume,
    stats.surfaceArea,
    stats.genus,
    ...stats.bbox.min,
    ...stats.bbox.max,
    ...stats.bbox.size,
  ].every(Number.isFinite);
}

function geometryStatusMessage(status: string): string {
  if (status === 'InvalidConstruction') {
    return [
      'Manifold reports status: InvalidConstruction.',
      'Common causes: non-positive radii/heights/thicknesses, inner dimensions larger than outer dimensions, object-style constructor arguments, self-intersecting polygons, or clockwise outer rings in CrossSection.ofPolygons.',
      'Validate subassemblies independently to isolate the bad primitive or 2D profile.',
    ].join(' ');
  }
  return `Manifold reports status: ${status}.`;
}
