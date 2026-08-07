import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from '@/components/error-boundary';
import { initTheme } from '@/lib/settings';
import '@fontsource/archivo-black/latin.css';
import '@/assets/fonts.css';
import '@/assets/style.css';

initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
);
