/**
 * Drift test for the sandbox ambient TypeScript declarations.
 *
 * The sandbox publishes a curated `.d.ts` (sourced from
 * `packages/modeling/src/sandbox/ambient-types.ts`) that promises a specific subset of
 * the manifold-3d API to user snippets. If the runtime drops or renames a
 * method we declared, snippets that typecheck cleanly will explode at
 * runtime — exactly the situation this test is designed to catch.
 *
 * Approach: parse the ambient declaration template literal at test time and
 * extract the method names declared on Manifold / CrossSection / Mesh, then
 * assert each one is actually a function on the live WASM instance (or its
 * prototype). We also smoke-test a few static factories to make sure they
 * really produce a valid Manifold.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import Module, { type CrossSection, type Manifold, type Mat3, type Mat4 } from 'manifold-3d';

import { compileSnippetTypeScript } from '../packages/modeling/src/compiler/typescript-compiler.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ambientSourcePath = resolve(repoRoot, 'packages/modeling/src/sandbox/ambient-types.ts');

interface DeclaredApi {
  classes: Map<string, ClassMembers>;
}

interface ClassMembers {
  staticMethods: Set<string>;
  instanceMethods: Set<string>;
}

/**
 * Pull the ambient declarations out of the template literal in
 * `ambient-types.ts`. Mirrors the logic in `scripts/emit-sandbox-types.mjs`
 * so the two views stay in lock-step.
 */
function extractTemplateLiteral(source: string): string {
  const marker = 'sandboxAmbientDeclarations';
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) {
    throw new Error(`Could not find export "${marker}" in ambient-types.ts`);
  }
  const openTick = source.indexOf('`', markerIdx);
  if (openTick < 0) {
    throw new Error(`Could not find opening backtick after "${marker}"`);
  }
  for (let i = openTick + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      return source.slice(openTick + 1, i);
    }
  }
  throw new Error(`Could not find closing backtick after "${marker}"`);
}

/**
 * Parse the ambient declarations into a map of class name -> declared
 * static and instance method names. Constructors, fields, and overload
 * groups collapse to a single name.
 */
function parseDeclaredApi(declarations: string): DeclaredApi {
  const classes = new Map<string, ClassMembers>();
  const classRegex = /declare\s+class\s+(\w+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(declarations)) !== null) {
    const className = match[1];
    if (className === undefined) {
      continue;
    }
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findMatchingBrace(declarations, bodyStart - 1);
    const body = declarations.slice(bodyStart, bodyEnd);
    classes.set(className, parseClassBody(body));
  }
  return { classes };
}

function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error('Unbalanced braces in ambient declarations');
}

function parseClassBody(body: string): ClassMembers {
  const staticMethods = new Set<string>();
  const instanceMethods = new Set<string>();
  // Match member declarations of the form
  //   [static] name(...): ReturnType;
  // with optional surrounding whitespace. Skip `constructor`.
  const memberRegex = /^[ \t]*(static\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(body)) !== null) {
    const isStatic = Boolean(match[1]);
    const name = match[2];
    if (name === undefined || name === 'constructor') {
      continue;
    }
    if (isStatic) {
      staticMethods.add(name);
    } else {
      instanceMethods.add(name);
    }
  }
  return { staticMethods, instanceMethods };
}

interface InitializedWasm {
  Manifold: unknown;
  CrossSection: unknown;
  Mesh: unknown;
}

let wasmPromise: Promise<InitializedWasm> | undefined;
function initWasm(): Promise<InitializedWasm> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const wasm = (await Module()) as unknown as {
        setup: () => void;
        Manifold: unknown;
        CrossSection: unknown;
        Mesh: unknown;
      };
      wasm.setup();
      return { Manifold: wasm.Manifold, CrossSection: wasm.CrossSection, Mesh: wasm.Mesh };
    })();
  }
  return wasmPromise;
}

async function loadDeclaredApi(): Promise<DeclaredApi> {
  const source = await readFile(ambientSourcePath, 'utf8');
  return parseDeclaredApi(extractTemplateLiteral(source));
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

function lookup(target: unknown, name: string): unknown {
  if (target === null || target === undefined) {
    return undefined;
  }
  return (target as Record<string, unknown>)[name];
}

describe('sandbox ambient declarations vs. live manifold-3d runtime', () => {
  it.concurrent('every declared static method exists on the live class', async () => {
    const [api, wasm] = await Promise.all([loadDeclaredApi(), initWasm()]);
    const targets: Record<string, unknown> = {
      Manifold: wasm.Manifold,
      CrossSection: wasm.CrossSection,
      Mesh: wasm.Mesh,
    };
    const missing: string[] = [];
    for (const [className, members] of api.classes) {
      const target = targets[className];
      expect(target, `runtime is missing class ${className}`).toBeDefined();
      for (const name of members.staticMethods) {
        if (!isFunction(lookup(target, name))) {
          missing.push(`${className}.${name} (static)`);
        }
      }
    }
    expect(
      missing,
      `static methods declared in ambient-types.ts but missing at runtime: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it.concurrent('every declared instance method exists on the live prototype', async () => {
    const [api, wasm] = await Promise.all([loadDeclaredApi(), initWasm()]);
    const targets: Record<string, unknown> = {
      Manifold: wasm.Manifold,
      CrossSection: wasm.CrossSection,
      Mesh: wasm.Mesh,
    };
    const missing: string[] = [];
    for (const [className, members] of api.classes) {
      const ctor = targets[className] as { prototype?: unknown } | undefined;
      const proto = ctor?.prototype;
      expect(proto, `runtime is missing prototype for ${className}`).toBeDefined();
      for (const name of members.instanceMethods) {
        // Mesh is the JS-side wrapper class; instance members may live on the
        // prototype OR be regular methods set in the constructor (e.g.
        // `merge`). Walk the prototype chain to be safe.
        let found = false;
        let cursor: unknown = proto;
        while (cursor !== null && cursor !== undefined) {
          const value = lookup(cursor, name);
          if (isFunction(value)) {
            found = true;
            break;
          }
          cursor = Object.getPrototypeOf(cursor as object);
        }
        if (!found) {
          missing.push(`${className}.prototype.${name}`);
        }
      }
    }
    expect(
      missing,
      `instance methods declared in ambient-types.ts but missing at runtime: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it.concurrent('Manifold.cube produces a valid manifold', async () => {
    const wasm = await initWasm();
    const Mfd = wasm.Manifold as {
      cube(
        size: [number, number, number],
        center?: boolean,
      ): {
        numTri(): number;
        volume(): number;
        delete(): void;
      };
    };
    const cube = Mfd.cube([2, 3, 4], true);
    try {
      expect(cube.numTri()).toBe(12);
      expect(cube.volume()).toBeCloseTo(24, 5);
    } finally {
      cube.delete();
    }
  });

  it.concurrent('Manifold.sphere produces a non-empty manifold', async () => {
    const wasm = await initWasm();
    const Mfd = wasm.Manifold as {
      sphere(radius: number, segments?: number): { numTri(): number; isEmpty(): boolean; delete(): void };
    };
    const sphere = Mfd.sphere(5, 32);
    try {
      expect(sphere.isEmpty()).toBe(false);
      expect(sphere.numTri()).toBeGreaterThan(0);
    } finally {
      sphere.delete();
    }
  });

  it.concurrent('Manifold.cylinder produces a valid manifold', async () => {
    const wasm = await initWasm();
    const Mfd = wasm.Manifold as {
      cylinder(
        height: number,
        rLow: number,
        rHigh?: number,
        segments?: number,
        center?: boolean,
      ): { numTri(): number; volume(): number; delete(): void };
    };
    const cyl = Mfd.cylinder(10, 2, 2, 16, false);
    try {
      expect(cyl.numTri()).toBeGreaterThan(0);
      expect(cyl.volume()).toBeGreaterThan(0);
    } finally {
      cyl.delete();
    }
  });

  describe.each([
    { name: 'identity', x: 0, y: 0, z: 0 },
    { name: 'column-major translation', x: 5, y: -7, z: 11 },
  ])('$name matrices', ({ x, y, z }) => {
    it('typechecks Mat3 and preserves the expected 2D geometry at runtime', async () => {
      const matrix: Mat3 = [1, 0, 0, 0, 1, 0, x, y, 1];
      const compiled = compileSnippetTypeScript(`
const matrix: Mat3 = [${matrix.join(', ')}];
result = CrossSection.square([2, 3], true).transform(matrix).extrude(4);
`);
      expect(compiled.issues).toEqual([]);
      expect(compiled.ok).toBe(true);

      const wasm = await initWasm();
      const original = (wasm.CrossSection as typeof CrossSection).square([2, 3], true);
      const transformed = original.transform(matrix);
      try {
        expect(transformed.area()).toBeCloseTo(6, 5);
        expect(transformed.bounds()).toEqual({
          min: [-1 + x, -1.5 + y],
          max: [1 + x, 1.5 + y],
        });
        expect(transformed.toPolygons()).toEqual(
          original.toPolygons().map(polygon => polygon.map(([px, py]) => [px + x, py + y])),
        );
      } finally {
        transformed.delete();
        original.delete();
      }
    });

    it('typechecks Mat4 and preserves the expected 3D geometry at runtime', async () => {
      const matrix: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
      const compiled = compileSnippetTypeScript(`
const matrix: Mat4 = [${matrix.join(', ')}];
result = Manifold.cube([2, 3, 4], true).transform(matrix);
`);
      expect(compiled.issues).toEqual([]);
      expect(compiled.ok).toBe(true);

      const wasm = await initWasm();
      const original = (wasm.Manifold as typeof Manifold).cube([2, 3, 4], true);
      const transformed = original.transform(matrix);
      try {
        expect(transformed.volume()).toBeCloseTo(24, 5);
        expect(transformed.boundingBox()).toEqual({
          min: [-1 + x, -1.5 + y, -2 + z],
          max: [1 + x, 1.5 + y, 2 + z],
        });
        const originalMesh = original.getMesh();
        const transformedMesh = transformed.getMesh();
        expect(transformedMesh.triVerts).toEqual(originalMesh.triVerts);
        expect(Array.from(transformedMesh.vertProperties)).toEqual(
          Array.from(originalMesh.vertProperties, (value, index) => {
            const offset = index % 3 === 0 ? x : index % 3 === 1 ? y : z;
            return value + offset;
          }),
        );
      } finally {
        transformed.delete();
        original.delete();
      }
    });
  });
});
