# Examples

These TypeScript snippets are validated against the live sandbox. Each one is a
complete input you can pass straight to `validate_script` or `execute_script`.
User annotations are optional; these examples do not require any marks.

## 1. Plain centred cube

```ts
result = Manifold.cube([20, 20, 20], true);
```

## 2. Cube minus sphere — the canonical CSG example

> Adapted from [manifold/bindings/wasm/documents/bindings.md](https://github.com/elalish/manifold/blob/master/bindings/wasm/documents/bindings.md)
> (Apache-2.0).

```ts
const { cube, sphere } = Manifold;
const box = cube([100, 100, 100], true);
const ball = sphere(60, 100);
result = box.subtract(ball);
```

## 3. Hollow box (parametric wall thickness)

```ts
const wall = 1.6;
const outerSize: [number, number, number] = [40, 30, 20];
const innerSize: [number, number, number] = [outerSize[0] - 2 * wall, outerSize[1] - 2 * wall, outerSize[2] - 2 * wall];

const outer = Manifold.cube(outerSize, true);
const cavity = Manifold.cube(innerSize, true).translate([0, 0, wall / 2]);
result = outer.subtract(cavity);
```

## 4. Tube (extrude an annulus)

```ts
const ring = CrossSection.circle(10, 96).subtract(CrossSection.circle(8, 96));
result = Manifold.extrude(ring, 50);
```

## 5. Vase (revolve a profile)

```ts
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

## 6. Rounded plate with cutouts

```ts
const plate = CrossSection.square([60, 30], true).offset(4, 'Round', 2, 32);

const holes = CrossSection.compose([
  CrossSection.circle(2, 32).translate([-22, 10]),
  CrossSection.circle(2, 32).translate([22, 10]),
  CrossSection.circle(2, 32).translate([-22, -10]),
  CrossSection.circle(2, 32).translate([22, -10]),
]);

result = Manifold.extrude(plate.subtract(holes), 4);
```

## 7. Stack of plates (loop + union)

```ts
const plates: Manifold[] = [];
for (let i = 0; i < 6; i++) {
  plates.push(Manifold.cube([20 - i * 2, 20 - i * 2, 2], true).translate([0, 0, i * 2]));
}
result = Manifold.union(...plates);
```

## 8. Simple gyroid lattice (implicit surface)

> Note: `levelSet` cost grows fast; keep the bounds small and `edgeLength`
> generous, otherwise expect a `TIMEOUT`.

```ts
result = Manifold.levelSet(
  p => Math.cos(p[0]) * Math.sin(p[1]) + Math.cos(p[1]) * Math.sin(p[2]) + Math.cos(p[2]) * Math.sin(p[0]),
  { min: [-Math.PI, -Math.PI, -Math.PI], max: [Math.PI, Math.PI, Math.PI] },
  0.5,
);
```
