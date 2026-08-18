/**
 * 93-vr-longsword — True-scale sword for WebXR grab testing
 *
 * Overall dimensions are kept below the 500 mm validation threshold.
 * The blade points along +Z so it appears upright in the desktop viewer
 * and maps naturally into the viewer's Z-up → WebXR Y-up conversion.
 */

{
  const bladeVertices: Vec3[] = [
    [-23, 0, -2],
    [23, 0, -2],
    [0, -3.5, -2],
    [0, 3.5, -2],
    [-13, 0, 270],
    [13, 0, 270],
    [0, -2.5, 270],
    [0, 2.5, 270],
    [0, 0, 340],
  ];
  const blade = Manifold.hull(bladeVertices);

  // The crossguard overlaps both blade and grip so the result is one solid.
  const guardBar = Manifold.cylinder(170, 7.5, 6.5, 48, true).rotate([0, 90, 0]).translate([0, 0, -7]);
  const guardCenter = Manifold.sphere(16, 48).scale([1.65, 0.8, 0.55]).translate([0, 0, -7]);
  const guardEnds = Manifold.union(
    Manifold.sphere(9, 32).scale([1.2, 1, 1]).translate([-85, 0, -7]),
    Manifold.sphere(9, 32).scale([1.2, 1, 1]).translate([85, 0, -7]),
  );

  const grip = Manifold.cylinder(110, 11.5, 10.5, 48, true).translate([0, 0, -65]);
  const gripRings = Manifold.union(
    ...[-22, -40, -58, -76, -94, -112].map(z => Manifold.cylinder(3.2, 12.3, 12.3, 40, true).translate([0, 0, z])),
  );

  const pommelNeck = Manifold.cylinder(18, 10, 12, 40, true).translate([0, 0, -119]);
  const pommel = Manifold.sphere(18, 48).scale([0.85, 0.72, 1.1]).translate([0, 0, -134]);

  result = Manifold.union(blade, guardBar, guardCenter, guardEnds, grip, gripRings, pommelNeck, pommel);
}
