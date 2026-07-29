import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { initTheme } from '@/lib/settings';
import '@/assets/style.css';

initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
