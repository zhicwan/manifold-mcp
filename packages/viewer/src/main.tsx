import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './tailwind.css';
import './styles.css';

import { ViewerApp } from './components/viewer-app.js';
import { createXrExperience } from '@manifold3d/viewer/xr';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element in index.html');
}

// next-themes drives the .dark class on <html>; the three.js scene
// palette follows via ViewerApp's setTheme effect. Runs client-only
// (this is a CSR Vite bundle), so no SSR hydration guard is needed.
const xr = createXrExperience();
const XrProvider = xr.Provider;

createRoot(rootEl).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <XrProvider>
      <ViewerApp slots={xr.slots} />
    </XrProvider>
  </ThemeProvider>,
);
