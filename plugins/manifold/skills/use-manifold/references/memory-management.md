# Memory Management

> Source: [manifold/bindings/wasm/documents/bindings.md](https://github.com/elalish/manifold/blob/master/bindings/wasm/documents/bindings.md)
> (Apache-2.0).

Upstream warning, verbatim:

> Since Manifold is a WASM module, it does not automatically garbage-collect
> like regular JavaScript. You must manually `delete()` each object
> constructed by your scripts (both `Manifold` and `CrossSection`).

## What this server does for you

Each `validate_script` / `execute_script` call runs in its own short-lived
worker thread. Inside that worker we install the official
[`garbage-collector.ts`](https://github.com/elalish/manifold/blob/master/bindings/wasm/lib/garbage-collector.ts)
helper, which monkey-patches every Manifold/CrossSection factory and member
method that returns a new instance and tracks each result in a per-run
registry. We **also** wrap the `Manifold` / `Mesh` / `CrossSection`
constructors so that `new Manifold(mesh)` style calls are tracked too. When
your script returns, every tracked object has `delete()` called on it before
the worker exits.

**Practical consequence:** for normal scripts you never need to call
`delete()` yourself.

## When you might still want to call `delete()`

Long, allocation-heavy scripts that exceed the 512 MB worker soft cap will
get killed with `OUT_OF_MEMORY`. If you are in that territory, freeing
intermediate Manifolds eagerly can keep peak memory in bounds:

```ts
const tower: Manifold[] = [];
for (let i = 0; i < 50; i++) {
  const block = Manifold.cube([10, 10, 1], true).translate([0, 0, i]);
  tower.push(block);
}
const stacked = Manifold.union(...tower);

// Free the per-block intermediates immediately; the union no longer needs them.
for (const block of tower) block.delete();

result = stacked;
```

This is purely an optimization — the registry would have done the same thing
at the end of the run.

## What you must **not** do

- Do not assume an instance survives past the end of your script. Once
  `result` is consumed and the report is built, every Manifold the worker
  saw is destroyed.
- Do not try to share state between successive `execute_script` calls. Each
  run is a fresh worker; the previous run's `Manifold` instances are gone.
