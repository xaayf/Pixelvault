// Auto-Trace: raster datar (stiker / ilustrasi flat, latar polos atau bergradasi lembut) -> SVG warna solid.
// Alur: deteksi latar+bayangan dari warna tepi -> pisah objek -> palet warna (Lab) -> kuantisasi + haluskan
// -> trace per objek -> susun SVG per objek dan SVG gabungan dalam kanvas rasio tertentu.
// Murni JS tanpa DOM supaya bisa jalan di Web Worker dan diuji di Node.
import ImageTracer from 'imagetracerjs';

export const DETAIL_LEVELS = {
  rendah: { label: 'Rendah (paling ringan)', ltres: 2, qtres: 2, pathomit: 30 },
  sedang: { label: 'Sedang', ltres: 1, qtres: 1, pathomit: 14 },
  tinggi: { label: 'Tinggi (banyak titik)', ltres: 0.5, qtres: 0.5, pathomit: 6 }
};

export const RATIOS = {
  asli: { label: 'Asli (rapat ke objek)', value: 0 },
  '3:2': { label: '3:2', value: 3 / 2 },
  '16:9': { label: '16:9', value: 16 / 9 }
};

// Batas peringatan. Adobe tidak mempublikasikan angka pasti; ini asumsi awal dan bisa diubah dari UI.
export const DEFAULT_LIMITS = { maxNodes: 20000, maxColors: 16 };

// ---------- warna ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function rgb2lab(r, g, b, out) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}
function lab2rgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const gam = (c) => Math.max(0, Math.min(255, Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055))));
  return [gam(R), gam(G), gam(B)];
}

// ---------- latar + bayangan ----------
// Latar = piksel yang tersambung ke tepi gambar dan "mirip warna tepi": kroma rendah (tidak lebih berwarna dari tepi
// + toleransi) dan tidak lebih gelap dari tepi lebih dari toleransi bayangan. Dengan begitu latar krem/abu bergradasi
// (vignette) dan bayangan lembut ikut terbuang, sedangkan tepi stiker yang berwarna (krem kemerahan) dan garis tepi
// gelap tetap tinggal. Tidak mengasumsikan latar putih murni.
export function detectBackground(imgd, { tol = 8, shadow = true } = {}) {
  const { width: w, height: h, data } = imgd;
  const chromaOf = (i) => Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
  const lumOf = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const cs = [], ls = [];
  const sample = (x, y) => { const i = (y * w + x) * 4; if (data[i + 3] > 0) { cs.push(chromaOf(i)); ls.push(lumOf(i)); } };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
  const mask = new Uint8Array(w * h);
  if (cs.length === 0) return { mask, ratio: 0, info: null };
  cs.sort((a, b) => a - b); ls.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const chromaThr = pct(cs, 0.95) + tol;
  const lumThr = pct(ls, 0.05) - (shadow ? 30 : 6);
  const isBg = (p) => {
    const i = p * 4;
    if (data[i + 3] === 0) return true;
    return chromaOf(i) <= chromaThr && lumOf(i) >= lumThr;
  };
  // Bayangan lembut: boleh dilewati kalau perubahannya per piksel sangat kecil (gradasi mulus), selama tidak terlalu gelap
  // dan tidak terlalu berwarna. Tepi tajam (batas stiker) menghentikan aliran.
  const chromaFloor = Math.max(chromaThr, 60);
  const lumFloor = Math.max(60, lumThr - 110);
  const soft = (q, from) => {
    const i = q * 4, j = from * 4;
    const dd = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
    return dd <= 36 && chromaOf(i) <= chromaFloor && lumOf(i) >= lumFloor;
  };
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (x, y, from) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (mask[p]) return;
    if (!(isBg(p) || (shadow && from >= 0 && soft(p, from)))) return;
    mask[p] = 1;
    stack[sp++] = p;
  };
  for (let x = 0; x < w; x++) { push(x, 0, -1); push(x, h - 1, -1); }
  for (let y = 0; y < h; y++) { push(0, y, -1); push(w - 1, y, -1); }
  let n = 0;
  while (sp > 0) {
    const p = stack[--sp];
    n++;
    const x = p % w, y = (p / w) | 0;
    push(x + 1, y, p); push(x - 1, y, p); push(x, y + 1, p); push(x, y - 1, p);
  }
  return { mask, ratio: n / (w * h), info: { chromaThr: +chromaThr.toFixed(1), lumThr: +lumThr.toFixed(1) } };
}

// ---------- pisah objek ----------
// Komponen terhubung dari piksel non-latar (setelah dilasi kecil agar celah sempit tidak memecah satu objek).
export function separateObjects(bgMask, w, h, { minRel = 0.01, minAbs = 120 } = {}) {
  const r = Math.max(1, Math.round(Math.max(w, h) / 350));
  const fg = new Uint8Array(w * h);
  for (let p = 0; p < fg.length; p++) fg[p] = bgMask[p] ? 0 : 1;
  // dilasi persegi radius r (dua lintasan terpisah)
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    const row = y * w;
    for (let x = 0; x < w; x++) { if (fg[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (fg[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
  }
  const dil = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) dil[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) dil[y * w + x] = 1; }
  }
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let s = 0; s < dil.length; s++) {
    if (!dil[s] || labels[s]) continue;
    const id = comps.length + 1;
    let sp = 0;
    stack[sp++] = s; labels[s] = id;
    const c = { id, area: 0, x0: w, y0: h, x1: -1, y1: -1 };
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      if (fg[p]) {
        c.area++;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      }
      if (x > 0 && dil[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && dil[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && dil[p - w] && !labels[p - w]) { labels[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && dil[p + w] && !labels[p + w]) { labels[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push(c);
  }
  const maxArea = comps.reduce((m, c) => Math.max(m, c.area), 0);
  const keep = comps.filter((c) => c.area >= Math.max(minAbs, minRel * maxArea));
  // urut kiri->kanan lalu atas->bawah (berdasarkan titik tengah)
  keep.sort((a, b) => (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
  const remap = new Int32Array(comps.length + 1);
  keep.forEach((c, i) => { remap[c.id] = i + 1; });
  const out = new Int32Array(w * h);
  for (let p = 0; p < out.length; p++) out[p] = fg[p] ? remap[labels[p]] : 0;
  return { labels: out, objects: keep.map((c, i) => ({ index: i + 1, area: c.area, x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 })) };
}

// ---------- palet (Lab, seimbang terhadap luas) ----------
// Histogram Lab berbin -> k-means berbobot sqrt(jumlah piksel). Bobot akar mencegah warna dominan (cokelat) menelan
// warna kecil (hijau daun) yang tetap penting secara visual, tetapi bin yang sangat langka (antialias) diabaikan.
export function buildPalette(data, labels, k, flat) {
  const total = labels.length;
  const stride = Math.max(1, Math.floor(total / 300000));
  const bins = new Map();
  const lab = [0, 0, 0];
  let cnt = 0;
  for (let p = 0; p < total; p += stride) {
    if (!labels[p] || (flat && !flat[p])) continue;
    const i = p * 4;
    rgb2lab(data[i], data[i + 1], data[i + 2], lab);
    const key = (((lab[0] / 3) | 0) << 16) | ((((lab[1] + 128) / 3) | 0) << 8) | (((lab[2] + 128) / 3) | 0);
    let e = bins.get(key);
    if (!e) { e = { L: 0, a: 0, b: 0, n: 0 }; bins.set(key, e); }
    e.L += lab[0]; e.a += lab[1]; e.b += lab[2]; e.n++;
    cnt++;
  }
  let ents = [...bins.values()].map((e) => ({ L: e.L / e.n, a: e.a / e.n, b: e.b / e.n, n: e.n }));
  if (ents.length === 0) return [];
  const minN = cnt * 0.0003;
  const filtered = ents.filter((e) => e.n >= minN);
  if (filtered.length >= Math.min(k, ents.length)) ents = filtered;
  ents.forEach((e) => { e.w = Math.sqrt(e.n); });
  const d2 = (e, c) => (e.L - c[0]) ** 2 + (e.a - c[1]) ** 2 + (e.b - c[2]) ** 2;
  const first = ents.reduce((m, e) => (e.n > m.n ? e : m), ents[0]);
  const cents = [[first.L, first.a, first.b]];
  const dist = new Float64Array(ents.length).fill(Infinity);
  while (cents.length < Math.min(k, ents.length)) {
    const last = cents[cents.length - 1];
    let best = -1, bi = -1;
    for (let i = 0; i < ents.length; i++) {
      dist[i] = Math.min(dist[i], d2(ents[i], last));
      const sc = dist[i] * ents[i].w;
      if (sc > best) { best = sc; bi = i; }
    }
    if (best <= 0) break;
    cents.push([ents[bi].L, ents[bi].a, ents[bi].b]);
  }
  for (let it = 0; it < 14; it++) {
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (const e of ents) {
      let b = 0, bd = Infinity;
      for (let c = 0; c < cents.length; c++) { const dd = d2(e, cents[c]); if (dd < bd) { bd = dd; b = c; } }
      acc[b][0] += e.L * e.w; acc[b][1] += e.a * e.w; acc[b][2] += e.b * e.w; acc[b][3] += e.w;
    }
    acc.forEach((a, c) => { if (a[3] > 0) cents[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  // gabung warna yang nyaris sama (selisih persepsi kecil)
  const merged = [];
  cents.forEach((c) => {
    if (!merged.some((m) => Math.sqrt((m[0] - c[0]) ** 2 + (m[1] - c[1]) ** 2 + (m[2] - c[2]) ** 2) < 5)) merged.push(c);
  });
  return merged.map((c) => {
    const [r, g, b] = lab2rgb(c[0], c[1], c[2]);
    return { r, g, b, a: 255, lab: c };
  });
}

// Piksel "datar": tidak ada tetangga fg yang berbeda jauh. Piksel transisi (antialias di antara dua warna) bukan datar.
export function flatMask(data, labels, w, h, thr = 6) {
  const flat = new Uint8Array(w * h);
  const L = new Float32Array(w * h * 3);
  const o = [0, 0, 0];
  for (let p = 0; p < labels.length; p++) {
    if (!labels[p]) continue;
    const i = p * 4;
    rgb2lab(data[i], data[i + 1], data[i + 2], o);
    L[p * 3] = o[0]; L[p * 3 + 1] = o[1]; L[p * 3 + 2] = o[2];
  }
  const de = (p, q) => Math.hypot(L[p * 3] - L[q * 3], L[p * 3 + 1] - L[q * 3 + 1], L[p * 3 + 2] - L[q * 3 + 2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!labels[p]) continue;
      let m = 0;
      if (x > 0 && labels[p - 1]) m = Math.max(m, de(p, p - 1));
      if (x < w - 1 && labels[p + 1]) m = Math.max(m, de(p, p + 1));
      if (y > 0 && labels[p - w]) m = Math.max(m, de(p, p - w));
      if (y < h - 1 && labels[p + w]) m = Math.max(m, de(p, p + w));
      flat[p] = m <= thr ? 1 : 0;
    }
  }
  return flat;
}

// Kuantisasi ke palet. Piksel datar -> warna palet terdekat (Lab). Piksel transisi -> warna datar terbanyak di sekitarnya
// (jendela 5x5), supaya garis tepi tidak punya "pita" warna perantara. Lalu filter modus 3x3 membuang sliver 1px.
function quantize(data, labels, flat, w, h, pal, passes) {
  const K = pal.length;
  const idx = new Int16Array(w * h).fill(-1);
  const lab = [0, 0, 0];
  const nearest = (p) => {
    const i = p * 4;
    rgb2lab(data[i], data[i + 1], data[i + 2], lab);
    let best = 0, bd = Infinity;
    for (let c = 0; c < K; c++) {
      const q = pal[c].lab;
      const dd = (lab[0] - q[0]) ** 2 + (lab[1] - q[1]) ** 2 + (lab[2] - q[2]) ** 2;
      if (dd < bd) { bd = dd; best = c; }
    }
    return best;
  };
  for (let p = 0; p < idx.length; p++) if (labels[p] && flat[p]) idx[p] = nearest(p);
  const cnt = new Int16Array(K);
  const nxt0 = new Int16Array(idx);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!labels[p] || flat[p]) continue;
      cnt.fill(0);
      let any = false;
      for (let dy = -3; dy <= 3; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = idx[yy * w + xx];
          if (v >= 0) { cnt[v]++; any = true; }
        }
      }
      if (!any) { nxt0[p] = nearest(p); continue; }
      // pilih warna palet terdekat (menurut warna piksel sendiri) di antara warna datar yang ada di sekitarnya;
      // mencegah munculnya warna "campuran" ketiga di sepanjang garis tipis
      const i = p * 4;
      rgb2lab(data[i], data[i + 1], data[i + 2], lab);
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        if (cnt[c] < 2) continue;
        const q = pal[c].lab;
        const dd = (lab[0] - q[0]) ** 2 + (lab[1] - q[1]) ** 2 + (lab[2] - q[2]) ** 2;
        if (dd < bd) { bd = dd; best = c; }
      }
      nxt0[p] = bd === Infinity ? nearest(p) : best;
    }
  }
  let cur = nxt0;
  for (let it = 0; it < passes; it++) {
    const nxt = new Int16Array(cur);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const c0 = cur[p];
        if (c0 < 0) continue;
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = cur[p + dy * w + dx];
            if (v >= 0) cnt[v]++;
          }
        }
        let best = c0, bc = cnt[c0];
        for (let c = 0; c < K; c++) if (cnt[c] > bc) { bc = cnt[c]; best = c; }
        nxt[p] = best;
      }
    }
    cur = nxt;
  }
  return cur;
}

// ---------- SVG ----------
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
  if (paths.length === 0) warnings.push('Tidak ada path hasil trace. Coba naikkan toleransi latar atau tambah warna.');
  return { paths: paths.length, nodes, colors: fills.size, bytes, hasRaster, hasEffects, warnings };
}

// Kanvas keluaran: isi (union kotak objek) + margin, diperbesar ke rasio yang diminta lalu dipusatkan.
function layoutCanvas(content, ratio, marginRel) {
  const m = Math.max(content.w, content.h) * marginRel;
  const needW = content.w + 2 * m, needH = content.h + 2 * m;
  let W = needW, H = needH;
  if (ratio > 0) {
    if (needW / needH > ratio) { W = needW; H = W / ratio; } else { H = needH; W = H * ratio; }
  }
  return { W, H, offX: (W - content.w) / 2 - content.x, offY: (H - content.h) / 2 - content.y };
}

const fmt = (n) => +n.toFixed(2);
function wrapSvg(inner, W, H, artboardLong) {
  const s = artboardLong / Math.max(W, H);
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${Math.round(W * s)}" height="${Math.round(H * s)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">\n${inner}\n</svg>\n`;
}


// Tepi stiker: cincin terluar objek (selebar r piksel dari latar) yang terang. Warnanya = median cincin itu, diambil ke
// warna palet terdekat. Mengembalikan juga penanda piksel cincin terang supaya bisa dipaksa ke warna tepi (cincin tipis
// 2-4 px tidak punya piksel "datar", jadi kalau tidak dipaksa ia tertelan warna garis di sebelahnya).
function borderInfo(data, labels, w, h, o, x0, y0, cw, ch, pal) {
  const r = Math.max(2, Math.round(Math.max(w, h) / 350));
  const sm = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) sm[y * cw + x] = labels[(y + y0) * w + (x + x0)] === o.index ? 1 : 0;
  // jarak horizontal ke piksel bukan-objek terdekat
  const dH = new Int16Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    let last = -1e4;
    for (let x = 0; x < cw; x++) { if (!sm[y * cw + x]) last = x; dH[y * cw + x] = Math.min(x - last, 30000); }
    last = 1e4;
    for (let x = cw - 1; x >= 0; x--) { if (!sm[y * cw + x]) last = x; dH[y * cw + x] = Math.min(dH[y * cw + x], last - x); }
  }
  const ring = new Uint8Array(cw * ch);
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!sm[y * cw + x]) continue;
      let m = dH[y * cw + x];
      for (let k = 1; k <= r && m > r; k++) {
        m = y - k >= 0 ? Math.min(m, dH[(y - k) * cw + x]) : 0;
        m = y + k < ch ? Math.min(m, dH[(y + k) * cw + x]) : 0;
        if (m <= r) break;
      }
      if (m > r) continue;
      const i = ((y + y0) * w + (x + x0)) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= 190) {
        ring[y * cw + x] = 1;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
      }
    }
  }
  const med = (a) => { a.sort((u, v) => u - v); return a[a.length >> 1]; };
  let target;
  if (rs.length >= 30) target = [med(rs), med(gs), med(bs)];
  else { const lt = pal.reduce((m, c) => (c.lab[0] > m.lab[0] ? c : m), pal[0]); target = [lt.r, lt.g, lt.b]; }
  const lab = [0, 0, 0];
  rgb2lab(target[0], target[1], target[2], lab);
  let best = 0, bd = Infinity;
  pal.forEach((c, i) => { const dd = (lab[0] - c.lab[0]) ** 2 + (lab[1] - c.lab[1]) ** 2 + (lab[2] - c.lab[2]) ** 2; if (dd < bd) { bd = dd; best = i; } });
  return { color: pal[best], index: best, ring, forced: rs.length >= 30 };
}

export function traceImageData(imgd, opts = {}) {
  const {
    colors = 14, detail = 'sedang', removeBg = true, bgTol = 8, shadow = true, ratio = 'asli', marginRel = 0.06,
    smooth = 2, rightAngle = false, artboardLong = 3000, limits = DEFAULT_LIMITS
  } = opts;
  const { width: w, height: h, data } = imgd;
  const lvl = DETAIL_LEVELS[detail] || DETAIL_LEVELS.sedang;
  const ratioVal = (RATIOS[ratio] || RATIOS.asli).value;

  let bg = { mask: new Uint8Array(w * h), ratio: 0, info: null };
  if (removeBg) bg = detectBackground(imgd, { tol: bgTol, shadow });
  const sep = separateObjects(bg.mask, w, h);
  let objects = sep.objects;
  let labels = sep.labels;
  if (objects.length === 0) {
    // tidak ada latar terdeteksi (atau semuanya latar): perlakukan seluruh gambar sebagai satu objek
    labels = new Int32Array(w * h).fill(1);
    objects = [{ index: 1, area: w * h, x: 0, y: 0, w, h }];
  }
  let removed = 0;
  for (let p = 0; p < labels.length; p++) if (!labels[p]) removed++;

  const flat = flatMask(data, labels, w, h);
  const pal = buildPalette(data, labels, Math.max(2, Math.min(24, colors | 0)), flat);
  const idx = quantize(data, labels, flat, w, h, pal, smooth);
  const tracerPal = pal.map((c) => ({ r: c.r, g: c.g, b: c.b, a: 255 }));
  tracerPal.push({ r: 0, g: 0, b: 0, a: 0 });

  const margin = 2;
  const traced = objects.map((o) => {
    const x0 = Math.max(0, o.x - margin), y0 = Math.max(0, o.y - margin);
    const x1 = Math.min(w, o.x + o.w + margin), y1 = Math.min(h, o.y + o.h + margin);
    const cw = x1 - x0, ch = y1 - y0;
    const bi = borderInfo(data, labels, w, h, o, x0, y0, cw, ch, pal);
    const cd = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const p = (y + y0) * w + (x + x0);
        if (labels[p] === o.index && idx[p] >= 0) {
          const c = bi.forced && bi.ring[y * cw + x] ? bi.color : pal[idx[p]];
          const q = (y * cw + x) * 4;
          cd[q] = c.r; cd[q + 1] = c.g; cd[q + 2] = c.b; cd[q + 3] = 255;
        }
      }
    }
    const topts = {
      ltres: lvl.ltres, qtres: lvl.qtres, pathomit: lvl.pathomit, rightangleenhance: rightAngle,
      colorsampling: 0, numberofcolors: 2, mincolorratio: 0, colorquantcycles: 1,
      layering: 0, strokewidth: 0, linefilter: false, scale: 1, roundcoords: 2, viewbox: true, desc: false, lcpr: 0, qcpr: 0,
      blurradius: 0, blurdelta: 20
    };
    const clean = (raw) => (raw.match(PATH_RE) || [])
      .filter((p) => !/\bopacity="0"/.test(p) && !/fill-opacity="0"/.test(p))
      .map((p) => p.replace(/\s(?:stroke="[^"]*"|stroke-width="[^"]*"|opacity="1")/g, ''));
    // alas: siluet objek berwarna tepi stiker (krem). Jadi bentuk tersendiri, sekaligus menutup celah tipis antar-path.
    const bc = bi.color;
    const sd = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (labels[(y + y0) * w + (x + x0)] === o.index) { const q = (y * cw + x) * 4; sd[q] = bc.r; sd[q + 1] = bc.g; sd[q + 2] = bc.b; sd[q + 3] = 255; }
      }
    }
    const base = clean(ImageTracer.imagedataToSVG({ width: cw, height: ch, data: sd }, { ...topts, pal: [{ r: bc.r, g: bc.g, b: bc.b, a: 255 }, { r: 0, g: 0, b: 0, a: 0 }], pathomit: Math.max(lvl.pathomit, 30) }));
    const art = clean(ImageTracer.imagedataToSVG({ width: cw, height: ch, data: cd }, { ...topts, pal: tracerPal, numberofcolors: tracerPal.length }));
    const paths = [...base, ...art];
    return { o, x0, y0, cw, ch, paths: paths.join('\n') };
  });

  // SVG per objek: objek dipusatkan di kanvas berrasio
  const objSvgs = traced.map((t, i) => {
    const content = { x: 0, y: 0, w: t.cw, h: t.ch };
    const L = layoutCanvas(content, ratioVal, marginRel);
    const svg = wrapSvg(`<g id="objek-${i + 1}" transform="translate(${fmt(L.offX)} ${fmt(L.offY)})">\n${t.paths}\n</g>`, L.W, L.H, artboardLong);
    return { index: i + 1, bbox: t.o, svg, stats: analyzeSvg(svg, limits) };
  });

  // SVG gabungan: tata letak asli dipertahankan, dibungkus kanvas berrasio
  const ux0 = Math.min(...traced.map((t) => t.x0)), uy0 = Math.min(...traced.map((t) => t.y0));
  const ux1 = Math.max(...traced.map((t) => t.x0 + t.cw)), uy1 = Math.max(...traced.map((t) => t.y0 + t.ch));
  const content = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
  const L = layoutCanvas(content, ratioVal, marginRel);
  const groups = traced.map((t, i) => `<g id="objek-${i + 1}" transform="translate(${t.x0} ${t.y0})">\n${t.paths}\n</g>`).join('\n');
  const svg = wrapSvg(`<g id="susunan" transform="translate(${fmt(L.offX)} ${fmt(L.offY)})">\n${groups}\n</g>`, L.W, L.H, artboardLong);
  const stats = analyzeSvg(svg, limits);
  if (objects.length > 1 && removeBg && bg.ratio < 0.2) stats.warnings.push('Latar yang terbuang hanya ' + (bg.ratio * 100).toFixed(0) + '%. Naikkan toleransi latar bila masih ada sisa latar.');

  return {
    svg, stats, objects: objSvgs,
    bgRemovedRatio: removed / (w * h), bgInfo: bg.info,
    palette: pal.map((c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`),
    layout: { W: L.W, H: L.H, originX: L.offX, originY: L.offY },
    width: w, height: h
  };
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
