import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ProxyOptions } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

function createViewerRoomProxy(): Record<string, string | ProxyOptions> {
  const configuredRoomUrl = process.env.MANIFOLD_VIEWER_ROOM_URL;
  if (!configuredRoomUrl) {
    return {};
  }
  const roomUrl = new URL(configuredRoomUrl);
  if (
    roomUrl.protocol !== 'http:' ||
    (roomUrl.hostname !== '127.0.0.1' && roomUrl.hostname !== 'localhost') ||
    !/^\/rooms\/[^/]+\/[^/]+\/$/.test(roomUrl.pathname)
  ) {
    throw new Error('MANIFOLD_VIEWER_ROOM_URL must be a loopback Viewer room URL ending in "/".');
  }
  const roomWebSocketPath = new URL('ws', roomUrl).pathname;
  return {
    '/ws': {
      target: roomUrl.origin,
      ws: true,
      changeOrigin: true,
      rewrite(path) {
        const requestUrl = new URL(path, 'http://vite.local');
        return `${roomWebSocketPath}${requestUrl.search}`;
      },
    },
  };
}

// The MCP app embeds this browser/XR build into its standalone runtime.
export default defineConfig(({ mode }) => ({
  root: here,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  build: {
    license: { fileName: 'third-party-licenses.txt' },
    outDir: resolve(here, '../../apps/manifold3d-mcp/build/viewer'),
    emptyOutDir: true,
    target: 'es2022',
    // Source maps double the published tarball; only emit them in
    // dev/staging builds where you actually open the browser devtools
    // pointing at this build. Production publishes ship without them.
    sourcemap: mode !== 'production',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split the bundle so the browser can cache each
        // dependency tree independently of the application code.
        // Without this, a one-line change to viewer.ts re-downloads
        // the entire 870KB blob; with it, only the small `app` chunk
        // changes while the (much larger) vendor chunks reuse their
        // existing immutable cache entries served by the preview server.
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) {
            return undefined;
          }
          // three.js extras (OrbitControls, exporters, BVH helpers...)
          // weigh ~150KB and almost never change between releases —
          // pin them in their own chunk.
          if (id.includes('three/examples') || id.includes('three-mesh-bvh')) {
            return 'three-extras';
          }
          if (id.includes('node_modules/three/')) {
            return 'three';
          }
          if (id.includes('react-dom') || id.includes('react/jsx-runtime')) {
            return 'react';
          }
          if (id.includes('node_modules/react/')) {
            return 'react';
          }
          if (id.includes('@radix-ui')) {
            return 'radix';
          }
          // Leave everything else (lucide, fflate, jscadui, tailwind
          // runtime helpers...) to share Vite's default vendor chunk.
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    // For HMR against a live room, start MCP with NODE_ENV=development and
    // pass its logged preview URL as MANIFOLD_VIEWER_ROOM_URL.
    proxy: createViewerRoomProxy(),
  },
}));
