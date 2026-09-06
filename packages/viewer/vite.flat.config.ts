import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), tailwindcss(), verifyFlatModuleBoundary()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  build: {
    license: { fileName: 'third-party-licenses.txt' },
    outDir: resolve(here, 'dist/flat'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: resolve(here, 'flat.html'),
    },
  },
});

function verifyFlatModuleBoundary(): Plugin {
  return {
    name: 'verify-flat-viewer-module-boundary',
    generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle)
        .flatMap(output => (output.type === 'chunk' ? Object.keys(output.modules) : []))
        .sort();
      const xrModules = moduleIds.filter(id => id.split('\\').join('/').includes('/packages/viewer/src/xr/'));
      if (xrModules.length > 0) {
        this.error(`Flat Viewer unexpectedly contains XR modules:\n${xrModules.join('\n')}`);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'flat-modules.json',
        source: `${JSON.stringify(moduleIds, null, 2)}\n`,
      });
    },
  };
}
