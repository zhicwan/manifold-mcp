# CrossSection API (2D building blocks)

> Source: [manifold/bindings/wasm/manifold-encapsulated-types.d.ts](https://github.com/elalish/manifold/blob/master/bindings/wasm/manifold-encapsulated-types.d.ts)
> (Apache-2.0).

`CrossSection` represents a set of non-self-intersecting 2D polygons. You build
or import a CrossSection, optionally combine and offset it, then turn it into
a `Manifold` via `Manifold.extrude(...)` or `Manifold.revolve(...)`.

## Static constructors

```ts
CrossSection.square(size: Vec2 | number = [1,1], center?: boolean): CrossSection
CrossSection.circle(radius: number, circularSegments?: number): CrossSection
CrossSection.ofPolygons(contours: Polygons, fillRule?: FillRule): CrossSection

// Booleans
CrossSection.union(...c: CrossSection[]): CrossSection
CrossSection.difference(...c: CrossSection[]): CrossSection
CrossSection.intersection(...c: CrossSection[]): CrossSection
CrossSection.compose(parts: CrossSection[]): CrossSection
CrossSection.hull(parts: Array<CrossSection | Vec2>): CrossSection
```

`Polygons` = `Vec2[][]`: the first ring is the outer boundary, additional
rings are holes (CCW outer, CW holes is the safest convention).

When using the default `'Positive'` fill rule, keep outer contours
counter-clockwise and holes clockwise. If a simple `ofPolygons` profile reports
`INVALID_CONSTRUCTION`, validate that profile by itself and try reversing the
outer point order before debugging unrelated booleans.

## Constructor

```ts
new CrossSection(contours: Polygons, fillRule?: FillRule)
```

`FillRule` is `'EvenOdd' | 'NonZero' | 'Positive' | 'Negative'` (default
`'Positive'`).

## Booleans (instance form)

```ts
c.add(other: CrossSection | Polygons): CrossSection
c.subtract(other: CrossSection | Polygons): CrossSection
c.intersect(other: CrossSection | Polygons): CrossSection
c.rectClip(rect: Rect): CrossSection
```

## Transforms

```ts
c.translate(v: Vec2 | number, y?: number): CrossSection
c.rotate(degrees: number): CrossSection
c.scale(v: Vec2 | number): CrossSection
c.mirror(normal: Vec2): CrossSection
c.transform(m3: Mat3): CrossSection
c.warp(fn: (vert: Vec2) => void): CrossSection
```

## Offset / hull / simplify

```ts
c.offset(delta: number,
         joinType?: JoinType,           // 'Square' | 'Round' | 'Miter'
         miterLimit?: number,
         circularSegments?: number): CrossSection
c.hull(): CrossSection
c.simplify(epsilon?: number): CrossSection
```

## Going from 2D to 3D

```ts
Manifold.extrude(c, height,
                 nDivisions?, twistDegrees?, scaleTop?, center?): Manifold
Manifold.revolve(c, circularSegments?, revolveDegrees?): Manifold
```

`extrude` is the workhorse for prismatic shapes; `revolve` produces lathes.
Both forms below are valid:

```ts
const profile = CrossSection.circle(10, 64);
const a = Manifold.extrude(profile, 4);
const b = profile.extrude(4);
```

## Idioms

```ts
// Rounded rectangle plate.
const plate = CrossSection.square([60, 30], true).offset(4, 'Round', 2, 32);
result = Manifold.extrude(plate, 4);
```

There is no `CrossSection.roundedRectangle(...)` helper. Build rounded
rectangles by offsetting a smaller square:

```ts
const w = 60;
const h = 30;
const r = 4;
const rounded = CrossSection.square([w - 2 * r, h - 2 * r], true).offset(r, 'Round', 2, 32);
result = Manifold.extrude(rounded, 4);
```

```ts
// Pipe = annulus extruded.
const ring = CrossSection.circle(10, 64).subtract(CrossSection.circle(8, 64));
result = Manifold.extrude(ring, 50);
```

```ts
// Vase = revolved profile.
const profile = new CrossSection([
  [
    [0, 0],
    [25, 0],
    [22, 30],
    [12, 60],
    [16, 90],
    [0, 90],
  ],
]);
result = Manifold.revolve(profile, 96);
```
