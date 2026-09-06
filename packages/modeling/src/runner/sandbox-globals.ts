/**
 * Sandbox global scrub (SEC-1).
 *
 * The runner worker is a regular Node `worker_threads` Worker, so it
 * inherits the full Node global surface (process, require, Buffer,
 * module, __dirname, __filename) at startup. We delete those bindings
 * plus dynamic-code entry points from `globalThis`, disconnect the
 * intrinsic Function-family constructors from their prototypes, and
 * freeze the primordials used by the runner so user snippets can't:
 *
 *   * reach the host filesystem / spawn child processes (`process`,
 *     `require('child_process')`),
 *   * synthesize Node typed-array views over arbitrary memory
 *     (`Buffer.alloc`, `SharedArrayBuffer`),
 *   * recover `Function`/`AsyncFunction`/generator constructors and hide
 *     a dynamic `import()` inside newly compiled source,
 *   * monkey-patch shared primordials and corrupt post-execution cleanup
 *     or result processing in the same request.
 *
 * Lifecycle (CRITICAL — do not reorder relative to bootstrap()):
 *
 *   1. Module-load: `worker.ts` captures trusted refs (setImmediate,
 *      stderr.write) BEFORE this scrub runs, otherwise it cannot get
 *      them back after `process` is gone.
 *   2. Bootstrap: WASM init + Embind class registration + feature
 *      recognition install must run BEFORE the scrub. Embind probes the
 *      global namespace for some symbols at registration time, and our
 *      feature-recognition patches read the freshly registered
 *      `CrossSection.prototype` — both rely on globals the scrub will
 *      remove.
 *   3. Scrub: call `scrubSandboxGlobals()` once before the worker accepts
 *      its single request.
 *
 * This is defense-in-depth inside a same-process Worker, not OS-level
 * isolation. Tests: tests/security/sandbox-escape.test.ts is the
 * regression net for this module's correctness.
 */

const SCRUB_NAMES: readonly string[] = [
  'process',
  'require',
  'Buffer',
  'module',
  '__dirname',
  '__filename',
  'global',
  'globalThis',
  'eval',
  'AsyncFunction',
  'GeneratorFunction',
  'AsyncGeneratorFunction',
  'SharedArrayBuffer',
  'Atomics',
];

const dynamicFunctionSamples = {
  async asyncFunction() {
    await Promise.resolve();
  },
  *generatorFunction() {
    yield undefined;
  },
  async *asyncGeneratorFunction() {
    await Promise.resolve();
    yield undefined;
  },
};

const asyncFunctionPrototype = Object.getPrototypeOf(dynamicFunctionSamples.asyncFunction) as object;
const generatorFunctionPrototype = Object.getPrototypeOf(dynamicFunctionSamples.generatorFunction) as object;
const asyncGeneratorFunctionPrototype = Object.getPrototypeOf(dynamicFunctionSamples.asyncGeneratorFunction) as object;

const dynamicFunctionPrototypes = [
  Function.prototype,
  asyncFunctionPrototype,
  generatorFunctionPrototype,
  asyncGeneratorFunctionPrototype,
] as const;

const dynamicFunctionConstructors = dynamicFunctionPrototypes.flatMap(prototype => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  return typeof descriptor?.value === 'function' ? [descriptor.value as object] : [];
});

const typedArrayConstructors = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

const iteratorSamples: object[] = [
  [][Symbol.iterator](),
  [].keys(),
  [].values(),
  [].entries(),
  new Map<unknown, unknown>()[Symbol.iterator](),
  new Map<unknown, unknown>().keys(),
  new Map<unknown, unknown>().values(),
  new Map<unknown, unknown>().entries(),
  new Set<unknown>()[Symbol.iterator](),
  new Set<unknown>().keys(),
  new Set<unknown>().values(),
  new Set<unknown>().entries(),
  ''[Symbol.iterator](),
  new Uint8Array()[Symbol.iterator](),
  new Uint8Array().keys(),
  new Uint8Array().values(),
  new Uint8Array().entries(),
  dynamicFunctionSamples.generatorFunction(),
  dynamicFunctionSamples.asyncGeneratorFunction(),
];

const iteratorPrototypes = (() => {
  const prototypes = new Set<object>();
  for (const iterator of iteratorSamples) {
    let prototype = Object.getPrototypeOf(iterator) as object | null;
    while (prototype && prototype !== Object.prototype) {
      prototypes.add(prototype);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }
  return [...prototypes];
})();

const protectedPrimordials = [
  Object,
  Object.prototype,
  Function,
  Function.prototype,
  Array,
  Array.prototype,
  Map,
  Map.prototype,
  Set,
  Set.prototype,
  WeakMap,
  WeakMap.prototype,
  WeakSet,
  WeakSet.prototype,
  Promise,
  Promise.prototype,
  RegExp,
  RegExp.prototype,
  Date,
  Date.prototype,
  Error,
  Error.prototype,
  EvalError,
  EvalError.prototype,
  RangeError,
  RangeError.prototype,
  ReferenceError,
  ReferenceError.prototype,
  SyntaxError,
  SyntaxError.prototype,
  TypeError,
  TypeError.prototype,
  URIError,
  URIError.prototype,
  Number,
  Number.prototype,
  String,
  String.prototype,
  Boolean,
  Boolean.prototype,
  Symbol,
  Symbol.prototype,
  BigInt,
  BigInt.prototype,
  ArrayBuffer,
  ArrayBuffer.prototype,
  SharedArrayBuffer,
  SharedArrayBuffer.prototype,
  DataView,
  DataView.prototype,
  Object.getPrototypeOf(Uint8Array),
  Object.getPrototypeOf(Uint8Array.prototype),
  ...typedArrayConstructors,
  ...typedArrayConstructors.map(Constructor => Constructor.prototype),
  Math,
  JSON,
  Reflect,
  Atomics,
  ...dynamicFunctionConstructors,
  ...dynamicFunctionPrototypes,
  ...iteratorPrototypes,
] as const;

/**
 * Remove the host-capability bindings from the worker's global scope and
 * freeze the prototypes user code might want to mutate. Idempotent —
 * safe to call multiple times, though only the first call has any
 * effect.
 *
 * Must run AFTER WASM init + feature-recognition install (see lifecycle
 * comment above).
 */
export function scrubSandboxGlobals(): void {
  for (const prototype of dynamicFunctionPrototypes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (descriptor !== undefined && descriptor.value === undefined && descriptor.configurable === false) {
      continue;
    }
    Object.defineProperty(prototype, 'constructor', {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  for (const primordial of protectedPrimordials) {
    Object.freeze(primordial);
  }

  // Emscripten lazily calls the realm's global Function while binding some
  // Embind methods. Keep that frozen intrinsic available to library code;
  // worker.ts shadows the identifier for user code, deletes global-object
  // access, and disconnects every user-reachable constructor prototype.
  const scrubTarget = globalThis as Record<string, unknown>;
  for (const name of SCRUB_NAMES) {
    try {
      if (!delete scrubTarget[name]) {
        scrubTarget[name] = undefined;
      }
    } catch {
      scrubTarget[name] = undefined;
    }
  }
}
