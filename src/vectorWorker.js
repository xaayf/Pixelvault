import { traceImageData } from './vectorize.js';

self.onmessage = (e) => {
  const { id, width, height, buffer, opts } = e.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    const out = traceImageData({ width, height, data }, opts);
    self.postMessage({ id, ok: true, ...out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
