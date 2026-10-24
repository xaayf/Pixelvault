import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './Pixelvault.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
