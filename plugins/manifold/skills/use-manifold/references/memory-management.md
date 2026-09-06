# Memory Management

> Source: [manifold/bindings/wasm/documents/bindings.md](https://github.com/elalish/manifold/blob/master/bindings/wasm/documents/bindings.md)
> (Apache-2.0).

Upstream warning for applications using the bindings directly:

> Since Manifold is a WASM module, it does not automatically garbage-collect
> like regular JavaScript. You must manually `delete()` each object
> constructed by your scripts (both `Manifold` and `CrossSection`).

The managed sandbox used by both plugins takes ownership of those objects for
you. The upstream manual-deletion advice does not apply inside these snippets.

## Managed cleanup

Each validation or execution call runs in its own short-lived worker thread.
Inside that worker a registry adapted from the upstream
[`garbage-collector.ts`](https://github.com/elalish/manifold/blob/master/bindings/wasm/lib/garbage-collector.ts)
helper tracks results of the wrapped factories and instance methods. The
`Manifold`, `Mesh` and `CrossSection` constructors are wrapped too. After the
result is inspected and any model artifact is built, cleanup releases the
tracked instances before the worker exits.

**Do not manually call `delete()` in sandbox snippets.** It is not exposed by
the sandbox's ambient API. Bypassing the type check does not transfer ownership:
manually deleted instances remain registered, so cleanup can attempt a second
release and report `GC_DELETE_FAILED`.

```ts
const tower: Manifold[] = [];
for (let i = 0; i < 50; i++) {
  const block = Manifold.cube([10, 10, 1], true).translate([0, 0, i]);
  tower.push(block);
}
result = Manifold.union(...tower);
// Cleanup owns the blocks, their intermediates, and the final Manifold.
```

## Allocation-heavy scripts

If a run reports `OUT_OF_MEMORY`, reduce tessellation and the number or
complexity of intermediate operations. Use smaller independent cases while
iterating, with each run constructing the complete result it needs.

The registry retains tracked instances until cleanup. Clearing an array or
dropping a variable does not eagerly release their WASM memory, and manual
deletion is not a supported memory optimization in this sandbox.

## What you must **not** do

- Do not assume an instance survives past the end of your script. Once
  `result` is consumed and the report is built, every Manifold the worker
  saw is destroyed.
- Do not try to share state between successive `execute_script` calls. Each
  run is a fresh worker; the previous run's `Manifold` instances are gone.
