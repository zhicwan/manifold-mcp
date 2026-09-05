import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), tailwindcss(), verifyExtensionViewer()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  build: {
    license: { fileName: 'third-party-licenses.txt' },
    outDir: resolve(here, '../../apps/copilot-extension/build/viewer'),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(here, 'extension.html'),
      },
    },
  },
});

function verifyExtensionViewer(): Plugin {
  return {
    name: 'verify-extension-viewer',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['extension.html'];
      if (!html || html.type !== 'asset') {
        this.error('Extension Viewer did not emit extension.html.');
      }
      delete bundle['extension.html'];
      this.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: html.source,
      });

      const files = [...Object.keys(bundle), 'index.html'];
      const forbidden = files.filter(file => /\.(?:map|woff2?|ttf|otf)$/i.test(file));
      if (forbidden.length > 0) {
        this.error(`Extension Viewer must use system fonts and omit source maps:\n${forbidden.join('\n')}`);
      }
      const moduleIds = Object.values(bundle).flatMap(output =>
        output.type === 'chunk' ? Object.keys(output.modules) : [],
      );
      const xrModules = moduleIds.filter(id => id.split('\\').join('/').includes('/packages/viewer/src/xr/'));
      if (xrModules.length > 0) {
        this.error(`Extension Viewer unexpectedly contains XR modules:\n${xrModules.join('\n')}`);
      }
    },
  };
}
