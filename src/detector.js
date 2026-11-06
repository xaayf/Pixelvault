// Detektor cacat visual (tanpa AI, jalan di browser).
// Per tile: blur terisolasi, noda/blotch, blok JPEG, dan (opsional) asimetri cermin.
// Hasilnya hanya petunjuk. Keputusan akhir tetap di mata manusia.

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const median = (arr) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (arr, med) => median(arr.map((v) => Math.abs(v - med)));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

export const DEFECT_TYPES = {
  blur: { label: 'Blur', color: '#f59e0b', hint: 'Area lebih buram daripada sekitarnya yang tajam.' },
  stain: { label: 'Noda', color: '#f43f5e', hint: 'Bercak warna/terang yang berdiri sendiri dan berbeda dari sekitarnya.' },
  block: { label: 'Blok JPEG', color: '#a78bfa', hint: 'Pola kotak 8×8 akibat kompresi.' },
  sym: { label: 'Asimetri', color: '#22d3ee', hint: 'Berbeda dari bayangan cermin sisi seberang.' },
  smear: { label: 'Olesan', color: '#ec4899', hint: 'Tekstur lembek/berlilin atau seperti olesan cat dibanding sekitarnya (ciri upscale AI).' },
};

export async function scanImage(img, opts = {}, onProgress = () => {}, shouldCancel = () => false) {
  const {
    sensitivity = 1, // 0.75 ketat, 1 normal, 1.3 longgar
    symmetry = 'off', // 'off' | 'vertical' | 'horizontal'
    maxFindings = 12,
  } = opts;
  const k = sensitivity;
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // Ukuran tile ~40 tile pada sisi terpanjang, kelipatan 8 agar sejajar dengan grid JPEG.
  let T = Math.round(Math.max(W, H) / 40 / 8) * 8;
  T = Math.max(64, Math.min(256, T));
  const cols = Math.max(1, Math.floor(W / T));
  const rows = Math.max(1, Math.floor(H / T));
  // Sisa piksel di tepi kanan/bawah digabung ke tile terakhir agar seluruh gambar tercakup.
  const tileW = (cx) => (cx === cols - 1 ? W - cx * T : T);
  const tileH = (cy) => (cy === rows - 1 ? H - cy * T : T);

  const N = cols * rows;
  const sharp = new Float64Array(N);
  const acut = new Float64Array(N).fill(-1);
  const g98 = new Float64Array(N);
  const sd = new Float64Array(N);
  const lum = new Float64Array(N);
  const ca = new Float64Array(N);
  const cb = new Float64Array(N);
  const blockRatio = new Float64Array(N);
  const blockBase = new Float64Array(N);

  const cv = document.createElement('canvas');
  cv.width = T * 2;
  cv.height = T * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  // ---- Pass 1: metrik per tile pada resolusi asli ----
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const tw = tileW(cx);
      const th = tileH(cy);
      cv.width = tw;
      cv.height = th;
      ctx.drawImage(img, cx * T, cy * T, tw, th, 0, 0, tw, th);
      const d = ctx.getImageData(0, 0, tw, th).data;
      const L = new Float32Array(tw * th);
      let sumL = 0, sumA = 0, sumB = 0;
      for (let i = 0, p = 0; i < L.length; i++, p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        L[i] = l;
        sumL += l;
        sumA += r - g;
        sumB += b - (r + g) / 2;
      }
      const n = L.length;
      const meanL = sumL / n;
      let v = 0;
      for (let i = 0; i < n; i++) { const t = L[i] - meanL; v += t * t; }
      const idx = cy * cols + cx;
      lum[idx] = meanL;
      ca[idx] = sumA / n;
      cb[idx] = sumB / n;
      sd[idx] = Math.sqrt(v / n);

      // Varian Laplacian
      let ls = 0, ls2 = 0, lc = 0;
      for (let y = 1; y < th - 1; y++) {
        for (let x = 1; x < tw - 1; x++) {
          const i = y * tw + x;
          const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - tw] - L[i + tw];
          ls += lap; ls2 += lap * lap; lc++;
        }
      }
      const lm = ls / lc;
      sharp[idx] = ls2 / lc - lm * lm;

      // Acutance: rasio |Laplacian| / gradien pada piksel tepi. Tepi tajam bernilai tinggi,
      // tepi yang melebar (blur) rendah. Tidak bergantung pada banyaknya konten di tile.
      let ar = 0, ac = 0;
      const hist = new Uint32Array(256);
      for (let y = 1; y < th - 1; y++) {
        for (let x = 1; x < tw - 1; x++) {
          const i = y * tw + x;
          const gx = (L[i + 1] - L[i - 1]) / 2;
          const gy = (L[i + tw] - L[i - tw]) / 2;
          const g = Math.sqrt(gx * gx + gy * gy);
          hist[Math.min(255, g | 0)]++;
          if (g > 15) {
            const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - tw] - L[i + tw];
            ar += Math.abs(lap) / g;
            ac++;
          }
        }
      }
      if (ac >= Math.max(80, 0.004 * lc)) acut[idx] = ar / ac;
      // Gradien puncak (persentil 98): tile buram tidak punya tepi tajam sama sekali.
      let acc = 0, target = 0.02 * lc, gp = 0;
      for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= target) { gp = b; break; } }
      g98[idx] = gp;

      // Diskontinuitas di batas blok 8×8 vs di dalam blok
      let bd = 0, bc = 0, od = 0, oc = 0;
      for (let y = 0; y < th; y += 2) {
        for (let x = 1; x < tw; x++) {
          const diff = Math.abs(L[y * tw + x] - L[y * tw + x - 1]);
          if (diff >= 12) continue; // hanya area halus; tepi gambar sungguhan diabaikan
          if (x % 8 === 0) { bd += diff; bc++; } else { od += diff; oc++; }
        }
      }
      for (let x = 0; x < tw; x += 2) {
        for (let y = 1; y < th; y++) {
          const diff = Math.abs(L[y * tw + x] - L[(y - 1) * tw + x]);
          if (diff >= 12) continue;
          if (y % 8 === 0) { bd += diff; bc++; } else { od += diff; oc++; }
        }
      }
      const bAvg = bc ? bd / bc : 0;
      const oAvg = oc ? od / oc : 0;
      blockBase[idx] = oAvg;
      blockRatio[idx] = bc >= 60 && oc >= 300 ? bAvg / (oAvg + 0.35) : 1;
    }
    onProgress(0.05 + 0.75 * ((cy + 1) / rows));
    await nextFrame();
    if (shouldCancel()) return null;
  }

  const at = (cx, cy) => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? -1 : cy * cols + cx);
  const neighbors8 = (cx, cy) => {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = at(cx + dx, cy + dy);
      if (j >= 0) out.push(j);
    }
    return out;
  };

  // ---- Skor blur: tepi di tile ini lebih melebar daripada tepi di sekitarnya ----
  const blur = new Float64Array(N);
  const sharpMed = median(Array.from(sharp));
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      let sc = 0;
      // (a) tepi ada tapi melebar dibanding sekitar
      if (acut[i] >= 0) {
        const nb = neighbors8(cx, cy).filter((j) => acut[j] >= 0);
        if (nb.length >= 3) {
          const mn = median(nb.map((j) => acut[j]));
          if (mn > 0) sc = Math.max(sc, clamp01((0.65 / k - acut[i] / mn) / (0.65 / k - 0.3 / k)));
        }
      }
      // (b) ada konten (sd cukup) tapi tidak ada tepi tajam, padahal sekitarnya tajam
      if (sd[i] > 14) {
        const nb = neighbors8(cx, cy).filter((j) => g98[j] >= 50);
        if (nb.length >= 3) {
          const mn = median(nb.map((j) => g98[j]));
          sc = Math.max(sc, clamp01((0.5 / k - g98[i] / mn) / (0.5 / k - 0.2 / k)));
        }
      }
      blur[i] = sc;
    }
  }

  // ---- Skor noda: tile yang menyimpang dari semua pasangan tetangga berlawanan ----
  const dev = new Float64Array(N);
  const pairs = [[[-1, 0], [1, 0]], [[0, -1], [0, 1]], [[-1, -1], [1, 1]], [[1, -1], [-1, 1]]];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      let best = Infinity, used = 0;
      for (const [p, q] of pairs) {
        const a = at(cx + p[0], cy + p[1]);
        const b = at(cx + q[0], cy + q[1]);
        if (a < 0 || b < 0) continue;
        used++;
        const da = ca[i] - (ca[a] + ca[b]) / 2;
        const db = cb[i] - (cb[a] + cb[b]) / 2;
        const dl = 0.5 * (lum[i] - (lum[a] + lum[b]) / 2);
        best = Math.min(best, Math.sqrt(da * da + db * db + dl * dl));
      }
      dev[i] = used >= 2 ? best : 0;
    }
  }
  const devMed = median(Array.from(dev));
  const devMad = mad(Array.from(dev), devMed) * 1.4826 + 0.5;
  const stain = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const z = (dev[i] - devMed) / devMad;
    if (dev[i] < 6) continue;
    stain[i] = clamp01((z - 4 * k) / (6 * k));
  }

  // ---- Skor blok JPEG ----
  const block = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (blockBase[i] < 0.8) continue;
    block[i] = clamp01((blockRatio[i] - 1.5 * k) / (0.7 * k));
  }

  // ---- Simetri cermin (thumbnail kecil) ----
  const sym = new Float64Array(N);
  let symCorr = null;
  if (symmetry !== 'off') {
    const S = 16;
    const tw = cols * S, th = rows * S;
    const tc = document.createElement('canvas');
    tc.width = tw; tc.height = th;
    const tctx = tc.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(img, 0, 0, W, H, 0, 0, tw, th);
    const td = tctx.getImageData(0, 0, tw, th).data;
    const TL = new Float32Array(tw * th);
    for (let i = 0, p = 0; i < TL.length; i++, p += 4) TL[i] = 0.299 * td[p] + 0.587 * td[p + 1] + 0.114 * td[p + 2];
    const mirror = (x, y) => (symmetry === 'vertical' ? [tw - 1 - x, y] : [x, th - 1 - y]);
    const dmap = new Float64Array(N);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let acc = 0;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const px = cx * S + x, py = cy * S + y;
          const [mx, my] = mirror(px, py);
          const a = TL[py * tw + px], b = TL[my * tw + mx];
          acc += Math.abs(a - b);
          sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; cnt++;
        }
        dmap[cy * cols + cx] = acc / (S * S);
      }
    }
    const cov = sab / cnt - (sa / cnt) * (sb / cnt);
    const va = saa / cnt - (sa / cnt) ** 2;
    const vb = sbb / cnt - (sb / cnt) ** 2;
    symCorr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    const dm = median(Array.from(dmap));
    const dmad = mad(Array.from(dmap), dm) * 1.4826 + 2;
    for (let i = 0; i < N; i++) {
      const z = (dmap[i] - dm) / dmad;
      sym[i] = dmap[i] < 14 ? 0 : clamp01((z - 3 * k) / (5 * k));
    }
  }
  onProgress(0.9);

  // ---- Gabung skor + pilih temuan teratas (non-max suppression) ----
  const W_TYPE = { blur: 1, stain: 0.9, block: 0.6, sym: 0.7 };
  const tiles = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const s = { blur: blur[i], stain: stain[i], block: block[i], sym: sym[i] };
      let type = 'blur', top = 0;
      for (const key of Object.keys(s)) {
        const v = s[key] * W_TYPE[key];
        if (v > top) { top = v; type = key; }
      }
      tiles.push({
        cx, cy, i,
        x: cx * T, y: cy * T, w: tileW(cx), h: tileH(cy),
        scores: s, type, score: top,
      });
    }
  }
  const ranked = tiles.filter((t) => t.score >= 0.25).sort((a, b) => b.score - a.score);
  const findings = [];
  for (const t of ranked) {
    if (findings.length >= maxFindings) break;
    if (findings.filter((f) => f.type === t.type).length >= 5) continue; // satu jenis tidak boleh menutupi yang lain
    if (findings.some((f) => Math.max(Math.abs(f.cx - t.cx), Math.abs(f.cy - t.cy)) < 3)) continue;
    findings.push(t);
  }
  onProgress(1);
  return {
    W, H, T, cols, rows, tiles, findings,
    stats: { sharpMedian: sharpMed, symCorr, flaggedTiles: ranked.length },
  };
}


// ---------------------------------------------------------------------------
// Mode Mikro: tile kecil (32px) pada resolusi asli untuk cacat halus hasil upscale AI.
// ---------------------------------------------------------------------------
export async function scanMicro(img, opts = {}, onProgress = () => {}, shouldCancel = () => false) {
  const { sensitivity = 1, maxFindings = 12 } = opts;
  const k = sensitivity;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const T = 32;
  const M = 8; // margin baris agar filter di batas strip tetap benar
  const cols = Math.max(1, Math.floor(W / T));
  const rows = Math.max(1, Math.floor(H / T));
  const tileH = (cy) => (cy === rows - 1 ? H - cy * T : T);
  const tileW = (cx) => (cx === cols - 1 ? W - cx * T : T);
  const N = cols * rows;

  const hfS = new Float64Array(N), mfS = new Float64Array(N), cnt = new Float64Array(N);
  const sumL = new Float64Array(N), sumL2 = new Float64Array(N);
  const eCnt = new Float64Array(N), ringBase = new Float64Array(N), ring = new Float64Array(N);
  const pairs = new Float64Array(N), dth = new Float64Array(N);

  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const I = new Float64Array((W + 1) * (T + 2 * M + 1));

  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * T;
    const th = tileH(cy);
    const ys = Math.max(0, y0 - M);
    const ye = Math.min(H, y0 + th + M);
    const hs = ye - ys;
    cv.width = W;
    cv.height = hs;
    ctx.drawImage(img, 0, ys, W, hs, 0, 0, W, hs);
    const d = ctx.getImageData(0, 0, W, hs).data;
    const L = new Float32Array(W * hs);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) L[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    // integral image
    const stride = W + 1;
    for (let x = 0; x <= W; x++) I[x] = 0;
    for (let y = 0; y < hs; y++) {
      let row = 0;
      I[(y + 1) * stride] = 0;
      for (let x = 0; x < W; x++) {
        row += L[y * W + x];
        I[(y + 1) * stride + x + 1] = I[y * stride + x + 1] + row;
      }
    }
    const mean = (x, y, r) => {
      const xa = Math.max(0, x - r), xb = Math.min(W - 1, x + r);
      const ya = Math.max(0, y - r), yb = Math.min(hs - 1, y + r);
      const a = I[(yb + 1) * stride + xb + 1] - I[ya * stride + xb + 1] - I[(yb + 1) * stride + xa] + I[ya * stride + xa];
      return a / ((xb - xa + 1) * (yb - ya + 1));
    };

    const lyStart = y0 - ys;
    for (let ly = lyStart; ly < lyStart + th; ly++) {
      if (ly < 1 || ly >= hs - 1) continue;
      let prevTheta = NaN;
      for (let x = 1; x < W - 1; x++) {
        const cx = Math.min(cols - 1, Math.floor(x / T));
        const t = cy * cols + cx;
        const i = ly * W + x;
        const l = L[i];
        const b1 = mean(x, ly, 1);
        const b4 = mean(x, ly, 4);
        hfS[t] += Math.abs(l - b1);
        mfS[t] += Math.abs(b1 - b4);
        sumL[t] += l;
        sumL2[t] += l * l;
        cnt[t]++;
        const gx = (L[i + 1] - L[i - 1]) / 2;
        const gy = (L[i + W] - L[i - W]) / 2;
        const g = Math.sqrt(gx * gx + gy * gy);
        if (g > 40) {
          eCnt[t]++;
          let th2 = Math.atan2(gy, gx);
          if (th2 < 0) th2 += Math.PI; // orientasi tanpa arah
          if (!Number.isNaN(prevTheta)) {
            let dd = Math.abs(th2 - prevTheta);
            if (dd > Math.PI / 2) dd = Math.PI - dd;
            dth[t] += dd;
            pairs[t]++;
          }
          prevTheta = th2;
          // Halo: profil sepanjang arah gradien
          let ux = gx / g, uy = gy / g;
          const at = (o) => {
            const xx = x + Math.round(ux * o), yy = ly + Math.round(uy * o);
            if (xx < 0 || xx >= W || yy < 0 || yy >= hs) return null;
            return L[yy * W + xx];
          };
          let p2 = at(2), m2 = at(-2);
          if (p2 !== null && m2 !== null) {
            if (p2 < m2) { ux = -ux; uy = -uy; }
            p2 = at(2); m2 = at(-2);
            const p4 = at(4), m4 = at(-4);
            if (p4 !== null && m4 !== null && Math.abs(p2 - m2) > 40) {
              ringBase[t]++;
              { const A = Math.abs(p2 - m2); if (p4 < p2 - 0.1 * A && m4 > m2 + 0.1 * A) ring[t]++; }
            }
          }
        } else {
          prevTheta = NaN;
        }
      }
    }
    onProgress(0.05 + 0.85 * ((cy + 1) / rows));
    await nextFrame();
    if (shouldCancel()) return null;
  }

  const at2 = (cx, cy) => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? -1 : cy * cols + cx);
  // Pembanding: jendela ±8 tile (~256px) tanpa 3×3 di tengah, agar area cacat yang lebih besar
  // dari satu tile tidak menjadi pembanding dirinya sendiri.
  const RAD = 8;
  const nbrs = (cx, cy) => {
    const out = [];
    for (let dy = -RAD; dy <= RAD; dy++) for (let dx = -RAD; dx <= RAD; dx++) {
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;
      const j = at2(cx + dx, cy + dy);
      if (j >= 0) out.push(j);
    }
    return out;
  };

  const hf = new Float64Array(N), q = new Float64Array(N), sd = new Float64Array(N), ringF = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (!cnt[i]) continue;
    hf[i] = hfS[i] / cnt[i];
    q[i] = mfS[i] / cnt[i] / (hf[i] + 0.3);
    const m = sumL[i] / cnt[i];
    sd[i] = Math.sqrt(Math.max(0, sumL2[i] / cnt[i] - m * m));
    ringF[i] = ringBase[i] >= 30 ? ring[i] / ringBase[i] : -1;
  }

  const smear = new Float64Array(N), halo = new Float64Array(N);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const nb = nbrs(cx, cy);
      // Olesan: detail halus hilang tetapi struktur menengah tetap ada (seperti cat/lilin).
      // Area yang memang halus (langit, gradasi) tidak ikut, karena energi menengahnya juga rendah.
      if (sd[i] > 6) {
        const tex = nb.filter((j) => hf[j] > 1.5);
        if (tex.length >= 20) {
          const mn = median(tex.map((j) => hf[j]));
          const mq = median(tex.map((j) => q[j]));
          const rq = mq > 0 ? q[i] / mq : 0;
          const sD = clamp01((rq - 1.8 * k) / (1.2 * k));
          const rA = hf[i] / mn;
          const sA = rq >= 1.2 ? clamp01((0.5 / k - rA) / (0.5 / k - 0.2 / k)) : 0;
          smear[i] = Math.max(sD, 0.8 * sA);
        }
      }
      // Halo
      if (ringF[i] >= 0) {
        const rn = nb.filter((j) => ringF[j] >= 0);
        if (rn.length >= 12) {
          const mr = median(rn.map((j) => ringF[j]));
          halo[i] = clamp01((ringF[i] - mr - 0.25 * k) / (0.3 * k));
        }
      }
    }
  }
  onProgress(0.95);

  // Halo tepi dan tepi bergelombang sudah dicoba tetapi belum andal (terlalu banyak tanda palsu pada tepi alami),
  // jadi tidak dilaporkan. Perhitungan halo dibiarkan di atas hanya sebagai data mentah.
  const W_TYPE = { smear: 1, halo: 0 };
  const tiles = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const sc = { smear: smear[i], halo: halo[i] };
      let type = 'smear', top = 0;
      for (const key of Object.keys(sc)) {
        const v = sc[key] * W_TYPE[key];
        if (v > top) { top = v; type = key; }
      }
      tiles.push({ cx, cy, i, x: cx * T, y: cy * T, w: tileW(cx), h: tileH(cy), scores: sc, type, score: top, raw: { ringF: ringF[i], ringBase: ringBase[i], hf: hf[i], q: q[i] } });
    }
  }
  const ranked = tiles.filter((t) => t.score >= 0.3).sort((a, b) => b.score - a.score);
  const findings = [];
  for (const t of ranked) {
    if (findings.length >= maxFindings) break;
    if (findings.filter((f) => f.type === t.type).length >= 4) continue;
    if (findings.some((f) => Math.max(Math.abs(f.cx - t.cx), Math.abs(f.cy - t.cy)) < 4)) continue;
    findings.push(t);
  }
  onProgress(1);
  return { W, H, T, cols, rows, tiles, findings, stats: { sharpMedian: median(Array.from(hf)), symCorr: null, flaggedTiles: ranked.length } };
}
