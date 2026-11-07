// Auto-Trace: raster (hasil AI datar, latar putih) -> SVG berwarna solid, untuk Adobe Stock (Vector).
// Murni JS tanpa DOM supaya bisa jalan di Web Worker dan diuji di Node.
import ImageTracer from 'imagetracerjs';

export const DETAIL_LEVELS = {
  rendah: { label: 'Rendah (paling ringan)', ltres: 2, qtres: 2, pathomit: 30, blurradius: 0, blurdelta: 20 },
  sedang: { label: 'Sedang', ltres: 1, qtres: 1, pathomit: 14, blurradius: 0, blurdelta: 20 },
  tinggi: { label: 'Tinggi (banyak titik)', ltres: 0.5, qtres: 0.5, pathomit: 6, blurradius: 0, blurdelta: 20 }
};

// Batas peringatan. Adobe tidak mempublikasikan angka pasti; ini asumsi awal dan bisa diubah dari UI.
export const DEFAULT_LIMITS = { maxNodes: 20000, maxColors: 12 };

const isNearWhite = (d, i, thr) => d[i + 3] > 0 && d[i] >= thr && d[i + 1] >= thr && d[i + 2] >= thr;

// Salinan ImageData dengan latar putih yang tersambung ke tepi dijadikan transparan.
export function removeEdgeWhite(imgd, thr = 240) {
  const { width: w, height: h } = imgd;
  const data = new Uint8ClampedArray(imgd.data);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (seen[p] || !isNearWhite(data, p * 4, thr)) return;
    seen[p] = 1;
    stack[sp++] = p;
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  let removed = 0;
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p / w) | 0;
    data[p * 4] = 0; data[p * 4 + 1] = 0; data[p * 4 + 2] = 0; data[p * 4 + 3] = 0;
    removed++;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return { imgd: { width: w, height: h, data }, removedRatio: removed / (w * h) };
}


// Palet k-means (deterministik) dari piksel buram. Palet sendiri lebih stabil daripada sampling bawaan ImageTracer,
// yang bisa memetakan bagian kecil (mis. lubang putih) ke warna tetangga.
function buildPalette(data, k, hasTransparent) {
  const px = [];
  const total = data.length / 4;
  const step = Math.max(1, Math.floor(total / 25000));
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    if (data[i + 3] > 127) px.push([data[i], data[i + 1], data[i + 2]]);
  }
  const pal = [];
  if (px.length > 0) {
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const cents = [px[Math.floor(rnd() * px.length)].slice()];
    const dist = new Float64Array(px.length).fill(Infinity);
    while (cents.length < Math.min(k, px.length)) {
      let sum = 0;
      const last = cents[cents.length - 1];
      for (let i = 0; i < px.length; i++) { dist[i] = Math.min(dist[i], d2(px[i], last)); sum += dist[i]; }
      if (sum === 0) break;
      let r = rnd() * sum;
      let pick = 0;
      for (let i = 0; i < px.length; i++) { r -= dist[i]; if (r <= 0) { pick = i; break; } }
      cents.push(px[pick].slice());
    }
    for (let it = 0; it < 10; it++) {
      const acc = cents.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < px.length; i++) {
        let b = 0; let bd = Infinity;
        for (let c = 0; c < cents.length; c++) { const dd = d2(px[i], cents[c]); if (dd < bd) { bd = dd; b = c; } }
        acc[b][0] += px[i][0]; acc[b][1] += px[i][1]; acc[b][2] += px[i][2]; acc[b][3]++;
      }
      acc.forEach((a, c) => { if (a[3] > 0) cents[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
    }
    cents.forEach((c) => {
      let r = Math.round(c[0]); let g = Math.round(c[1]); let b = Math.round(c[2]);
      if (r >= 248 && g >= 248 && b >= 248) { r = g = b = 255; }
      if (r <= 7 && g <= 7 && b <= 7) { r = g = b = 0; }
      if (!pal.some((q) => q.r === r && q.g === g && q.b === b)) pal.push({ r, g, b, a: 255 });
    });
  }
  if (hasTransparent) pal.push({ r: 0, g: 0, b: 0, a: 0 });
  if (pal.length === 0) pal.push({ r: 255, g: 255, b: 255, a: 255 });
  return pal;
}

const PATH_RE = /<path\b[^>]*\/>/g;

export function analyzeSvg(svg, limits = DEFAULT_LIMITS) {
  const paths = svg.match(PATH_RE) || [];
  const fills = new Set();
  let nodes = 0;
  paths.forEach((p) => {
    const f = p.match(/fill="([^"]*)"/);
    if (f) fills.add(f[1]);
    const d = (p.match(/\bd="([^"]*)"/) || [])[1] || '';
    nodes += (d.match(/[MLQCZ]/g) || []).length;
  });
  const bytes = svg.length;
  const hasRaster = /<image\b/i.test(svg);
  const hasEffects = /<(?:filter|mask|clipPath|linearGradient|radialGradient)\b/i.test(svg) || /(?<![-\w])opacity="(?!1")/i.test(svg);
  const warnings = [];
  if (hasRaster) warnings.push('SVG memuat gambar raster tertanam. Adobe menolak ini.');
  if (hasEffects) warnings.push('SVG memuat efek (filter/mask/gradasi/transparansi). Sebaiknya hanya fill solid.');
  if (nodes > limits.maxNodes) warnings.push(`Jumlah titik ${nodes} melewati batas ${limits.maxNodes}. Kurangi detail atau jumlah warna agar mudah diedit.`);
  if (fills.size > limits.maxColors) warnings.push(`Jumlah warna ${fills.size} melewati ${limits.maxColors}. Gaya datar biasanya cukup dengan sedikit warna.`);
  if (paths.length === 0) warnings.push('Tidak ada path hasil trace. Coba kurangi ambang latar putih atau tambah warna.');
  return { paths: paths.length, nodes, colors: fills.size, bytes, hasRaster, hasEffects, warnings };
}

export function traceImageData(imgd, opts = {}) {
  const { colors = 6, detail = 'sedang', removeBg = true, whiteThreshold = 240, limits = DEFAULT_LIMITS } = opts;
  const lvl = DETAIL_LEVELS[detail] || DETAIL_LEVELS.sedang;
  let src = imgd;
  let bgRemovedRatio = 0;
  if (removeBg) {
    const r = removeEdgeWhite(imgd, whiteThreshold);
    src = r.imgd;
    bgRemovedRatio = r.removedRatio;
  }
  const pal = buildPalette(src.data, Math.max(2, Math.min(24, colors | 0)), bgRemovedRatio > 0);
  const options = {
    ltres: lvl.ltres, qtres: lvl.qtres, pathomit: lvl.pathomit, rightangleenhance: true,
    colorsampling: 0, pal, numberofcolors: pal.length, mincolorratio: 0, colorquantcycles: 1,
    layering: 0, strokewidth: 0, linefilter: false, scale: 1, roundcoords: 2,
    viewbox: true, desc: false, lcpr: 0, qcpr: 0,
    blurradius: lvl.blurradius, blurdelta: lvl.blurdelta
  };
  let svg = ImageTracer.imagedataToSVG(src, options);
  // buang path transparan (sisa latar yang sudah dihapus) dan atribut yang tidak perlu
  svg = svg.replace(PATH_RE, (p) => (/\bopacity="0"/.test(p) || /fill-opacity="0"/.test(p) ? '' : p));
  svg = svg.replace(/\s(?:stroke="[^"]*"|stroke-width="[^"]*"|opacity="1")/g, '');
  const stats = analyzeSvg(svg, limits);
  return { svg, stats, bgRemovedRatio, width: imgd.width, height: imgd.height };
}

// Selisih rata-rata (0..1) antara dua gambar RGBA seukuran; latar transparan dilebur ke putih.
export function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i + 3 < n; i += 4) {
    const aa = a[i + 3] / 255;
    const ba = b[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const av = a[i + c] * aa + 255 * (1 - aa);
      const bv = b[i + c] * ba + 255 * (1 - ba);
      sum += Math.abs(av - bv);
      cnt++;
    }
  }
  return cnt ? sum / cnt / 255 : 0;
}
