import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createRenderer } from '../packages/modeling/src/preview/renderer.js';
import type { CaptureView } from '../packages/modeling/src/preview/renderer.js';
import type { ModelArtifact } from '../packages/modeling/src/runner/protocol.js';
import type { WireAnnotation } from '../packages/protocol/src/wire/annotations.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CAPTURE_VIEWS: CaptureView[] = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];

interface DecodedPng {
  width: number;
  height: number;
  pixels: Buffer;
  chunks: string[];
}

function cubeMesh(): ModelArtifact {
  const positions = new Float32Array([
    -5, -5, -5, 5, -5, -5, 5, 5, -5, -5, 5, -5, -5, -5, 5, 5, -5, 5, 5, 5, 5, -5, 5, 5,
  ]);
  const triangles = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
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
    bboxMin: [-5, -5, -5],
    bboxMax: [5, 5, 5],
  };
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
    const annotations: WireAnnotation[] = [
      {
        id: 'point-1',
        modelVersion: 'v-test',
        kind: 'point',
        partLabel: 'point#1',
        note: '',
        worldCoord: [0, 0, 5],
      },
      {
        id: 'region-1',
        modelVersion: 'v-test',
        kind: 'region',
        partLabel: 'region#2',
        note: '',
        worldCoord: [4, 0, 5],
        triCount: 2,
      },
      {
        id: 'sketch-1',
        modelVersion: 'v-test',
        kind: 'sketch',
        partLabel: 'sketch#3',
        note: '',
        worldCoord: [0, 0, 5],
        viewPlane: 'top',
        planeOrigin: [0, 0, 5],
        strokes: [
          [
            [-4, -4],
            [0, 4],
            [4, -4],
          ],
        ],
      },
    ];

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
