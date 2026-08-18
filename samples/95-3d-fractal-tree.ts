/**
 * 95-3d-fractal-tree — Recursive three-way spatial branching
 *
 * Each branch produces three children distributed around its own axis.
 * Small node spheres give every angled junction a reliable volumetric
 * overlap, keeping the complete fractal as one watertight solid.
 */

{
  const parts: Manifold[] = [];
  const branchSegments = 16;
  const nodeSegments = 20;

  const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const multiply = (v: Vec3, scalar: number): Vec3 => [v[0] * scalar, v[1] * scalar, v[2] * scalar];
  const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
  const normalize = (v: Vec3): Vec3 => {
    const magnitude = length(v);
    return [v[0] / magnitude, v[1] / magnitude, v[2] / magnitude];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  const branchBetween = (start: Vec3, end: Vec3, radiusStart: number, radiusEnd: number): Manifold => {
    const delta = subtract(end, start);
    const branchLength = length(delta);
    const direction = normalize(delta);
    const tilt = (Math.acos(direction[2]) * 180) / Math.PI;
    const azimuth = (Math.atan2(direction[1], direction[0]) * 180) / Math.PI;

    return Manifold.cylinder(branchLength, radiusStart, radiusEnd, branchSegments)
      .rotate([0, tilt, azimuth])
      .translate(start);
  };

  const grow = (
    start: Vec3,
    direction: Vec3,
    branchLength: number,
    radiusStart: number,
    depth: number,
    phaseDegrees: number,
  ): void => {
    const axis = normalize(direction);
    const end = add(start, multiply(axis, branchLength));
    const radiusEnd = radiusStart * 0.68;

    parts.push(branchBetween(start, end, radiusStart, radiusEnd));
    parts.push(Manifold.sphere(radiusEnd * 1.12, nodeSegments).translate(end));

    if (depth === 0) {
      return;
    }

    const reference: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const basisU = normalize(cross(axis, reference));
    const basisV = normalize(cross(axis, basisU));
    const branchAngle = (34 * Math.PI) / 180;
    const axialWeight = Math.cos(branchAngle);
    const radialWeight = Math.sin(branchAngle);

    for (let child = 0; child < 3; child++) {
      const azimuth = ((phaseDegrees + child * 120) * Math.PI) / 180;
      const radial = add(multiply(basisU, Math.cos(azimuth)), multiply(basisV, Math.sin(azimuth)));
      const childDirection = normalize(add(multiply(axis, axialWeight), multiply(radial, radialWeight)));
      const childLengthScale = depth === 1 ? 0.52 : 0.67;
      grow(end, childDirection, branchLength * childLengthScale, radiusEnd, depth - 1, phaseDegrees + 37 + child * 11);
    }
  };

  // A flat pedestal makes the branching sculpture stable and printable.
  parts.push(Manifold.cylinder(10, 22, 18, 48));
  grow([0, 0, 5], [0, 0, 1], 92, 8, 5, 0);

  result = Manifold.union(...parts).scale(6.2);
}
