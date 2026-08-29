import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './tailwind.css';
import './styles.css';

import { ViewerApp } from './components/viewer-app.js';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element in flat.html');
}

createRoot(rootEl).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <ViewerApp />
  </ThemeProvider>,
);
