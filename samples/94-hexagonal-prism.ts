/**
 * 94-hexagonal-prism — Regular hexagonal solid
 *
 * A 100 mm tall prism with a 50 mm circumradius, centered at the origin.
 */

{
  const radius = 50;
  const sides = 6;
  const outline: Vec2[] = Array.from({ length: sides }, (_, index) => {
    const angle = (index * 2 * Math.PI) / sides;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });

  const hexagon = CrossSection.ofPolygons([outline]);
  result = Manifold.extrude(hexagon, 100, 0, 0, [1, 1], true);
}
