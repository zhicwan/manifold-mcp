import { deflateSync } from 'node:zlib';

import * as THREE from 'three';

import type { WireAnnotation } from '@manifold3d/protocol/wire/annotations.js';
import type { ModelArtifact } from '../runner/protocol.js';

export type CaptureView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface RenderViewOptions {
  view?: CaptureView;
  width?: number;
  height?: number;
  /** Overlay annotations supplied by the preview server. Defaults false. */
  includeAnnotations?: boolean;
  annotations?: readonly WireAnnotation[];
}

export interface RenderResult {
  png: Buffer;
  /** Actual rendered dimensions (after clamping). */
  width: number;
  height: number;
}

export interface PreviewRenderer {
  renderView(mesh: ModelArtifact, opts?: RenderViewOptions): Promise<RenderResult>;
  dispose(): void;
}

interface RasterContext {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly faceIds: Uint32Array;
}

interface ProjectedVertex {
  x: number;
  y: number;
  z: number;
}

interface Face {
  id: number;
  ia: number;
  ib: number;
  ic: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  pa: ProjectedVertex;
  pb: ProjectedVertex;
  pc: ProjectedVertex;
  normal: THREE.Vector3;
  visible: boolean;
  color: [number, number, number];
}

interface EdgeRecord {
  a: number;
  b: number;
  faces: Face[];
}

const BACKGROUND: [number, number, number] = [0xf3, 0xf4, 0xf6];
const GRID_COLOR: [number, number, number] = [0xd5, 0xda, 0xe1];
const EDGE_COLOR: [number, number, number] = [28, 37, 52];
const LABEL_COLOR: [number, number, number] = [31, 41, 55];
const POINT_COLOR: [number, number, number] = [236, 72, 153];
const REGION_COLOR: [number, number, number] = [245, 158, 11];
const SKETCH_COLOR: [number, number, number] = [14, 165, 233];
const LABEL_BG: [number, number, number] = [255, 255, 255];
const CLAY_BASE = new THREE.Color(0xc9cdd3);
const EDGE_ANGLE_RADIANS = THREE.MathUtils.degToRad(25);
const EDGE_COS_THRESHOLD = Math.cos(EDGE_ANGLE_RADIANS);

export function createRenderer(): PreviewRenderer {
  return new SoftwarePreviewRenderer();
}

class SoftwarePreviewRenderer implements PreviewRenderer {
  async renderView(mesh: ModelArtifact, opts: RenderViewOptions = {}): Promise<RenderResult> {
    const width = clampDimension(opts.width ?? 1024);
    const height = clampDimension(opts.height ?? 1024);
    const view = opts.view ?? 'iso';
    const vertices = unpackPositions(mesh);
    const indices = new Uint32Array(mesh.triVerts);
    const bbox = computeBounds(vertices, mesh);
    // Keep camera transforms and grid indices independent of the world-space offset.
    const origin = bbox.center.clone();
    for (const vertex of vertices) {
      vertex.sub(origin);
    }
    bbox.min.sub(origin);
    bbox.max.sub(origin);
    bbox.center.set(0, 0, 0);
    const camera = createCamera(view, width, height, bbox);
    const ctx = createRasterContext(width, height);

    drawGrid(ctx, camera, bbox, width, height);
    drawBlobShadow(ctx, camera, bbox, width, height);

    // Yield to the event loop between heavy phases so that other MCP
    // requests (validate_script, get_annotations, WebSocket heartbeats)
    // are not starved during large renders.
    await yieldToEventLoop();

    const faces = buildFaces(vertices, indices, camera, width, height);
    for (const face of faces) {
      if (face.visible) {
        drawTriangle(ctx, face);
      }
    }

    await yieldToEventLoop();

    drawCreaseEdges(ctx, faces);
    if (opts.includeAnnotations === true && opts.annotations && opts.annotations.length > 0) {
      drawAnnotationOverlay(ctx, camera, opts.annotations, origin, view, width, height);
    }
    drawAxisGizmo(ctx, camera);
    drawText(ctx, 18, 18, `${view.toUpperCase()} VIEW`, LABEL_COLOR, 2);

    return { png: encodePng(ctx), width, height };
  }

  dispose(): void {
    // No-op: the renderer is stateless.
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 1024;
  }
  return Math.max(128, Math.min(2048, Math.round(value)));
}

function createRasterContext(width: number, height: number): RasterContext {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  const faceIds = new Uint32Array(width * height);
  depth.fill(Number.POSITIVE_INFINITY);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BACKGROUND[0];
    rgba[i + 1] = BACKGROUND[1];
    rgba[i + 2] = BACKGROUND[2];
    rgba[i + 3] = 255;
  }
  return { width, height, rgba, depth, faceIds };
}

function unpackPositions(mesh: ModelArtifact): THREE.Vector3[] {
  const properties = new Float32Array(mesh.vertProperties);
  const vertices: THREE.Vector3[] = [];
  for (let i = 0; i < mesh.vertices; i += 1) {
    vertices.push(
      new THREE.Vector3(
        properties[i * mesh.numProp + 0] ?? 0,
        properties[i * mesh.numProp + 1] ?? 0,
        properties[i * mesh.numProp + 2] ?? 0,
      ),
    );
  }
  return vertices;
}

function computeBounds(
  vertices: readonly THREE.Vector3[],
  mesh: ModelArtifact,
): { min: THREE.Vector3; max: THREE.Vector3; center: THREE.Vector3; radius: number } {
  const min = new THREE.Vector3().fromArray(mesh.bboxMin);
  const max = new THREE.Vector3().fromArray(mesh.bboxMax);
  if (!Number.isFinite(min.x) || !Number.isFinite(max.x) || min.equals(max)) {
    const box = new THREE.Box3().setFromPoints([...vertices]);
    if (!box.isEmpty()) {
      min.copy(box.min);
      max.copy(box.max);
    }
  }
  const center = new THREE.Box3(min, max).getCenter(new THREE.Vector3());
  const size = new THREE.Vector3().subVectors(max, min);
  const radius = Math.max(size.x, size.y, size.z, 1);
  return { min, max, center, radius };
}

function createCamera(
  view: CaptureView,
  width: number,
  height: number,
  bbox: { min: THREE.Vector3; max: THREE.Vector3; center: THREE.Vector3; radius: number },
): THREE.OrthographicCamera {
  const aspect = width / height;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, bbox.radius * 20);
  const dir = viewDirection(view);
  camera.position.copy(bbox.center).addScaledVector(dir, bbox.radius * 4);
  camera.up.copy(viewUp(view));
  camera.lookAt(bbox.center);
  camera.updateMatrixWorld();
  let projectedHalfWidth = 0;
  let projectedHalfHeight = 0;
  for (const x of [bbox.min.x, bbox.max.x]) {
    for (const y of [bbox.min.y, bbox.max.y]) {
      for (const z of [bbox.min.z, bbox.max.z]) {
        const corner = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        projectedHalfWidth = Math.max(projectedHalfWidth, Math.abs(corner.x));
        projectedHalfHeight = Math.max(projectedHalfHeight, Math.abs(corner.y));
      }
    }
  }
  // Retain the cardinal-view padding (0.82 * full extent), in both dimensions.
  const halfHeight = Math.max(projectedHalfHeight, projectedHalfWidth / aspect, 0.5) * 1.64;
  camera.left = -halfHeight * aspect;
  camera.right = halfHeight * aspect;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
  return camera;
}

function viewDirection(view: CaptureView): THREE.Vector3 {
  switch (view) {
    case 'front':
      return new THREE.Vector3(0, -1, 0);
    case 'back':
      return new THREE.Vector3(0, 1, 0);
    case 'left':
      return new THREE.Vector3(-1, 0, 0);
    case 'right':
      return new THREE.Vector3(1, 0, 0);
    case 'top':
      return new THREE.Vector3(0, 0, 1);
    case 'bottom':
      return new THREE.Vector3(0, 0, -1);
    case 'iso':
      return new THREE.Vector3(1, -1, 1).normalize();
  }
}

function viewUp(view: CaptureView): THREE.Vector3 {
  if (view === 'top') {
    return new THREE.Vector3(0, 1, 0);
  }
  if (view === 'bottom') {
    return new THREE.Vector3(0, -1, 0);
  }
  return new THREE.Vector3(0, 0, 1);
}

function buildFaces(
  vertices: readonly THREE.Vector3[],
  indices: Uint32Array,
  camera: THREE.Camera,
  vw: number,
  vh: number,
): Face[] {
  const faces: Face[] = [];
  const lightA = new THREE.Vector3(0.45, -0.55, 0.78).normalize();
  const lightB = new THREE.Vector3(-0.6, 0.25, 0.45).normalize();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];
    if (ia === undefined || ib === undefined || ic === undefined) {
      continue;
    }
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    if (!a || !b || !c) {
      continue;
    }
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const centroid = new THREE.Vector3()
      .addVectors(a, b)
      .add(c)
      .multiplyScalar(1 / 3);
    const viewVector = new THREE.Vector3().subVectors(camera.position, centroid).normalize();
    const visible = normal.dot(viewVector) > 0;
    const shade = Math.min(
      1,
      Math.max(0.33, 0.45 + 0.4 * Math.max(0, normal.dot(lightA)) + 0.2 * Math.max(0, normal.dot(lightB))),
    );
    const color = CLAY_BASE.clone().multiplyScalar(shade);
    faces.push({
      id: i / 3 + 1,
      ia,
      ib,
      ic,
      a,
      b,
      c,
      pa: project(a, camera, vw, vh),
      pb: project(b, camera, vw, vh),
      pc: project(c, camera, vw, vh),
      normal,
      visible,
      color: [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)],
    });
  }
  return faces;
}

function drawTriangle(ctx: RasterContext, face: Face): void {
  const minX = Math.max(0, Math.floor(Math.min(face.pa.x, face.pb.x, face.pc.x)));
  const maxX = Math.min(ctx.width - 1, Math.ceil(Math.max(face.pa.x, face.pb.x, face.pc.x)));
  const minY = Math.max(0, Math.floor(Math.min(face.pa.y, face.pb.y, face.pc.y)));
  const maxY = Math.min(ctx.height - 1, Math.ceil(Math.max(face.pa.y, face.pb.y, face.pc.y)));
  const area = edge(face.pa, face.pb, face.pc.x, face.pc.y);
  if (Math.abs(area) < Number.EPSILON) {
    return;
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = edge(face.pb, face.pc, px, py) / area;
      const w1 = edge(face.pc, face.pa, px, py) / area;
      const w2 = edge(face.pa, face.pb, px, py) / area;
      if (w0 < 0 || w1 < 0 || w2 < 0) {
        continue;
      }
      const z = w0 * face.pa.z + w1 * face.pb.z + w2 * face.pc.z;
      const depthOffset = y * ctx.width + x;
      const currentDepth = ctx.depth[depthOffset];
      if (currentDepth === undefined) {
        throw new RangeError(`Raster depth offset ${depthOffset} is out of bounds.`);
      }
      if (z >= currentDepth) {
        continue;
      }
      ctx.depth[depthOffset] = z;
      ctx.faceIds[depthOffset] = face.id;
      setPixel(ctx, x, y, face.color);
    }
  }
}

function drawCreaseEdges(ctx: RasterContext, faces: readonly Face[]): void {
  const edges = new Map<string, EdgeRecord>();
  const add = (a: number, b: number, face: Face): void => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const cur = edges.get(key) ?? { a, b, faces: [] };
    cur.faces.push(face);
    edges.set(key, cur);
  };
  for (const face of faces) {
    add(face.ia, face.ib, face);
    add(face.ib, face.ic, face);
    add(face.ic, face.ia, face);
  }
  for (const record of edges.values()) {
    if (!shouldDrawEdge(record)) {
      continue;
    }
    const face = record.faces.find(f => f.visible) ?? record.faces[0];
    if (!face) {
      throw new Error('Raster edge has no owning face.');
    }
    const start = projectedForIndex(face, record.a);
    const end = projectedForIndex(face, record.b);
    if (start && end) {
      drawLine(ctx, start, end, EDGE_COLOR, 2, {
        start: start.z,
        end: end.z,
        faceIds: record.faces.map(owner => owner.id),
      });
    }
  }
}

function shouldDrawEdge(edgeRecord: EdgeRecord): boolean {
  if (edgeRecord.faces.some(face => face.visible) === false) {
    return false;
  }
  if (edgeRecord.faces.length !== 2) {
    return true;
  }
  const [a, b] = edgeRecord.faces;
  if (!a || !b) {
    throw new Error('Two-face raster edge is missing an owning face.');
  }
  return a.normal.dot(b.normal) < EDGE_COS_THRESHOLD;
}

function projectedForIndex(face: Face, index: number): ProjectedVertex | null {
  if (face.ia === index) {
    return face.pa;
  }
  if (face.ib === index) {
    return face.pb;
  }
  if (face.ic === index) {
    return face.pc;
  }
  return null;
}

function drawGrid(
  ctx: RasterContext,
  camera: THREE.OrthographicCamera,
  bbox: { min: THREE.Vector3 },
  vw: number,
  vh: number,
): void {
  const z = bbox.min.z;
  const direction = camera.getWorldDirection(new THREE.Vector3());
  if (Math.abs(direction.z) < 1e-8) {
    // The ground plane is edge-on in the horizontal presets.
    const ground = project(new THREE.Vector3(0, 0, z), camera, vw, vh);
    drawLine(ctx, { x: 0, y: ground.y }, { x: vw - 1, y: ground.y }, GRID_COLOR, 1);
    return;
  }
  const corners: THREE.Vector3[] = [];
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      const corner = new THREE.Vector3(x, y, 0).unproject(camera);
      corner.addScaledVector(direction, (z - corner.z) / direction.z);
      corners.push(corner);
    }
  }
  const minX = Math.min(...corners.map(corner => corner.x));
  const maxX = Math.max(...corners.map(corner => corner.x));
  const minY = Math.min(...corners.map(corner => corner.y));
  const maxY = Math.max(...corners.map(corner => corner.y));
  const lineBudget = Math.max(1, Math.ceil(Math.max(vw, vh) / 32));
  const targetStep = Math.max(maxX - minX, maxY - minY) / lineBudget;
  const decade = 10 ** Math.floor(Math.log10(targetStep));
  const fraction = targetStep / decade;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * decade;
  const firstX = Math.ceil(minX / step);
  const firstY = Math.ceil(minY / step);
  const countX = Math.min(lineBudget + 1, Math.floor(maxX / step) - firstX + 1);
  const countY = Math.min(lineBudget + 1, Math.floor(maxY / step) - firstY + 1);
  for (let i = 0; i < countX; i += 1) {
    const x = (firstX + i) * step;
    drawLine(
      ctx,
      project(new THREE.Vector3(x, minY, z), camera, vw, vh),
      project(new THREE.Vector3(x, maxY, z), camera, vw, vh),
      GRID_COLOR,
      1,
    );
  }
  for (let i = 0; i < countY; i += 1) {
    const y = (firstY + i) * step;
    drawLine(
      ctx,
      project(new THREE.Vector3(minX, y, z), camera, vw, vh),
      project(new THREE.Vector3(maxX, y, z), camera, vw, vh),
      GRID_COLOR,
      1,
    );
  }
}

function drawBlobShadow(
  ctx: RasterContext,
  camera: THREE.Camera,
  bbox: { min: THREE.Vector3; max: THREE.Vector3; center: THREE.Vector3 },
  vw: number,
  vh: number,
): void {
  const corners = [
    new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
    new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
    new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z),
    new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
  ].map(corner => project(corner, camera, vw, vh));
  const minX = Math.min(...corners.map(c => c.x));
  const maxX = Math.max(...corners.map(c => c.x));
  const minY = Math.min(...corners.map(c => c.y));
  const maxY = Math.max(...corners.map(c => c.y));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(8, (maxX - minX) * 0.58);
  const ry = Math.max(5, (maxY - minY) * 0.38);
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(vh - 1, Math.ceil(cy + ry)); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(vw - 1, Math.ceil(cx + rx)); x += 1) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) {
        blendPixel(ctx, x, y, [75, 85, 99], Math.round((1 - d) * 46));
      }
    }
  }
}

function drawAxisGizmo(ctx: RasterContext, camera: THREE.Camera): void {
  const axes: Array<{ label: string; dir: THREE.Vector3; color: [number, number, number] }> = [
    { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: [220, 38, 38] },
    { label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: [22, 163, 74] },
    { label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: [37, 99, 235] },
  ];
  const base = { x: ctx.width - 76, y: ctx.height - 58, z: 0 };
  for (const axis of axes) {
    const direction = axis.dir.transformDirection(camera.matrixWorldInverse);
    const dx = direction.x;
    const dy = -direction.y;
    const len = Math.hypot(dx, dy);
    // A camera-aligned axis is a point, not a normalized roundoff vector.
    const pixelScale = len > 1e-8 ? 30 / len : 0;
    const end = { x: base.x + dx * pixelScale, y: base.y + dy * pixelScale, z: 0 };
    drawLine(ctx, base, end, axis.color, 2);
    drawText(ctx, Math.round(end.x + 3), Math.round(end.y - 4), axis.label, axis.color, 1);
  }
}

function drawAnnotationOverlay(
  ctx: RasterContext,
  camera: THREE.Camera,
  annotations: readonly WireAnnotation[],
  origin: THREE.Vector3,
  captureView: CaptureView,
  vw: number,
  vh: number,
): void {
  for (const annotation of annotations) {
    if (annotation.kind === 'sketch') {
      drawSketchAnnotation(ctx, camera, annotation, origin, captureView, vw, vh);
      continue;
    }
    const anchor = project(new THREE.Vector3().fromArray(annotation.worldCoord).sub(origin), camera, vw, vh);
    if (annotation.kind === 'point') {
      drawDot(ctx, anchor, POINT_COLOR, 5);
      drawLabel(ctx, Math.round(anchor.x + 9), Math.round(anchor.y - 10), annotation.partLabel, POINT_COLOR);
    } else {
      drawRegionAnchor(ctx, anchor, REGION_COLOR);
      drawLabel(ctx, Math.round(anchor.x + 10), Math.round(anchor.y - 10), annotation.partLabel, REGION_COLOR);
    }
  }
}

function drawSketchAnnotation(
  ctx: RasterContext,
  camera: THREE.Camera,
  annotation: WireAnnotation,
  origin: THREE.Vector3,
  captureView: CaptureView,
  vw: number,
  vh: number,
): void {
  if (!annotation.viewPlane || !annotation.planeOrigin || !annotation.strokes) {
    const anchor = project(new THREE.Vector3().fromArray(annotation.worldCoord).sub(origin), camera, vw, vh);
    drawRegionAnchor(ctx, anchor, SKETCH_COLOR);
    drawLabel(ctx, Math.round(anchor.x + 10), Math.round(anchor.y - 10), annotation.partLabel, SKETCH_COLOR);
    return;
  }

  const thickness = captureView === annotation.viewPlane ? 3 : 2;
  let labelAnchor: ProjectedVertex | undefined;
  for (const stroke of annotation.strokes) {
    let previous: ProjectedVertex | undefined;
    for (const point of stroke) {
      const projected = project(
        sketchPointToLocal(annotation.viewPlane, annotation.planeOrigin, point, origin),
        camera,
        vw,
        vh,
      );
      labelAnchor ??= projected;
      if (previous) {
        drawLine(ctx, previous, projected, SKETCH_COLOR, thickness);
      } else {
        drawDot(ctx, projected, SKETCH_COLOR, 2);
      }
      previous = projected;
    }
  }

  const anchor =
    labelAnchor ?? project(new THREE.Vector3().fromArray(annotation.worldCoord).sub(origin), camera, vw, vh);
  drawDot(ctx, anchor, SKETCH_COLOR, captureView === annotation.viewPlane ? 4 : 3);
  drawLabel(ctx, Math.round(anchor.x + 9), Math.round(anchor.y - 10), annotation.partLabel, SKETCH_COLOR);
}

function sketchPointToLocal(
  viewPlane: NonNullable<WireAnnotation['viewPlane']>,
  planeOrigin: [number, number, number],
  point: [number, number],
  origin: THREE.Vector3,
): THREE.Vector3 {
  const basis = sketchPlaneBasis(viewPlane);
  return new THREE.Vector3()
    .fromArray(planeOrigin)
    .sub(origin)
    .addScaledVector(basis.u, point[0])
    .addScaledVector(basis.v, point[1]);
}

function sketchPlaneBasis(viewPlane: NonNullable<WireAnnotation['viewPlane']>): { u: THREE.Vector3; v: THREE.Vector3 } {
  switch (viewPlane) {
    case 'front':
      return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) };
    case 'back':
      return { u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 0, 1) };
    case 'left':
      return { u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1) };
    case 'right':
      return { u: new THREE.Vector3(0, -1, 0), v: new THREE.Vector3(0, 0, 1) };
    case 'top':
      return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) };
    case 'bottom':
      return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, -1, 0) };
  }
}

function project(vertex: THREE.Vector3, camera: THREE.Camera, vw: number, vh: number): ProjectedVertex {
  const projected = vertex.clone().project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * vw,
    y: (-projected.y * 0.5 + 0.5) * vh,
    z: projected.z,
  };
}

function edge(a: ProjectedVertex, b: ProjectedVertex, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

interface ClippedLinePoint {
  x: number;
  y: number;
  t: number;
}

function clipLine(
  ctx: RasterContext,
  start: Pick<ProjectedVertex, 'x' | 'y'>,
  end: Pick<ProjectedVertex, 'x' | 'y'>,
  radius: number,
): [ClippedLinePoint, ClippedLinePoint] | null {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) {
    return null;
  }
  const minX = -radius;
  const minY = -radius;
  const maxX = ctx.width - 1 + radius;
  const maxY = ctx.height - 1 + radius;
  const code = (p: ClippedLinePoint): number =>
    (p.x < minX ? 1 : p.x > maxX ? 2 : 0) | (p.y < minY ? 4 : p.y > maxY ? 8 : 0);
  let a = { ...start, t: 0 };
  let b = { ...end, t: 1 };
  // Cohen-Sutherland clipping: each intersection fixes a viewport boundary.
  // Clip coordinates themselves, not just t, which can round to the same value
  // at both ends of a very long line crossing a small viewport.
  for (let i = 0; i < 8; i += 1) {
    const codeA = code(a);
    const codeB = code(b);
    if ((codeA | codeB) === 0) {
      return [a, b];
    }
    if ((codeA & codeB) !== 0) {
      return null;
    }
    const outside = codeA || codeB;
    let x: number;
    let y: number;
    let t: number;
    if (outside & 12) {
      y = outside & 4 ? minY : maxY;
      t = (y - a.y) / (b.y - a.y);
      x = a.x + (b.x - a.x) * t;
    } else {
      x = outside & 1 ? minX : maxX;
      t = (x - a.x) / (b.x - a.x);
      y = a.y + (b.y - a.y) * t;
    }
    const intersection = { x, y, t: a.t + (b.t - a.t) * t };
    if (outside === codeA) {
      a = intersection;
    } else {
      b = intersection;
    }
  }
  return null;
}

function drawLine(
  ctx: RasterContext,
  start: Pick<ProjectedVertex, 'x' | 'y'>,
  end: Pick<ProjectedVertex, 'x' | 'y'>,
  color: [number, number, number],
  thickness: number,
  depthTest?: { start: number; end: number; faceIds: readonly number[] },
): void {
  const radius = Math.max(0, Math.floor(thickness / 2));
  const clipped = clipLine(ctx, start, end, radius);
  if (!clipped) {
    return;
  }
  const [a, b] = clipped;
  const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    const originalT = a.t + (b.t - a.t) * t;
    const z = depthTest ? depthTest.start + (depthTest.end - depthTest.start) * originalT : 0;
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        const px = x + ox;
        const py = y + oy;
        if (px < 0 || px >= ctx.width || py < 0 || py >= ctx.height) {
          continue;
        }
        if (depthTest) {
          const offset = py * ctx.width + px;
          // The edge footprint may differ from the face sample on a slope.
          // Its own visible face proves coverage without a large depth bias
          // that would also expose nearby hidden solids. Other surfaces get
          // only a Float32-rounding allowance. UI lines remain depth-free.
          const ownsPixel = depthTest.faceIds.includes(ctx.faceIds[offset]!);
          if (!ownsPixel && z > ctx.depth[offset]! + 1e-6) {
            continue;
          }
        }
        setPixel(ctx, px, py, color);
      }
    }
  }
}

function drawDot(
  ctx: RasterContext,
  center: Pick<ProjectedVertex, 'x' | 'y'>,
  color: [number, number, number],
  radius: number,
): void {
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  for (let oy = -radius - 1; oy <= radius + 1; oy += 1) {
    for (let ox = -radius - 1; ox <= radius + 1; ox += 1) {
      const x = cx + ox;
      const y = cy + oy;
      const d = Math.hypot(ox, oy);
      if (d <= radius) {
        setPixel(ctx, x, y, color);
      } else if (d <= radius + 1.4) {
        setPixel(ctx, x, y, LABEL_COLOR);
      }
    }
  }
}

function drawRegionAnchor(
  ctx: RasterContext,
  center: Pick<ProjectedVertex, 'x' | 'y'>,
  color: [number, number, number],
): void {
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  drawLine(ctx, { x: cx - 6, y: cy }, { x: cx, y: cy - 6 }, color, 2);
  drawLine(ctx, { x: cx, y: cy - 6 }, { x: cx + 6, y: cy }, color, 2);
  drawLine(ctx, { x: cx + 6, y: cy }, { x: cx, y: cy + 6 }, color, 2);
  drawLine(ctx, { x: cx, y: cy + 6 }, { x: cx - 6, y: cy }, color, 2);
  drawLine(ctx, { x: cx - 9, y: cy }, { x: cx + 9, y: cy }, LABEL_COLOR, 1);
  drawLine(ctx, { x: cx, y: cy - 9 }, { x: cx, y: cy + 9 }, LABEL_COLOR, 1);
}

function drawLabel(ctx: RasterContext, x: number, y: number, text: string, color: [number, number, number]): void {
  const label = normalizeLabel(text);
  const scale = 1;
  const width = textWidth(label, scale) + 6;
  const height = 11;
  fillRect(ctx, x - 3, y - 2, width, height, LABEL_BG);
  drawRect(ctx, x - 3, y - 2, width, height, color);
  drawText(ctx, x, y, label, color, scale);
}

function normalizeLabel(text: string): string {
  const normalized = text.toUpperCase().replace(/[^A-Z0-9# _-]/g, ' ');
  return normalized.trim().slice(0, 18) || 'MARK';
}

function textWidth(text: string, scale: number): number {
  let width = 0;
  for (const char of text) {
    const glyph = FONT[char] ?? BLANK_GLYPH;
    width += (glyph[0].length + 1) * scale;
  }
  return Math.max(0, width - scale);
}

function fillRect(
  ctx: RasterContext,
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number],
): void {
  for (let yy = Math.max(0, y); yy < Math.min(ctx.height, y + height); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(ctx.width, x + width); xx += 1) {
      setPixel(ctx, xx, yy, color);
    }
  }
}

function drawRect(
  ctx: RasterContext,
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number],
): void {
  drawLine(ctx, { x, y }, { x: x + width - 1, y }, color, 1);
  drawLine(ctx, { x: x + width - 1, y }, { x: x + width - 1, y: y + height - 1 }, color, 1);
  drawLine(ctx, { x: x + width - 1, y: y + height - 1 }, { x, y: y + height - 1 }, color, 1);
  drawLine(ctx, { x, y: y + height - 1 }, { x, y }, color, 1);
}

function setPixel(ctx: RasterContext, x: number, y: number, color: [number, number, number]): void {
  if (x < 0 || x >= ctx.width || y < 0 || y >= ctx.height) {
    return;
  }
  const offset = (y * ctx.width + x) * 4;
  ctx.rgba[offset] = color[0];
  ctx.rgba[offset + 1] = color[1];
  ctx.rgba[offset + 2] = color[2];
  ctx.rgba[offset + 3] = 255;
}

function blendPixel(ctx: RasterContext, x: number, y: number, color: [number, number, number], alpha: number): void {
  if (x < 0 || x >= ctx.width || y < 0 || y >= ctx.height || alpha <= 0) {
    return;
  }
  const offset = (y * ctx.width + x) * 4;
  const a = alpha / 255;
  const red = ctx.rgba[offset];
  const green = ctx.rgba[offset + 1];
  const blue = ctx.rgba[offset + 2];
  if (red === undefined || green === undefined || blue === undefined) {
    throw new RangeError(`Raster color offset ${offset} is out of bounds.`);
  }
  ctx.rgba[offset] = Math.round(red * (1 - a) + color[0] * a);
  ctx.rgba[offset + 1] = Math.round(green * (1 - a) + color[1] * a);
  ctx.rgba[offset + 2] = Math.round(blue * (1 - a) + color[2] * a);
  ctx.rgba[offset + 3] = 255;
}

type Glyph = readonly [string, ...string[]];

const BLANK_GLYPH: Glyph = ['0', '0', '0', '0', '0', '0', '0'];

const FONT: Readonly<Record<string, Glyph>> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['010', '110', '010', '010', '010', '010', '111'],
  '2': ['11110', '00001', '00001', '01110', '10000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['10001', '10001', '10001', '11111', '00001', '00001', '00001'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01111', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '11110'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '-': ['0', '0', '0', '111', '0', '0', '0'],
  _: ['0', '0', '0', '0', '0', '0', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ' ': BLANK_GLYPH,
};

function drawText(
  ctx: RasterContext,
  x: number,
  y: number,
  text: string,
  color: [number, number, number],
  scale: number,
): void {
  let cursor = x;
  for (const char of text) {
    const glyph = FONT[char] ?? BLANK_GLYPH;
    for (let row = 0; row < glyph.length; row += 1) {
      const pixels = glyph[row];
      if (pixels === undefined) {
        continue;
      }
      for (let col = 0; col < pixels.length; col += 1) {
        if (pixels[col] !== '1') {
          continue;
        }
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            setPixel(ctx, cursor + col * scale + sx, y + row * scale + sy, color);
          }
        }
      }
    }
    cursor += (glyph[0].length + 1) * scale;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    const tableValue = crcTable[(c ^ byte) & 0xff];
    if (tableValue === undefined) {
      throw new RangeError('CRC lookup index is out of bounds.');
    }
    c = tableValue ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function encodePng(ctx: RasterContext): Buffer {
  const scanlineLength = ctx.width * 4 + 1;
  const raw = Buffer.alloc(scanlineLength * ctx.height);
  for (let y = 0; y < ctx.height; y += 1) {
    const rawOffset = y * scanlineLength;
    const rgbaOffset = y * ctx.width * 4;
    raw[rawOffset] = 0;
    Buffer.from(ctx.rgba.buffer, ctx.rgba.byteOffset + rgbaOffset, ctx.width * 4).copy(raw, rawOffset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(ctx.width, 0);
  header.writeUInt32BE(ctx.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
