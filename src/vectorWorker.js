import { traceImageData, analyzeImage } from './vectorize.js';

self.onmessage = (e) => {
  const { id, kind, width, height, buffer, opts } = e.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    if (kind === 'analyze') {
      const out = analyzeImage({ width, height, data }, opts);
      self.postMessage({ id, ok: true, ...out });
      return;
    }
    const out = traceImageData({ width, height, data }, opts);
    self.postMessage({ id, ok: true, ...out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
