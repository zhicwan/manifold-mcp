import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const viewerSource = resolve(import.meta.dirname, '../packages/viewer/src');
const explicitCompositionEntry = resolve(viewerSource, 'main.tsx');

describe('flat Viewer XR boundary', () => {
  it('keeps non-XR Viewer modules from importing the XR tree', async () => {
    const files = (await walk(viewerSource)).filter(
      file => !file.includes(`${resolve(viewerSource, 'xr')}/`) && file !== explicitCompositionEntry,
    );
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const imports = source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g);
      for (const match of imports) {
        const specifier = match[1] ?? '';
        if (specifier === '@/xr' || specifier.startsWith('@/xr/') || /(^|\/)xr(\/|$)/.test(specifier)) {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps base Viewer ownership free of immersive API and renderer enablement', async () => {
    const baseFiles = ['scene/viewer.ts', 'components/viewer-canvas.tsx', 'components/top-bar.tsx', 'store.ts'];
    const forbidden = ['XrRuntime', 'enterVr', 'xrSupport', 'xrSessionState', 'xrError', 'renderer.xr'];

    for (const relativePath of baseFiles) {
      const source = await readFile(resolve(viewerSource, relativePath), 'utf8');
      for (const marker of forbidden) {
        expect(source, `${relativePath} contains ${marker}`).not.toContain(marker);
      }
    }
  });

  it('rebuilds both Viewer variants from a clean workspace during verification', async () => {
    const manifest = JSON.parse(await readFile(resolve(viewerSource, '../package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['verify:flat']).toBe(
      'npm run clean && npm run build && npm run build:flat && node scripts/verify-flat-build.mjs',
    );
  });
});

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(entry => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : Promise.resolve([path]);
    }),
  );
  return paths.flat().filter(path => /\.[cm]?[jt]sx?$/.test(path));
}
