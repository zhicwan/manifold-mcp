/**
 * Feature recognition for the manifold-3d sandbox runtime.
 *
 * We patch the constructors of primitive shapes (cube, sphere, cylinder,
 * tetrahedron, extrude, revolve) so each call records a small whitelisted
 * metadata record under the resulting Manifold's originalID. After the
 * user's script finishes, we read MeshGL.runIndex / runOriginalID /
 * runTransform to map every triangle in the final mesh back to an
 * "instance" of one of those primitives.
 *
 * Key choices (validated by design review — see plan.md "M3 design"):
 *   * Feature identity = (originalID, runTransform). Two runs with the
 *     same source and same world transform collapse into one feature;
 *     two with the same source but different transforms become two
 *     instances (sphere#1, sphere#2).
 *   * Params are whitelisted per kind — never raw arg passthrough — so
 *     the wire format is JSON-safe and stable.
 *   * Wrapping happens AFTER `garbageCollectManifold(wasm)` so returned
 *     instances are still tracked for cleanup.
 *   * We don't track booleans / transform calls at all: manifold's own
 *     runOriginalID + runTransform threads everything through for free.
 */

import type {
  FeatureKind,
  ViewerFeature,
  ViewerFeatureParam,
  ViewerFeatureParams,
} from '@manifold3d/protocol/wire/model.js';
import type { ManifoldMesh, ManifoldToplevel } from './manifold-types.js';

interface FeatureMeta {
  kind: FeatureKind;
  params: Readonly<Record<string, ViewerFeatureParam | undefined>>;
}

interface FeaturePayload {
  features: ViewerFeature[];
  /** One Uint32 per triangle: index into `features`. */
  triFeatureIds: Uint32Array<ArrayBuffer>;
}

export interface FeatureStore {
  /** id → metadata, populated as the user's script runs. */
  registry: Map<number, FeatureMeta>;
}

interface AnyFn {
  (this: unknown, ...args: unknown[]): unknown;
}

interface ManifoldLike {
  originalID(): number;
}

function isManifoldLike(v: unknown): v is ManifoldLike {
  return !!v && typeof v === 'object' && typeof (v as { originalID?: unknown }).originalID === 'function';
}

/**
 * Wrap a primitive constructor so its returned Manifold's originalID
 * is associated with a metadata record. Wrapping is idempotent: the
 * outer wrapper records, the inner already-wrapped fn (e.g. the
 * GC-tracked one) does the actual work.
 */
function wrapWithRecorder(
  fn: AnyFn,
  kind: FeatureKind,
  paramsBuilder: (args: unknown[]) => FeatureMeta['params'],
  registry: Map<number, FeatureMeta>,
): AnyFn {
  return function recordingWrapper(this: unknown, ...args: unknown[]): unknown {
    const ret = fn.apply(this, args);
    if (isManifoldLike(ret)) {
      const id = ret.originalID();
      // -1 means "not original" — happens for derived manifolds, but
      // primitives produced by these constructors should always be
      // original. Only record positive IDs.
      if (id >= 0 && !registry.has(id)) {
        registry.set(id, { kind, params: paramsBuilder(args) });
      }
    }
    return ret;
  };
}

// ───────────── Per-kind param whitelist ─────────────────────────────────

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function numArray(x: unknown, length: number): number[] | undefined {
  if (!Array.isArray(x) || x.length < length) {
    return undefined;
  }
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const n = x[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return undefined;
    }
    out.push(n);
  }
  return out;
}

function paramsForCube(args: unknown[]): FeatureMeta['params'] {
  const [size, center] = args;
  // Manifold.cube accepts either [x,y,z] or a scalar.
  const sizeVec = numArray(size, 3) ?? (typeof size === 'number' ? [size, size, size] : [1, 1, 1]);
  return { size: sizeVec, center: !!center };
}

function paramsForSphere(args: unknown[]): FeatureMeta['params'] {
  const [radius, circularSegments] = args;
  return {
    radius: num(radius) ?? 0,
    circularSegments: num(circularSegments),
  };
}

function paramsForCylinder(args: unknown[]): FeatureMeta['params'] {
  const [height, radiusLow, radiusHigh, circularSegments, center] = args;
  const rLow = num(radiusLow) ?? 0;
  return {
    height: num(height) ?? 0,
    radiusLow: rLow,
    radiusHigh: num(radiusHigh) ?? rLow,
    circularSegments: num(circularSegments),
    center: !!center,
  };
}

function paramsForTetrahedron(): FeatureMeta['params'] {
  return {};
}

function paramsForExtrude(args: unknown[]): FeatureMeta['params'] {
  // CrossSection.extrude(height, nDivisions?, twistDegrees?, scaleTop?, center?)
  const [height, nDivisions, twistDegrees, scaleTop, center] = args;
  return {
    height: num(height) ?? 0,
    nDivisions: num(nDivisions),
    twistDegrees: num(twistDegrees),
    scaleTop: numArray(scaleTop, 2),
    center: !!center,
  };
}

function paramsForRevolve(args: unknown[]): FeatureMeta['params'] {
  // CrossSection.revolve(circularSegments?, revolveDegrees?)
  const [circularSegments, revolveDegrees] = args;
  return {
    circularSegments: num(circularSegments),
    revolveDegrees: num(revolveDegrees),
  };
}

// ───────────── Patch installation ───────────────────────────────────────

interface MutableNs {
  cube?: AnyFn;
  sphere?: AnyFn;
  cylinder?: AnyFn;
  tetrahedron?: AnyFn;
}

/**
 * manifold-3d uses Embind under the hood, which gives instances a
 * HIDDEN internal prototype that is NOT the same object as
 * `CrossSection.prototype`. Patching `CrossSection.prototype.extrude`
 * therefore has no effect — instances dispatch through the Embind proto.
 *
 * To intercept extrude / revolve we briefly create a throwaway
 * CrossSection instance and patch the prototype object Embind actually
 * dispatches against. The throwaway instance gets GC'd at script end
 * via the existing `garbageCollectFunction` wrapping of
 * `CrossSection.square`.
 *
 * A changed or frozen Embind dispatch prototype is an incompatible runtime
 * contract: fail initialization rather than silently dropping feature labels.
 */
function patchCrossSectionInstanceProto(wasm: ManifoldToplevel, registry: Map<number, FeatureMeta>): void {
  const CS = wasm.CrossSection as unknown as { square?: AnyFn };
  if (typeof CS.square !== 'function') {
    throw new Error('Manifold CrossSection.square is unavailable for feature recognition.');
  }
  const probe = CS.square.call(wasm.CrossSection, [1, 1]);
  if (!probe || typeof probe !== 'object') {
    throw new Error('Manifold CrossSection.square returned an invalid feature-recognition probe.');
  }
  const proto = Object.getPrototypeOf(probe) as Record<string, unknown> | null;
  if (!proto) {
    throw new Error('Manifold CrossSection probe has no feature-recognition prototype.');
  }
  if (Object.isFrozen(proto)) {
    throw new Error('Manifold CrossSection feature-recognition prototype is frozen.');
  }
  if (typeof proto.extrude === 'function') {
    proto.extrude = wrapWithRecorder(proto.extrude as AnyFn, 'extrude', paramsForExtrude, registry);
  }
  if (typeof proto.revolve === 'function') {
    proto.revolve = wrapWithRecorder(proto.revolve as AnyFn, 'revolve', paramsForRevolve, registry);
  }
}

/**
 * Install primitive recorders on the given manifold-3d toplevel. Returns
 * a fresh feature store. Must be called AFTER `garbageCollectManifold`
 * so the GC wrapping sits inside our recording wrapping.
 */
export function installFeatureRecognition(wasm: ManifoldToplevel): FeatureStore {
  const registry = new Map<number, FeatureMeta>();
  const M = wasm.Manifold as unknown as MutableNs;

  if (typeof M.cube === 'function') {
    M.cube = wrapWithRecorder(M.cube, 'cube', paramsForCube, registry);
  }
  if (typeof M.sphere === 'function') {
    M.sphere = wrapWithRecorder(M.sphere, 'sphere', paramsForSphere, registry);
  }
  if (typeof M.cylinder === 'function') {
    M.cylinder = wrapWithRecorder(M.cylinder, 'cylinder', paramsForCylinder, registry);
  }
  if (typeof M.tetrahedron === 'function') {
    M.tetrahedron = wrapWithRecorder(M.tetrahedron, 'tetrahedron', paramsForTetrahedron, registry);
  }

  patchCrossSectionInstanceProto(wasm, registry);

  return { registry };
}

// ───────────── Mesh extraction ──────────────────────────────────────────

interface MeshGLLike {
  triVerts: Uint32Array;
  runIndex?: Uint32Array;
  runOriginalID?: Uint32Array;
  runTransform?: Float32Array;
}

const IDENTITY_TRANSFORM: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * Build the wire payload (features list + per-triangle feature index)
 * from a finished MeshGL. Two runs with the same originalID and the
 * same transform collapse into one feature; same id with a different
 * transform becomes a new instance ("sphere#1", "sphere#2").
 *
 * Triangles whose source isn't in the registry — which can happen for
 * `Manifold.ofMesh()`, `asOriginal()`, `levelSet()`, etc. — get an
 * 'unknown#N' label so the viewer never has to render an empty pill.
 */
export function extractFeaturePayload(mesh: ManifoldMesh, store: FeatureStore): FeaturePayload {
  const m = mesh as unknown as MeshGLLike;
  const triCount = m.triVerts.length / 3;
  const triFeatureIds = new Uint32Array(triCount);
  const features: ViewerFeature[] = [];

  if (!m.runIndex || !m.runOriginalID || m.runOriginalID.length === 0) {
    // No provenance metadata — emit a single catch-all feature.
    features.push({ label: 'unknown#1', kind: 'unknown', params: {}, transform: [...IDENTITY_TRANSFORM] });
    return { features, triFeatureIds };
  }

  const seqByKind: Partial<Record<FeatureKind, number>> = {};
  const featureByKey = new Map<string, number>();

  for (let r = 0; r < m.runOriginalID.length; r++) {
    const origId = m.runOriginalID[r];
    if (origId === undefined) {
      throw new RangeError(`Mesh run ${r} is missing its original feature ID.`);
    }
    const transformOffset = r * 12;
    const transform =
      m.runTransform && m.runTransform.length >= transformOffset + 12
        ? Array.from(m.runTransform.subarray(transformOffset, transformOffset + 12))
        : [...IDENTITY_TRANSFORM];

    const meta = store.registry.get(origId);
    const kind: FeatureKind = meta?.kind ?? 'unknown';
    const transformKey = transform.map(v => v.toFixed(4)).join(',');
    const key = `${origId}|${transformKey}`;

    let idx = featureByKey.get(key);
    if (idx === undefined) {
      const seq = (seqByKind[kind] = (seqByKind[kind] ?? 0) + 1);
      idx = features.length;
      features.push({
        label: `${kind}#${seq}`,
        kind,
        params: compactFeatureParams(meta?.params ?? {}),
        transform,
      });
      featureByKey.set(key, idx);
    }

    const runStart = m.runIndex[r];
    const runEnd = m.runIndex[r + 1];
    if (runStart === undefined || runEnd === undefined) {
      throw new RangeError(`Mesh run ${r} has an incomplete triangle range.`);
    }
    const triStart = runStart / 3;
    const triEnd = runEnd / 3;
    for (let t = triStart; t < triEnd; t++) {
      triFeatureIds[t] = idx;
    }
  }

  return { features, triFeatureIds };
}

function compactFeatureParams(params: FeatureMeta['params']): ViewerFeatureParams {
  const compact: Record<string, ViewerFeatureParam> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      compact[name] = value;
    }
  }
  return compact;
}
