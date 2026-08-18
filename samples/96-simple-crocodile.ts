/**
 * 96-simple-crocodile — Stylized single-solid crocodile
 *
 * The animal faces +X. Rounded primitive unions keep the shape simple,
 * readable, and light enough for interactive VR inspection.
 */

{
  const sphere = (center: Vec3, radius: number, scale: Vec3 = [1, 1, 1]): Manifold =>
    Manifold.sphere(radius, 32).scale(scale).translate(center);

  const taperedSegment = (start: Vec3, startRadius: number, end: Vec3, endRadius: number): Manifold =>
    Manifold.hull([Manifold.sphere(startRadius, 24).translate(start), Manifold.sphere(endRadius, 24).translate(end)]);

  const body = sphere([-15, 0, 20], 50, [1.9, 0.9, 0.65]);
  const head = sphere([88, 0, 23], 42, [1.45, 0.88, 0.68]);
  const snout = sphere([158, 0, 18], 38, [1.65, 0.78, 0.52]);

  // A shallow through-cut separates upper and lower jaws while both remain
  // connected at the rear of the head.
  const mouthCut = Manifold.cube([125, 75, 5], true).translate([170, 0, 16]);
  const face = head.add(snout).subtract(mouthCut);

  const eyes = Manifold.union(sphere([112, -27, 47], 8, [1, 0.9, 1.15]), sphere([112, 27, 47], 8, [1, 0.9, 1.15]));

  const tail = Manifold.union(
    taperedSegment([-92, 0, 20], 38, [-150, 2, 18], 28),
    taperedSegment([-150, 2, 18], 28, [-198, 14, 16], 18),
    taperedSegment([-198, 14, 16], 18, [-232, 28, 18], 7),
  );

  const makeLeg = (x: number, side: -1 | 1): Manifold => {
    const hip: Vec3 = [x, side * 34, 7];
    const ankle: Vec3 = [x + 5, side * 72, -7];
    const leg = taperedSegment(hip, 14, ankle, 10);
    const foot = sphere([x + 16, side * 80, -8], 12, [1.5, 0.75, 0.48]);
    return leg.add(foot);
  };

  const legs = Manifold.union(makeLeg(-58, -1), makeLeg(-58, 1), makeLeg(42, -1), makeLeg(42, 1));

  // Low rounded scutes add a recognizable crocodile back silhouette.
  const scutes = Manifold.union(...[-70, -42, -14, 14, 42, 70].map(x => sphere([x, 0, 51], 9, [1.25, 0.65, 0.7])));

  result = Manifold.union(body, face, eyes, tail, legs, scutes);
}
