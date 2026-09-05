import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createRenderer } from '../packages/modeling/src/preview/renderer.js';
import type { CaptureView, RenderViewOptions } from '../packages/modeling/src/preview/renderer.js';
import type { ModelArtifact } from '../packages/modeling/src/runner/protocol.js';
import type { WireAnnotation } from '../packages/protocol/src/wire/annotations.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CAPTURE_VIEWS: CaptureView[] = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
const EDGE_COLOR = [28, 37, 52] as const;
const GRID_COLOR = [213, 218, 225] as const;
const execFileAsync = promisify(execFile);
type Vec3 = [number, number, number];

interface DecodedPng {
  width: number;
  height: number;
  pixels: Buffer;
  chunks: string[];
}

function cubeMesh(scale: Vec3 = [1, 1, 1], center: Vec3 = [0, 0, 0], rotationZ = 0): ModelArtifact {
  const positions = new Float32Array([
    -5, -5, -5, 5, -5, -5, 5, 5, -5, -5, 5, -5, -5, -5, 5, 5, -5, 5, 5, 5, 5, -5, 5, 5,
  ]);
  const triangles = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  const bboxMin: Vec3 = [Infinity, Infinity, Infinity];
  const bboxMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]! * scale[0];
    const y = positions[i + 1]! * scale[1];
    positions[i] = Math.cos(rotationZ) * x - Math.sin(rotationZ) * y + center[0];
    positions[i + 1] = Math.sin(rotationZ) * x + Math.cos(rotationZ) * y + center[1];
    positions[i + 2] = positions[i + 2]! * scale[2] + center[2];
  }
  for (let i = 0; i < positions.length; i += 1) {
    const axis = (i % 3) as 0 | 1 | 2;
    bboxMin[axis] = Math.min(bboxMin[axis], positions[i]!);
    bboxMax[axis] = Math.max(bboxMax[axis], positions[i]!);
  }
  return {
    description: 'renderer cube',
    numProp: 3,
    triangles: triangles.length / 3,
    vertices: positions.length / 3,
    vertProperties: positions.buffer,
    triVerts: triangles.buffer,
    triFeatureIds: new Uint32Array(triangles.length / 3).buffer,
    features: [],
    volume: 1_000,
    surfaceArea: 600,
    genus: 0,
    bboxMin,
    bboxMax,
  };
}

function cubeAnnotations(scale = 1, center: Vec3 = [0, 0, 0]): WireAnnotation[] {
  const world = (point: Vec3): Vec3 => point.map((value, axis) => value * scale + center[axis]!) as Vec3;
  return [
    {
      id: 'point-1',
      modelVersion: 'v-test',
      kind: 'point',
      partLabel: 'point#1',
      note: '',
      worldCoord: world([0, 0, -5]),
    },
    {
      id: 'region-1',
      modelVersion: 'v-test',
      kind: 'region',
      partLabel: 'region#2',
      note: '',
      worldCoord: world([4, 0, -5]),
      triCount: 2,
    },
    {
      id: 'sketch-1',
      modelVersion: 'v-test',
      kind: 'sketch',
      partLabel: 'sketch#3',
      note: '',
      worldCoord: world([0, 0, -5]),
      viewPlane: 'top',
      planeOrigin: world([0, 0, -5]),
      strokes: [
        [
          [-4 * scale, -4 * scale],
          [0, 4 * scale],
          [4 * scale, -4 * scale],
        ],
      ],
    },
  ];
}

function mergeMeshes(first: ModelArtifact, second: ModelArtifact): ModelArtifact {
  const positions = new Float32Array([
    ...new Float32Array(first.vertProperties),
    ...new Float32Array(second.vertProperties),
  ]);
  const triangles = new Uint32Array([
    ...new Uint32Array(first.triVerts),
    ...new Uint32Array(second.triVerts).map(index => index + first.vertices),
  ]);
  return {
    ...first,
    vertices: first.vertices + second.vertices,
    triangles: first.triangles + second.triangles,
    vertProperties: positions.buffer,
    triVerts: triangles.buffer,
    triFeatureIds: new Uint32Array(first.triangles + second.triangles).buffer,
    bboxMin: first.bboxMin.map((value, axis) => Math.min(value, second.bboxMin[axis]!)) as Vec3,
    bboxMax: first.bboxMax.map((value, axis) => Math.max(value, second.bboxMax[axis]!)) as Vec3,
  };
}

async function renderIsolated(
  cases: Array<{ mesh: ModelArtifact; options: RenderViewOptions }>,
): Promise<DecodedPng[]> {
  const input = cases.map(({ mesh, options }) => ({
    mesh: {
      ...mesh,
      vertProperties: [...new Float32Array(mesh.vertProperties)],
      triVerts: [...new Uint32Array(mesh.triVerts)],
    },
    options,
  }));
  // A Vitest timeout cannot interrupt synchronous renderer loops. Node's native
  // TS loader exercises the source in a child that execFile can forcibly stop.
  const script = `
    import { createRenderer } from ${JSON.stringify(new URL('../packages/modeling/src/preview/renderer.ts', import.meta.url).href)};
    const renderer = createRenderer();
    const results = [];
    for (const { mesh, options } of JSON.parse(process.argv[1])) {
      mesh.vertProperties = new Float32Array(mesh.vertProperties).buffer;
      mesh.triVerts = new Uint32Array(mesh.triVerts).buffer;
      const result = await renderer.renderView(mesh, options);
      results.push(result.png.toString('base64'));
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', script, JSON.stringify(input)],
    {
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    },
  );
  return (JSON.parse(stdout) as string[]).map(png => decodeRendererPng(Buffer.from(png, 'base64')));
}

function decodeRendererPng(png: Buffer): DecodedPng {
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);

  let offset = 8;
  let width = 0;
  let height = 0;
  const chunks: string[] = [];
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;

    expect(nextOffset).toBeLessThanOrEqual(png.length);
    chunks.push(type);

    if (type === 'IHDR') {
      expect(length).toBe(13);
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      expect(png[dataStart + 8]).toBe(8);
      expect(png[dataStart + 9]).toBe(6);
    } else if (type === 'IDAT') {
      idatChunks.push(png.subarray(dataStart, dataEnd));
    }

    offset = nextOffset;
    if (type === 'IEND') {
      break;
    }
  }

  expect(chunks[0]).toBe('IHDR');
  expect(chunks.at(-1)).toBe('IEND');
  expect(idatChunks.length).toBeGreaterThan(0);
  expect(offset).toBe(png.length);

  const scanlineLength = width * 4 + 1;
  const raw = inflateSync(Buffer.concat(idatChunks));
  expect(raw.length).toBe(scanlineLength * height);

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * scanlineLength;
    expect(raw[rawOffset]).toBe(0);
    raw.copy(pixels, y * width * 4, rawOffset + 1, rawOffset + scanlineLength);
  }

  return { width, height, pixels, chunks };
}

function uniqueColorCount(pixels: Buffer): number {
  const colors = new Set<number>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    colors.add(pixels.readUInt32BE(i));
    if (colors.size > 1) {
      return colors.size;
    }
  }
  return colors.size;
}

function countColor(pixels: Buffer, color: readonly [number, number, number]): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === color[0] && pixels[i + 1] === color[1] && pixels[i + 2] === color[2]) {
      count += 1;
    }
  }
  return count;
}

function edgeBounds({ width, height, pixels }: DecodedPng): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (EDGE_COLOR.every((channel, i) => pixels[offset + i] === channel)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

describe('preview renderer', () => {
  it('renders a mesh view to a valid non-blank PNG with requested dimensions', async () => {
    const renderer = createRenderer();
    const { png } = await renderer.renderView(cubeMesh(), { view: 'iso', width: 320, height: 240 });
    const decoded = decodeRendererPng(png);

    expect(decoded.width).toBe(320);
    expect(decoded.height).toBe(240);
    expect(decoded.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(uniqueColorCount(decoded.pixels)).toBeGreaterThan(1);
    expect(png.length).toBeGreaterThan(1_000);
  });

  it('renders all capture view presets to valid non-blank PNGs', async () => {
    const renderer = createRenderer();
    for (const view of CAPTURE_VIEWS) {
      const { png } = await renderer.renderView(cubeMesh(), { view, width: 128, height: 128 });
      const decoded = decodeRendererPng(png);
      expect(decoded.width, view).toBe(128);
      expect(decoded.height, view).toBe(128);
      expect(uniqueColorCount(decoded.pixels), view).toBeGreaterThan(1);
    }
  });

  it.each(CAPTURE_VIEWS)(
    'fits the complete projected bounds with padding in portrait and landscape: %s',
    async view => {
      const renderer = createRenderer();
      for (const scale of [
        [1, 1, 1],
        [6, 2, 4],
      ] satisfies Vec3[]) {
        for (const [width, height] of [
          [128, 512],
          [512, 128],
        ] as const) {
          const { png } = await renderer.renderView(cubeMesh(scale), { view, width, height });
          const decoded = decodeRendererPng(png);
          const bounds = edgeBounds(decoded);
          expect(decoded.width).toBe(width);
          expect(decoded.height).toBe(height);
          expect(countColor(decoded.pixels, EDGE_COLOR)).toBeGreaterThan(150);
          expect(bounds.minX).toBeGreaterThanOrEqual(width * 0.18);
          expect(bounds.maxX).toBeLessThanOrEqual(width * 0.82);
          expect(bounds.minY).toBeGreaterThanOrEqual(height * 0.18);
          expect(bounds.maxY).toBeLessThanOrEqual(height * 0.82);
          expect(bounds.minX).toBeLessThan(width / 2);
          expect(bounds.maxX).toBeGreaterThan(width / 2);
          expect(bounds.minY).toBeLessThan(height / 2);
          expect(bounds.maxY).toBeGreaterThan(height / 2);
        }
      }
    },
  );

  it.each(CAPTURE_VIEWS)('does not draw fully occluded rear or interior cubes with a fixed camera: %s', async view => {
    const renderer = createRenderer();
    const rearCenters: Record<CaptureView, Vec3> = {
      iso: [-8, 8, -8],
      front: [0, 8, 0],
      back: [0, -8, 0],
      left: [8, 0, 0],
      right: [-8, 0, 0],
      top: [0, 0, -8],
      bottom: [0, 0, 8],
    };
    const front = cubeMesh();
    for (const hidden of [
      cubeMesh([0.2, 0.2, 0.2], rearCenters[view]),
      cubeMesh([0.2, 0.2, 0.2]),
      cubeMesh([0.95, 0.95, 0.95]),
    ]) {
      for (const scene of [mergeMeshes(front, hidden), mergeMeshes(hidden, front)]) {
        const baseline = { ...front, bboxMin: scene.bboxMin, bboxMax: scene.bboxMax };
        const options = { view, width: 320, height: 240 };
        const expected = decodeRendererPng((await renderer.renderView(baseline, options)).png);
        const actual = decodeRendererPng((await renderer.renderView(scene, options)).png);
        expect(countColor(expected.pixels, EDGE_COLOR)).toBeGreaterThan(300);
        expect(actual.pixels.equals(expected.pixels)).toBe(true);
      }
    }
  });

  it('clips only the occluded portion of a geometric edge whose depth varies along its length', async () => {
    const renderer = createRenderer();
    const occluder = cubeMesh();
    const beam = cubeMesh([1.2, 0.1, 0.2], [0, -5, 0], Math.PI / 4);
    const scene = mergeMeshes(occluder, beam);
    const options = { view: 'front' as const, width: 320, height: 240 };
    const baseline = { ...occluder, bboxMin: scene.bboxMin, bboxMax: scene.bboxMax };
    const expected = decodeRendererPng((await renderer.renderView(baseline, options)).png);
    const actual = decodeRendererPng((await renderer.renderView(scene, options)).png);
    let visibleEdges = 0;
    for (let y = 100; y < 140; y += 1) {
      const row = y * actual.width * 4;
      expect(
        actual.pixels
          .subarray(row + 185 * 4, row + 220 * 4)
          .equals(expected.pixels.subarray(row + 185 * 4, row + 220 * 4)),
      ).toBe(true);
      visibleEdges += countColor(actual.pixels.subarray(row + 100 * 4, row + 140 * 4), EDGE_COLOR);
    }
    expect(visibleEdges).toBeGreaterThan(100);
  });

  it.each([
    { name: 'large extent', scale: 2 ** 60, center: [0, 0, 0] as Vec3 },
    { name: 'positive offset', scale: 2 ** 40, center: [2 ** 60, -(2 ** 60), 2 ** 60] as Vec3 },
    { name: 'negative offset', scale: 2 ** 40, center: [-(2 ** 60), 2 ** 60, -(2 ** 60)] as Vec3 },
  ])('renders huge coordinates with bounded work and real geometry: $name', async ({ scale, center }) => {
    expect(2 ** 60 + 10).toBe(2 ** 60);
    const mesh = cubeMesh([scale, scale, scale], center);
    const centered = cubeMesh([scale, scale, scale]);
    const cases = (['iso', 'top', 'front'] satisfies CaptureView[]).flatMap(view => {
      const options = { view, width: 160, height: 128 };
      return [
        { mesh, options },
        { mesh: centered, options },
        { mesh: cubeMesh(), options },
      ];
    });
    const images = await renderIsolated(cases);
    for (let i = 0; i < images.length; i += 3) {
      const actual = images[i]!;
      const reference = images[i + 1]!;
      const unitCube = images[i + 2]!;
      expect(actual.width).toBe(160);
      expect(actual.height).toBe(128);
      expect(countColor(actual.pixels, EDGE_COLOR)).toBeGreaterThan(300);
      expect(countColor(actual.pixels, GRID_COLOR)).toBeGreaterThan(20);
      expect(actual.pixels.equals(reference.pixels)).toBe(true);
      const bounds = edgeBounds(actual);
      const unitBounds = edgeBounds(unitCube);
      for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) {
        expect(Math.abs(bounds[key] - unitBounds[key])).toBeLessThanOrEqual(1);
      }
      expect(bounds.minX).toBeGreaterThan(15);
      expect(bounds.maxX).toBeLessThan(145);
    }
  });

  it('preserves world-space point, region, and sketch overlays after recentering a huge model', async () => {
    const scale = 2 ** 40;
    const offset: Vec3 = [2 ** 60, -(2 ** 60), 2 ** 60];
    const images = await renderIsolated(
      ([offset, [0, 0, 0]] satisfies Vec3[]).map(center => ({
        mesh: cubeMesh([scale, scale, scale], center),
        options: {
          view: 'top',
          width: 160,
          height: 160,
          includeAnnotations: true,
          annotations: cubeAnnotations(scale, center),
        },
      })),
    );
    expect(images[0]!.pixels.equals(images[1]!.pixels)).toBe(true);
    for (const color of [
      [236, 72, 153],
      [245, 158, 11],
      [14, 165, 233],
    ] as const) {
      expect(countColor(images[0]!.pixels, color)).toBeGreaterThan(0);
    }
  });

  it('clips extreme off-screen annotation lines and markers without losing their visible overlay', async () => {
    const images = await renderIsolated([
      {
        mesh: cubeMesh(),
        options: {
          view: 'top',
          width: 160,
          height: 160,
          includeAnnotations: true,
          annotations: [
            {
              id: 'long-sketch',
              modelVersion: 'v-test',
              kind: 'sketch',
              partLabel: 'sketch#1',
              note: '',
              worldCoord: [0, 0, -5],
              viewPlane: 'top',
              planeOrigin: [0, 0, -5],
              strokes: [
                [
                  [-1e18, 0],
                  [1e18, 0],
                ],
              ],
            },
            {
              id: 'off-screen-point',
              modelVersion: 'v-test',
              kind: 'point',
              partLabel: 'point#2',
              note: '',
              worldCoord: [1e18, 1e18, 0],
            },
            {
              id: 'off-screen-region',
              modelVersion: 'v-test',
              kind: 'region',
              partLabel: 'region#3',
              note: '',
              worldCoord: [-1e18, -1e18, 0],
              triCount: 2,
            },
          ],
        },
      },
    ]);
    const image = images[0]!;
    const middleRow = image.pixels.subarray(80 * image.width * 4, 81 * image.width * 4);
    expect(countColor(middleRow, [14, 165, 233])).toBeGreaterThan(150);
    expect(countColor(image.pixels, [236, 72, 153])).toBe(0);
    expect(countColor(image.pixels, [245, 158, 11])).toBe(0);
    expect(countColor(image.pixels, [31, 41, 55])).toBeGreaterThan(0);
    expect(countColor(image.pixels, [22, 163, 74])).toBeGreaterThan(0);
  });

  it('clamps invalid and extreme dimensions', async () => {
    const renderer = createRenderer();

    await expectDimensions(renderer.renderView(cubeMesh(), { width: 0, height: -12 }), 128, 128);
    await expectDimensions(renderer.renderView(cubeMesh(), { width: Number.NaN, height: 129 }), 1024, 129);
    await expectDimensions(renderer.renderView(cubeMesh(), { width: 9999, height: 129 }), 2048, 129);
    await expectDimensions(
      renderer.renderView(cubeMesh(), { width: 130, height: Number.POSITIVE_INFINITY }),
      130,
      1024,
    );
    await expectDimensions(renderer.renderView(cubeMesh(), { width: 130, height: 9999 }), 130, 2048);
  });

  it('overlays point, region, and sketch annotations only when requested', async () => {
    const renderer = createRenderer();
    const annotations = cubeAnnotations();

    const hidden = decodeRendererPng(
      (
        await renderer.renderView(cubeMesh(), {
          view: 'top',
          width: 160,
          height: 160,
          includeAnnotations: false,
          annotations,
        })
      ).png,
    );
    const overlaid = decodeRendererPng(
      (
        await renderer.renderView(cubeMesh(), {
          view: 'top',
          width: 160,
          height: 160,
          includeAnnotations: true,
          annotations,
        })
      ).png,
    );

    expect(countColor(hidden.pixels, [236, 72, 153])).toBe(0);
    expect(countColor(overlaid.pixels, [236, 72, 153])).toBeGreaterThan(0);
    expect(countColor(overlaid.pixels, [245, 158, 11])).toBeGreaterThan(0);
    expect(countColor(overlaid.pixels, [14, 165, 233])).toBeGreaterThan(0);
  });
});

async function expectDimensions(
  render: Promise<{ png: Buffer; width: number; height: number }>,
  width: number,
  height: number,
): Promise<void> {
  const { png } = await render;
  const decoded = decodeRendererPng(png);
  expect(decoded.width).toBe(width);
  expect(decoded.height).toBe(height);
}
