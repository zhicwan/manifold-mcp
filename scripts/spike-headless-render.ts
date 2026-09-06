/**
 * Intentionally-frozen reference spike for headless rendering.
 * This duplicates logic from packages/modeling/src/preview/renderer.ts on purpose —
 * it serves as a standalone proof-of-concept and should NOT be kept in sync.
 * Run with: npx tsx scripts/spike-headless-render.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import * as THREE from 'three';

const width = 512;
const height = 512;
const outputPath = resolve(process.cwd(), process.env.HEADLESS_RENDER_OUTPUT ?? '/tmp/headless-render-cube.png');
const backend = 'software-rasterizer (three.js geometry/camera + node:zlib PNG)';

type ProjectedVertex = {
  x: number;
  y: number;
  z: number;
};

type Triangle = {
  a: ProjectedVertex;
  b: ProjectedVertex;
  c: ProjectedVertex;
  color: [number, number, number];
};

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
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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

function encodePng(rgba: Uint8ClampedArray): Buffer {
  const scanlineLength = width * 4 + 1;
  const raw = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * scanlineLength;
    const rgbaOffset = y * width * 4;
    raw[rawOffset] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + rgbaOffset, width * 4).copy(raw, rawOffset + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgba: Uint8ClampedArray, x: number, y: number, color: [number, number, number]): void {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return;
  }

  const offset = (y * width + x) * 4;
  rgba[offset] = color[0];
  rgba[offset + 1] = color[1];
  rgba[offset + 2] = color[2];
  rgba[offset + 3] = 255;
}

function edge(a: ProjectedVertex, b: ProjectedVertex, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

function drawTriangle(rgba: Uint8ClampedArray, depth: Float32Array, triangle: Triangle): void {
  const minX = Math.max(0, Math.floor(Math.min(triangle.a.x, triangle.b.x, triangle.c.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(triangle.a.x, triangle.b.x, triangle.c.x)));
  const minY = Math.max(0, Math.floor(Math.min(triangle.a.y, triangle.b.y, triangle.c.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(triangle.a.y, triangle.b.y, triangle.c.y)));
  const area = edge(triangle.a, triangle.b, triangle.c.x, triangle.c.y);

  if (Math.abs(area) < Number.EPSILON) {
    return;
  }

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = edge(triangle.b, triangle.c, px, py) / area;
      const w1 = edge(triangle.c, triangle.a, px, py) / area;
      const w2 = edge(triangle.a, triangle.b, px, py) / area;

      if (w0 < 0 || w1 < 0 || w2 < 0) {
        continue;
      }

      const z = w0 * triangle.a.z + w1 * triangle.b.z + w2 * triangle.c.z;
      const depthOffset = y * width + x;

      if (z >= depth[depthOffset]) {
        continue;
      }

      depth[depthOffset] = z;
      setPixel(rgba, x, y, triangle.color);
    }
  }
}

function drawLine(
  rgba: Uint8ClampedArray,
  start: ProjectedVertex,
  end: ProjectedVertex,
  color: [number, number, number],
): void {
  const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));

  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(start.x + (end.x - start.x) * t);
    const y = Math.round(start.y + (end.y - start.y) * t);
    setPixel(rgba, x, y, color);
  }
}

function project(vertex: THREE.Vector3, camera: THREE.Camera): ProjectedVertex {
  const projected = vertex.clone().project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * width,
    y: (-projected.y * 0.5 + 0.5) * height,
    z: projected.z,
  };
}

function renderCube(): Buffer {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  depth.fill(Number.POSITIVE_INFINITY);

  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 245;
    rgba[i + 1] = 247;
    rgba[i + 2] = 250;
    rgba[i + 3] = 255;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
  camera.position.set(3, -4, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  cube.rotation.set(0.35, 0.2, -0.25);
  cube.updateMatrixWorld();
  scene.add(cube);

  const geometry = cube.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triangles: Triangle[] = [];
  const lightDirection = new THREE.Vector3(0.4, -0.6, 0.8).normalize();

  if (index === null) {
    throw new Error('BoxGeometry unexpectedly has no index.');
  }

  for (let i = 0; i < index.count; i += 3) {
    const worldA = new THREE.Vector3().fromBufferAttribute(position, index.getX(i)).applyMatrix4(cube.matrixWorld);
    const worldB = new THREE.Vector3().fromBufferAttribute(position, index.getX(i + 1)).applyMatrix4(cube.matrixWorld);
    const worldC = new THREE.Vector3().fromBufferAttribute(position, index.getX(i + 2)).applyMatrix4(cube.matrixWorld);
    const normal = new THREE.Vector3()
      .subVectors(worldB, worldA)
      .cross(new THREE.Vector3().subVectors(worldC, worldA))
      .normalize();
    const viewVector = new THREE.Vector3().subVectors(camera.position, worldA).normalize();

    if (normal.dot(viewVector) <= 0) {
      continue;
    }

    const shade = Math.max(0.28, normal.dot(lightDirection) * 0.72 + 0.28);
    const baseColor = new THREE.Color(0x4f8cff).multiplyScalar(shade);

    triangles.push({
      a: project(worldA, camera),
      b: project(worldB, camera),
      c: project(worldC, camera),
      color: [Math.round(baseColor.r * 255), Math.round(baseColor.g * 255), Math.round(baseColor.b * 255)],
    });
  }

  for (const triangle of triangles) {
    drawTriangle(rgba, depth, triangle);
  }

  for (const triangle of triangles) {
    drawLine(rgba, triangle.a, triangle.b, [20, 35, 60]);
    drawLine(rgba, triangle.b, triangle.c, [20, 35, 60]);
    drawLine(rgba, triangle.c, triangle.a, [20, 35, 60]);
  }

  return encodePng(rgba);
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const png = renderCube();

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, png);

  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(`backend=${backend}`);
  console.log(`pngBytes=${png.length}`);
  console.log(`outputPath=${outputPath}`);
  console.log(`elapsedMs=${elapsedMs}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
