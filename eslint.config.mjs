import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { builtinModules } from 'node:module';

const appImports = [
  '@zhicwan/manifold3d-mcp',
  '@zhicwan/manifold3d-mcp/**',
  '@manifold3d/copilot-extension',
  '@manifold3d/copilot-extension/**',
  '**/apps/**',
  '**/manifold3d-mcp/**',
  '**/copilot-extension/**',
];
const sdkImports = ['@modelcontextprotocol/**', '@github/copilot-sdk', '@github/copilot-sdk/**'];
const nodeImports = ['node:*', ...builtinModules];
const viewerImports = [
  ...appImports,
  ...sdkImports,
  ...nodeImports,
  '@manifold3d/modeling',
  '@manifold3d/modeling/**',
  '**/modeling/**',
  '@manifold3d/viewer-host',
  '@manifold3d/viewer-host/**',
  '**/viewer-host/**',
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'vitest.config.ts',
            'scripts/*.mjs',
            'scripts/*.ts',
            'tests/*.mjs',
            'apps/copilot-extension/scripts/*.mjs',
            'apps/manifold3d-mcp/scripts/*.mjs',
            'packages/viewer/scripts/*.mjs',
          ],
          // Safety net: in some IDE contexts projectService may briefly
          // route additional files (e.g. tests) through the default
          // project before tests/tsconfig.json is discovered. Raising the
          // cap above the default of 8 prevents spurious parsing errors.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 100,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Aligned with microsoft/fluentui
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-function': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    files: ['packages/protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                ...appImports,
                ...sdkImports,
                ...nodeImports,
                '@manifold3d/**',
                'react',
                'react/**',
                'three',
                'three/**',
                '**/modeling/**',
                '**/viewer/**',
                '**/viewer-host/**',
              ],
              message: 'Protocol contains transport-neutral data contracts only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/modeling/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                ...appImports,
                ...sdkImports,
                '@manifold3d/viewer',
                '@manifold3d/viewer/**',
                '**/viewer/**',
                '@manifold3d/viewer-host',
                '@manifold3d/viewer-host/**',
                '**/viewer-host/**',
              ],
              message: 'Modeling must not depend on host adapters or the browser Viewer.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/viewer-host/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                ...appImports,
                ...sdkImports,
                '@manifold3d/modeling',
                '@manifold3d/modeling/**',
                '**/modeling/**',
                '@manifold3d/viewer',
                '@manifold3d/viewer/**',
                '**/viewer/**',
              ],
              message: 'Viewer Host owns transport, not modeling or browser implementation.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/viewer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: viewerImports,
              message: 'The browser Viewer consumes protocol, not Node or host adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/viewer/src/**/*.{ts,tsx}'],
    ignores: ['packages/viewer/src/xr/**', 'packages/viewer/src/main.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: viewerImports,
              message: 'The browser Viewer consumes protocol, not Node or host adapters.',
            },
            {
              group: ['@/xr', '@/xr/**', '**/xr', '**/xr/**'],
              message:
                'Base Viewer modules cannot import XR. Compose @manifold3d/viewer/xr only from the default entry.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['samples/**/*.{js,ts}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
      globals: {
        CrossSection: 'readonly',
        Manifold: 'readonly',
        result: 'writable',
      },
    },
    rules: {
      curly: 'off',
      // The typed lint rules above require parserServices which the
      // sample tsconfig deliberately doesn't expose to ESLint (samples
      // are user-facing snippets, lint here is best-effort).
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    ignores: [
      'build/',
      '**/dist/',
      'apps/*/build/',
      'plugins/',
      'node_modules/',
      '.test-tmp/',
      'apps/copilot-extension/.verify-empty/',
      'apps/copilot-extension/.test-workspace/',
      'skills/shared/references/manifold-sandbox.d.ts',
    ],
  },
);
