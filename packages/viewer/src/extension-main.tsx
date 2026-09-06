import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';

import './tailwind.css';
import './styles.css';
import './extension-fonts.css';

import { ViewerApp } from './components/viewer-app.js';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element in extension.html');
}

createRoot(rootEl).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <ViewerApp />
  </ThemeProvider>,
);
