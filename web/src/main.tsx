import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bindEngine } from './store/player';
import { initOffline } from './store/offline';
import './styles.css';

bindEngine();
void initOffline();

// App shell kept for offline starts (public/sw.js: never any /api response).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
