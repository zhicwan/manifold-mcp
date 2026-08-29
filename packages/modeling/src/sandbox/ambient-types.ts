/**
 * Ambient TypeScript declarations injected into the virtual sandbox snippet
 * program. These model only the sandbox globals and the small Manifold API
 * surface documented for agents; they are intentionally not a complete
 * manifold-3d declaration file.
 */
export const sandboxAmbientDeclarations = String.raw`
type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Mat3 = [number, number, number, number, number, number];
type Mat4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
type Rect = { min: Vec2; max: Vec2 };
type Box = { min: Vec3; max: Vec3 };
type Polygons = Vec2[][];
type FillRule = 'EvenOdd' | 'NonZero' | 'Positive' | 'Negative';
type JoinType = 'Square' | 'Round' | 'Miter';
type Smoothness = { halfedge: number; smoothness: number };
type ErrorStatus =
  | 'NoError'
  | 'NonFiniteVertex'
  | 'NotManifold'
  | 'VertexOutOfBounds'
  | 'PropertiesWrongLength'
  | 'MissingPositionProperties'
  | 'MergeVectorsDifferentLengths'
  | 'MergeIndexOutOfBounds'
  | 'TransformWrongLength'
  | 'RunIndexWrongLength'
  | 'FaceIDWrongLength'
  | 'InvalidConstruction'
  | 'ResultTooLarge'
  | 'InvalidTangents'
  | 'Cancelled';

interface Console {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

// eslint-disable-next-line no-var
declare var console: Console;

declare class Mesh {
  constructor(mesh?: Mesh);
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  numProp: number;
  runIndex?: Uint32Array;
  runOriginalID?: Uint32Array;
  runTransform?: Float32Array;
  faceID?: Uint32Array;
  halfedgeTangent?: Float32Array;

  merge(): boolean;
}

declare class CrossSection {
  constructor(contours: Polygons, fillRule?: FillRule);

  static square(size?: Vec2 | number, center?: boolean): CrossSection;
  static circle(radius: number, circularSegments?: number): CrossSection;
  static ofPolygons(contours: Polygons, fillRule?: FillRule): CrossSection;
  static union(...crossSections: CrossSection[]): CrossSection;
  static difference(...crossSections: CrossSection[]): CrossSection;
  static intersection(...crossSections: CrossSection[]): CrossSection;
  static compose(parts: CrossSection[]): CrossSection;
  static hull(parts: Array<CrossSection | Vec2>): CrossSection;

  add(other: CrossSection | Polygons): CrossSection;
  subtract(other: CrossSection | Polygons): CrossSection;
  intersect(other: CrossSection | Polygons): CrossSection;
  decompose(): CrossSection[];

  translate(v: Vec2): CrossSection;
  rotate(degrees: number): CrossSection;
  scale(v: Vec2 | number): CrossSection;
  mirror(normal: Vec2): CrossSection;
  transform(m3: Mat3): CrossSection;
  warp(fn: (vert: Vec2) => void): CrossSection;

  offset(delta: number, joinType?: JoinType, miterLimit?: number, circularSegments?: number): CrossSection;
  hull(): CrossSection;
  simplify(epsilon?: number): CrossSection;

  extrude(height: number, nDivisions?: number, twistDegrees?: number, scaleTop?: Vec2, center?: boolean): Manifold;
  revolve(circularSegments?: number, revolveDegrees?: number): Manifold;
}

declare class Manifold {
  constructor(mesh: Mesh);

  static cube(size?: Vec3 | number, center?: boolean): Manifold;
  static sphere(radius: number, circularSegments?: number): Manifold;
  static cylinder(
    height: number,
    radiusLow: number,
    radiusHigh?: number,
    circularSegments?: number,
    center?: boolean,
  ): Manifold;
  static tetrahedron(): Manifold;
  static extrude(
    crossSection: CrossSection | Polygons,
    height: number,
    nDivisions?: number,
    twistDegrees?: number,
    scaleTop?: Vec2,
    center?: boolean,
  ): Manifold;
  static revolve(crossSection: CrossSection | Polygons, circularSegments?: number, revolveDegrees?: number): Manifold;
  static levelSet(
    sdf: (p: Vec3) => number,
    bounds: Box,
    edgeLength: number,
    level?: number,
    tolerance?: number,
  ): Manifold;
  static union(...manifolds: Manifold[]): Manifold;
  static difference(...manifolds: Manifold[]): Manifold;
  static intersection(...manifolds: Manifold[]): Manifold;
  static compose(parts: Manifold[]): Manifold;
  static hull(parts: Array<Manifold | Vec3>): Manifold;
  static ofMesh(mesh: Mesh): Manifold;

  add(other: Manifold): Manifold;
  subtract(other: Manifold): Manifold;
  intersect(other: Manifold): Manifold;
  decompose(): Manifold[];

  translate(v: Vec3): Manifold;
  translate(x: number, y?: number, z?: number): Manifold;
  rotate(v: Vec3): Manifold;
  rotate(x: number, y?: number, z?: number): Manifold;
  scale(v: Vec3 | number): Manifold;
  mirror(normal: Vec3): Manifold;
  transform(m4: Mat4): Manifold;
  warp(fn: (vert: Vec3) => void): Manifold;

  trimByPlane(normal: Vec3, originOffset: number): Manifold;
  split(cutter: Manifold): [Manifold, Manifold];
  splitByPlane(normal: Vec3, originOffset: number): [Manifold, Manifold];
  slice(height: number): CrossSection;
  project(): CrossSection;

  refine(n: number): Manifold;
  refineToLength(maxEdgeLength: number): Manifold;
  refineToTolerance(tolerance: number): Manifold;
  static smooth(mesh: Mesh, sharpenedEdges?: Smoothness[]): Manifold;
  smoothByNormals(normalIdx: number): Manifold;
  smoothOut(minSharpAngle?: number, minSmoothness?: number): Manifold;

  setProperties(
    numProp: number,
    propFunc: (newProps: number[], position: Vec3, oldProps: number[]) => void,
  ): Manifold;

  numTri(): number;
  numVert(): number;
  volume(): number;
  surfaceArea(): number;
  genus(): number;
  boundingBox(): Box;
  isEmpty(): boolean;
  status(): ErrorStatus;
  tolerance(): number;
  setTolerance(tolerance: number): Manifold;
  getMesh(normalIdx?: number): Mesh;

  asOriginal(): Manifold;
  originalID(): number;
}

declare let result: Manifold;
`;
