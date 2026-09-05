import { resolve } from 'node:path';
import { createRequire } from 'node:module';

import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('workspace dependency boundaries', () => {
  it('does not resolve private package internals through TypeScript source aliases', () => {
    const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const specifier = '@manifold3d/modeling/sandbox/feature-recognition.js';
    const resolution = ts.resolveModuleName(
      specifier,
      resolve(root, 'apps/copilot-extension/src/tools.ts'),
      parsed.options,
      ts.sys,
    );
    expect(resolution.resolvedModule).toBeUndefined();
    expect(() => createRequire(import.meta.url).resolve(specifier)).toThrow(
      expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
    );
  });

  it('rejects transport and Node dependencies at their actual source boundaries', async () => {
    const eslint = new ESLint({ cwd: root });
    const cases = [
      ['packages/modeling/src/modeling.ts', '@manifold3d/viewer-host/viewer-host.js'],
      ['packages/protocol/src/wire/model.ts', 'node:fs'],
      ['packages/viewer/src/scene/viewer.ts', '@manifold3d/modeling/modeling.js'],
    ] as const;
    for (const [file, dependency] of cases) {
      const [result] = await eslint.lintText(`import * as forbidden from '${dependency}';\nvoid forbidden;\n`, {
        filePath: resolve(root, file),
      });
      expect(
        result?.messages.some(message => message.ruleId === 'no-restricted-imports'),
        dependency,
      ).toBe(true);
    }
  });
});
