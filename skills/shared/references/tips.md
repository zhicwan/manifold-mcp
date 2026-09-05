# Tips and Tricks

> Source: [manifold/bindings/wasm/documents/tips.md](https://github.com/elalish/manifold/blob/master/bindings/wasm/documents/tips.md)
> (Apache-2.0). Adjusted to drop ManifoldCAD-specific phrasing.

## Handling Precision Issues

> [!WARNING]
> Geometry where two manifolds are meant to share a face exactly is called
> **marginal geometry** and should generally be avoided. Manifold uses symbolic
> perturbation, which means multiple topologically valid results may be within
> rounding error of each other — so even small imprecisions can produce
> unexpected output.

Two common sources of trouble:

- **Floating point drift** — JavaScript uses IEEE 754 binary floating point,
  so `0.1 + 0.2` evaluates to `0.30000000000000004`. Manifold does not
  compensate for this. A bounding-box maximum of `0.30000000000000004` instead
  of `0.3` is enough to prevent a union from closing properly.
- **Different triangulations** — even with floating-point identical
  coordinates, if two coplanar faces are triangulated differently, that can
  also lead to gaps and slivers.

Where marginal geometry is unavoidable, the recommended workaround for
floating point drift is to **work in larger, integer-friendly units**:

1. Scale coordinates up by a round factor (e.g. 1000) so your values are
   whole numbers.
2. Use `Math.round()` after any arithmetic to eliminate accumulated drift.
3. Perform all Manifold operations.
4. Scale the result back down if needed.

```ts
const scale = 1000;

// Instead of cube([0.1, 0.1, 0.1]) translated by [0.2, 0.2, 0.2]:
const size = Math.round(0.1 * scale); // 100
const offset = Math.round(0.2 * scale); // 200

const { cube } = Manifold;
result = cube([size, size, size]).translate([offset, offset, offset]);
```

See [discussion #1135](https://github.com/elalish/manifold/discussions/1135)
for more context.

## Degrees vs. Radians

Manifold's rotation API takes **degrees**, not radians. This is a deliberate
design choice: Manifold can eliminate floating point error entirely for
multiples of 90° and uses more efficient code paths when it detects such
rotations.

```ts
// Pass degrees directly
const box = Manifold.cube([10, 10, 10], true);
box.rotate([90, 0, 0]);
box.rotate([0, 45, 0]);
```

If your own code works in radians (e.g. when using `Math.atan2`), convert to
degrees before passing to Manifold:

```ts
const x = 1;
const y = 1;
const box = Manifold.cube([10, 10, 10], true);
const toDeg = (rad: number): number => rad * (180 / Math.PI);
const angle = Math.atan2(y, x); // radians
box.rotate([0, 0, toDeg(angle)]);
```

For common angles, always prefer the exact degree value (`90`, `45`, `30`,
etc.) over a computed approximation to get the precision guarantee. See
[issue #1262](https://github.com/elalish/manifold/issues/1262) for a
real-world example where a rotation of `-89.999999999999` instead of `-90`
caused mesh cracks.
