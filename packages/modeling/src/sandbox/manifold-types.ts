/**
 * Re-exports of the upstream `manifold-3d` types we use, plus a small
 * manifold3d-mcp-local extension for the constructor-wrapping pattern in
 * `runner/worker.ts`.
 *
 * Before MNT-5 this module declared its own structural mirrors of the
 * upstream types because the original concern was that pulling the
 * upstream `.d.ts` would either be too large or browser-shaped. Those
 * concerns no longer apply: the package ships a focused
 * `manifold.d.ts` and our existing call sites already match the
 * upstream signatures. Re-exporting keeps every `as unknown as
 * ManifoldToplevel` cast behaviourally identical while letting
 * TypeScript catch drift when manifold-3d updates land.
 */
import type {
  Box as UpstreamBox,
  CrossSection as UpstreamCrossSection,
  Manifold as UpstreamManifold,
  ManifoldToplevel as UpstreamManifoldToplevel,
  Mesh as UpstreamMesh,
  Vec3 as UpstreamVec3,
} from 'manifold-3d';

export type Vec3 = UpstreamVec3;
export type ManifoldBox = UpstreamBox;
export type ManifoldMesh = UpstreamMesh;
export type ManifoldInstance = UpstreamManifold;
export type ManifoldToplevel = UpstreamManifoldToplevel;
export type ManifoldCrossSection = UpstreamCrossSection;

/**
 * Anything constructible. Used by `runner/worker.ts` for the generic
 * `trackConstructor` wrapper that bolts GC tracking onto Embind classes.
 * Not provided by upstream — it's a manifold3d-mcp-internal utility.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyConstructor = new (...args: any[]) => unknown;
