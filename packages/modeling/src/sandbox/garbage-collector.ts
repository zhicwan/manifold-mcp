// Copyright 2025 The Manifold Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Source: D:\Personal\repos\manifold\bindings\wasm\lib\garbage-collector.ts
//   (https://github.com/elalish/manifold/blob/master/bindings/wasm/lib/garbage-collector.ts)
//
// Local edits:
//   - Replaced .d.ts type imports with structural `Deletable` so this file
//     builds standalone inside this project (the runtime contract is identical).
//   - Added `garbageCollectInstance(obj)` so we can also track objects produced
//     by `new Manifold(...)` / `new Mesh(...)` style constructors that monkey-
//     patching alone misses (Codex review finding).
//   - MNT-6: count `delete()` failures during cleanup and surface a
//     GC_DELETE_FAILED hint via `getLastCleanupDeleteFailures()`. Earlier
//     versions silently swallowed these errors, hiding WASM heap pressure
//     and use-after-free conditions.
//   - Deduplicate objects and arrays by identity within a run so results
//     reached through multiple wrappers are deleted exactly once.

interface Deletable {
  delete?: () => void;
}

type Tracked = Deletable | Deletable[];

const memoryRegistry: Tracked[] = [];
let trackedIdentities = new WeakSet<object>();

/**
 * MNT-6 instrumentation. We accumulate the number of suppressed `delete()`
 * failures during the most recent `cleanup()` call so the worker can surface
 * a hint without a control-flow plumbed callback.
 */
let lastCleanupDeleteFailures = 0;

/**
 * Number of `delete()` calls swallowed by the most recent `cleanup()`.
 * Reset to zero at the start of every `cleanup()` invocation. Read from
 * the worker after cleanup completes to decide whether to attach a
 * GC_DELETE_FAILED hint to the run report.
 */
export const getLastCleanupDeleteFailures = (): number => lastCleanupDeleteFailures;

/**
 * Has-shape guard for the `Tracked` cast. We can't use `instanceof` here
 * (manifold's Embind classes have hidden internal prototypes), so we
 * settle for "looks like an object" — the values reaching the registry
 * came from `garbageCollectFunction` / `garbageCollectInstance` which
 * already null-checked them, so this is a defence-in-depth.
 */
function isTracked(obj: unknown): obj is Tracked {
  return obj !== null && obj !== undefined && (typeof obj === 'object' || Array.isArray(obj));
}

function registerTracked(obj: Tracked): void {
  if (trackedIdentities.has(obj)) {
    return;
  }
  trackedIdentities.add(obj);
  memoryRegistry.push(obj);
}

/** Delete any objects tagged for garbage collection. */
export const cleanup = (): void => {
  const pending = memoryRegistry.splice(0);
  trackedIdentities = new WeakSet<object>();
  const releasedIdentities = new WeakSet<object>();
  let failures = 0;

  const release = (obj: Tracked): void => {
    if (releasedIdentities.has(obj)) {
      return;
    }
    releasedIdentities.add(obj);
    if (Array.isArray(obj)) {
      for (const elem of obj) {
        if (isTracked(elem)) {
          release(elem);
        }
      }
      return;
    }

    try {
      obj.delete?.();
    } catch {
      failures++;
    }
  };

  for (const obj of pending) {
    release(obj);
  }
  lastCleanupDeleteFailures = failures;
};

/** Manually register an instance (e.g. produced by `new Manifold(mesh)`). */
export const garbageCollectInstance = <T>(obj: T): T => {
  if (isTracked(obj)) {
    registerTracked(obj);
  }
  return obj;
};

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Intercept function calls for garbage collection. The returned object of the
 * call will be added to the garbage collection list. When `cleanup()` is
 * called, the `delete()` method on that object will be called.
 */
export const garbageCollectFunction = (originalFn: AnyFn): AnyFn => {
  return function (this: unknown, ...args: unknown[]) {
    const result = originalFn.apply(this, args);
    if (isTracked(result)) {
      registerTracked(result);
    }
    return result;
  };
};

const interceptMethods = (target: Record<string, unknown> | undefined, methodNames: string[]): void => {
  if (!target) {
    return;
  }
  for (const name of methodNames) {
    const originalFn = target[name];
    if (typeof originalFn === 'function') {
      target[name] = garbageCollectFunction(originalFn as AnyFn);
    }
  }
};

// manifold static methods (that return a new manifold)
const manifoldStaticFunctions = [
  'cube',
  'cylinder',
  'sphere',
  'tetrahedron',
  'extrude',
  'revolve',
  'compose',
  'union',
  'difference',
  'intersection',
  'levelSet',
  'smooth',
  'ofMesh',
  'hull',
];

// manifold member functions (that return a new manifold)
const manifoldMemberFunctions = [
  'add',
  'subtract',
  'intersect',
  'decompose',
  'warp',
  'transform',
  'translate',
  'rotate',
  'scale',
  'mirror',
  'calculateCurvature',
  'calculateNormals',
  'smoothByNormals',
  'smoothOut',
  'refine',
  'refineToLength',
  'refineToTolerance',
  'setProperties',
  'setTolerance',
  'simplify',
  'asOriginal',
  'trimByPlane',
  'split',
  'splitByPlane',
  'slice',
  'project',
  'hull',
];

// CrossSection static methods (that return a new cross-section)
const crossSectionStaticFunctions = [
  'square',
  'circle',
  'union',
  'difference',
  'intersection',
  'compose',
  'ofPolygons',
  'hull',
];

// CrossSection member functions (that return a new cross-section)
const crossSectionMemberFunctions = [
  'add',
  'subtract',
  'intersect',
  'rectClip',
  'decompose',
  'transform',
  'translate',
  'rotate',
  'scale',
  'mirror',
  'simplify',
  'offset',
  'hull',
];

interface ConstructorWithProto {
  prototype: object;
}

interface ManifoldNamespace {
  Manifold: ConstructorWithProto;
  CrossSection: ConstructorWithProto;
}

/**
 * Set up garbage collection for a white listed set of methods belonging to the
 * Manifold WASM module.
 */
export const garbageCollectManifold = <T extends ManifoldNamespace>(target: T): T => {
  interceptMethods(target.Manifold as unknown as Record<string, unknown>, manifoldStaticFunctions);
  interceptMethods(target.Manifold.prototype as Record<string, unknown>, manifoldMemberFunctions);
  interceptMethods(target.CrossSection as unknown as Record<string, unknown>, crossSectionStaticFunctions);
  interceptMethods(target.CrossSection.prototype as Record<string, unknown>, crossSectionMemberFunctions);
  interceptMethods(runtimePrototypeFromFactory(target.Manifold, 'cube'), manifoldMemberFunctions);
  interceptMethods(runtimePrototypeFromFactory(target.CrossSection, 'square'), crossSectionMemberFunctions);
  return target;
};

function runtimePrototypeFromFactory(
  Constructor: ConstructorWithProto,
  factoryName: string,
): Record<string, unknown> | undefined {
  const factory = (Constructor as unknown as Record<string, unknown>)[factoryName];
  if (typeof factory !== 'function') {
    return undefined;
  }
  const probe = factory.call(Constructor);
  if (!isTracked(probe) || Array.isArray(probe)) {
    return undefined;
  }
  return Object.getPrototypeOf(probe) as Record<string, unknown> | undefined;
}
