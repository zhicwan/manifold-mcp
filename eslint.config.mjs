import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

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
            'scripts/extension-spike/*.mjs',
            'apps/copilot-extension/scripts/*.mjs',
            'packages/viewer/scripts/*.mjs',
            'plugin/bin/*.mjs',
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
    files: ['packages/viewer/src/**/*.{ts,tsx}'],
    ignores: ['packages/viewer/src/xr/**', 'packages/viewer/src/main.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
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
      'node_modules/',
      '.pack-smoke/',
      '.test-tmp/',
      'apps/copilot-extension/.verify-empty/',
      'apps/copilot-extension/.test-workspace/',
      'plugin/skills/use-manifold/references/manifold-sandbox.d.ts',
      '.github/skills/forge-workspace/',
      'plugin/skills/use-manifold/evals/',
    ],
  },
);
