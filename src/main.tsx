import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
// Atkinson Hyperlegible Next and Mono, bundled and served from the portal's
// own origin (the content policy allows fonts from 'self' only).
import '@fontsource-variable/atkinson-hyperlegible-next/index.css';
import '@fontsource-variable/atkinson-hyperlegible-mono/index.css';
import App from './App.tsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
