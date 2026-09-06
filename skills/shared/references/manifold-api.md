# Manifold API (the parts you will actually use)

> Source: [manifold/bindings/wasm/manifold-encapsulated-types.d.ts](https://github.com/elalish/manifold/blob/master/bindings/wasm/manifold-encapsulated-types.d.ts)
> (Apache-2.0). Trimmed to what is reachable from the sandbox.

`Manifold` is both a **class** (whose instances represent solid 3D objects)
and a **namespace of static factory methods** that return new `Manifold`
instances. Booleans return new instances too — manifold is immutable.

## Static constructors

```ts
Manifold.cube(size: Vec3 | number = [1,1,1], center: boolean = false): Manifold
Manifold.sphere(radius: number, circularSegments?: number): Manifold
Manifold.cylinder(height: number, radiusLow: number,
                  radiusHigh?: number, circularSegments?: number,
                  center?: boolean): Manifold
Manifold.tetrahedron(): Manifold

// 2D → 3D
Manifold.extrude(crossSection: CrossSection | Polygons,
                 height: number,
                 nDivisions?: number,
                 twistDegrees?: number,
                 scaleTop?: Vec2,
                 center?: boolean): Manifold
Manifold.revolve(crossSection: CrossSection | Polygons,
                 circularSegments?: number,
                 revolveDegrees?: number): Manifold

// Implicit surfaces
Manifold.levelSet(sdf: (p: Vec3) => number,
                  bounds: Box,
                  edgeLength: number,
                  level?: number,
                  tolerance?: number): Manifold

// Combinators (variadic; same as a.add(b).add(c)…)
Manifold.union(...m: Manifold[]): Manifold
Manifold.difference(...m: Manifold[]): Manifold
Manifold.intersection(...m: Manifold[]): Manifold
Manifold.compose(parts: Manifold[]): Manifold

// Hulls
Manifold.hull(parts: Array<Manifold | Vec3>): Manifold

// Mesh I/O
Manifold.ofMesh(mesh: Mesh): Manifold
```

`Vec3` = `[number, number, number]`. `Vec2` = `[number, number]`.
`Polygons` = `Vec2[][]` (one outer ring plus zero or more hole rings).

Factory methods use **positional arguments**, not options objects:

```ts
// Correct: height, radiusLow, radiusHigh, circularSegments, center
const post = Manifold.cylinder(12, 4.2, 4.2, 32, true);

// Wrong: object-style arguments produce invalid or undefined geometry
// const post = Manifold.cylinder({ height: 12, radiusLow: 4.2 });
```

`cylinder` radii are radii, not diameters. For a 10 mm diameter hole, pass
`5`, not `10`.

## Boolean operations (instance form)

```ts
m.add(other: Manifold): Manifold        // union
m.subtract(other: Manifold): Manifold   // difference
m.intersect(other: Manifold): Manifold  // intersection
```

`a.add(b)` and `Manifold.union(a, b)` are equivalent; pick whichever reads
better.

## Transforms

All transforms return a new Manifold; the original is unchanged.

```ts
m.translate(v: Vec3): Manifold
m.translate(x: number, y?: number, z?: number): Manifold
m.rotate(v: Vec3): Manifold              // degrees, NOT radians
m.rotate(x: number, y?: number, z?: number): Manifold
m.scale(v: Vec3 | number): Manifold
m.mirror(normal: Vec3): Manifold
m.transform(m4: Mat4): Manifold          // 12-number affine matrix
m.warp(fn: (vert: Vec3) => void): Manifold   // mutate in place
```

> **Rotations are degrees.** Manifold has special-cased exact handling for
> multiples of 90° — pass `90`, `45`, `-90` literally rather than computing
> from `Math.PI`. See [`tips.md`](tips.md).

## Slicing & projection

```ts
m.trimByPlane(normal: Vec3, originOffset: number): Manifold
m.split(cutter: Manifold): [Manifold, Manifold]   // [inside, outside]
m.splitByPlane(normal: Vec3, originOffset: number): [Manifold, Manifold]
m.slice(height: number): CrossSection             // 2D contour at z = height
m.project(): CrossSection                         // shadow on z = 0
```

## Refinement

```ts
m.refine(n: number): Manifold                    // subdivide each tri n times
m.refineToLength(maxEdge: number): Manifold
m.refineToTolerance(tolerance: number): Manifold
m.smooth(...): Manifold                          // see official docs
m.smoothByNormals(normalIdx: number): Manifold
m.smoothOut(minSharpAngle?: number, minSmoothness?: number): Manifold
```

## Inspection (read-only, do not need `delete()`)

```ts
m.numTri(): number
m.numVert(): number
m.volume(): number
m.surfaceArea(): number
m.genus(): number               // topological genus (donut = 1)
m.boundingBox(): { min: Vec3, max: Vec3 }
m.isEmpty(): boolean
m.status(): ErrorStatus         // 'NoError' if valid; see validation-report.md
m.getMesh(normalIdx?: number): Mesh
```

`Mesh` has fields `vertProperties: Float32Array`, `triVerts: Uint32Array`,
`numProp: number`, plus run/material info. The first 3 floats per vertex are
always position.

## Patterns you will reuse

```ts
// Centered box minus centered ball.
result = Manifold.cube([20, 20, 20], true).subtract(Manifold.sphere(12, 64));
```

```ts
// Hollow shell (Minkowski-style: shell = outer − offsetInward).
const wall = 1.5;
const outer = Manifold.cube([40, 30, 20], true);
const inner = Manifold.cube([40 - 2 * wall, 30 - 2 * wall, 20 - 2 * wall], true);
result = outer.subtract(inner.translate([0, 0, wall]));
```

```ts
// Extrude a 2D shape to 3D.
const profile = CrossSection.circle(10, 64).subtract(CrossSection.circle(8, 64));
result = Manifold.extrude(profile, 30); // tube
```

```ts
// Typed helper for repeated parts.
const makeFoot = (x: number, y: number): Manifold => Manifold.cylinder(6, 3, 3, 32, true).translate([x, y, -3]);

result = Manifold.union(
  Manifold.cube([40, 20, 4], true),
  makeFoot(-15, -7),
  makeFoot(15, -7),
  makeFoot(-15, 7),
  makeFoot(15, 7),
);
```

```ts
// Implicit gyroid (slow! keep edgeLength relatively large).
result = Manifold.levelSet(
  p => Math.cos(p[0]) * Math.sin(p[1]) + Math.cos(p[1]) * Math.sin(p[2]) + Math.cos(p[2]) * Math.sin(p[0]),
  { min: [-Math.PI, -Math.PI, -Math.PI], max: [Math.PI, Math.PI, Math.PI] },
  0.4,
);
```

```ts
// Tilted panel via Manifold.hull — preferred over rotate + trimByPlane.
// See "Tilted / leaning solids" in references/script-conventions.md for
// the full corner-vertex recipe and why this beats trimByPlane.
const corners: Vec3[] = [/* eight tilted corners computed from (tilt, thickness, height) */];
const panel = Manifold.hull(corners);
```
