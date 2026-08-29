/** Upstream manifold-3d types used at the worker and feature-recognition boundary. */
import type {
  Manifold as UpstreamManifold,
  ManifoldToplevel as UpstreamManifoldToplevel,
  Mesh as UpstreamMesh,
  Vec3 as UpstreamVec3,
} from 'manifold-3d';

export type Vec3 = UpstreamVec3;
export type ManifoldMesh = UpstreamMesh;
export type ManifoldInstance = UpstreamManifold;
export type ManifoldToplevel = UpstreamManifoldToplevel;

/**
 * Anything constructible. Used by `runner/worker.ts` for the generic
 * `trackConstructor` wrapper that bolts GC tracking onto Embind classes.
 * This is an internal utility rather than an upstream manifold-3d type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyConstructor = new (...args: any[]) => unknown;
