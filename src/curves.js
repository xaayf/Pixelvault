// Kontur sub-piksel + pencocokan kurva Bezier kubik (algoritma Schneider, "Graphics Gems" 1990, domain publik).
// Alur: medan skalar (mask yang sudah diburamkan) -> marching squares pada level 0.5 -> loop tertutup -> pecah di sudut
// tajam -> cocokkan Bezier kubik dengan toleransi tertentu. Hasilnya kurva halus dengan sedikit node, bukan tangga piksel.

// ---------- marching squares ----------
export function marchContours(field, W, H, level = 0.5) {
  const val = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : field[y * W + x]);
  const PW = W + 2;
  const hkey = (x, y) => (y + 1) * PW + (x + 1);
  const base = PW * (H + 2);
  const vkey = (x, y) => base + (y + 1) * PW + (x + 1);
  const segs = []; // {a,b,p:[x,y],q:[x,y]}
  const addSeg = (ka, pa, kb, pb) => { segs.push({ a: ka, b: kb, p: pa, q: pb }); };
  for (let cy = -1; cy < H; cy++) {
    for (let cx = -1; cx < W; cx++) {
      const tl = val(cx, cy), tr = val(cx + 1, cy), br = val(cx + 1, cy + 1), bl = val(cx, cy + 1);
      const code = (tl >= level ? 1 : 0) | (tr >= level ? 2 : 0) | (br >= level ? 4 : 0) | (bl >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const interp = (v0, v1) => (v1 === v0 ? 0.5 : (level - v0) / (v1 - v0));
      const top = () => [hkey(cx, cy), [cx + interp(tl, tr), cy]];
      const bottom = () => [hkey(cx, cy + 1), [cx + interp(bl, br), cy + 1]];
      const left = () => [vkey(cx, cy), [cx, cy + interp(tl, bl)]];
      const right = () => [vkey(cx + 1, cy), [cx + 1, cy + interp(tr, br)]];
      const pair = (e1, e2) => { const A = e1(), B = e2(); addSeg(A[0], A[1], B[0], B[1]); };
      switch (code) {
        case 1: pair(top, left); break;
        case 2: pair(top, right); break;
        case 3: pair(left, right); break;
        case 4: pair(right, bottom); break;
        case 5: {
          const c = (tl + tr + br + bl) / 4 >= level;
          if (c) { pair(top, right); pair(left, bottom); } else { pair(top, left); pair(right, bottom); }
          break;
        }
        case 6: pair(top, bottom); break;
        case 7: pair(left, bottom); break;
        case 8: pair(bottom, left); break;
        case 9: pair(top, bottom); break;
        case 10: {
          const c = (tl + tr + br + bl) / 4 >= level;
          if (c) { pair(top, left); pair(right, bottom); } else { pair(top, right); pair(left, bottom); }
          break;
        }
        case 11: pair(right, bottom); break;
        case 12: pair(left, right); break;
        case 13: pair(top, right); break;
        case 14: pair(top, left); break;
        default: break;
      }
    }
  }
  // rangkai segmen jadi loop tanpa arah (tiap kunci sisi dipakai tepat dua segmen). Arah tidak dipakai: path memakai
  // fill-rule evenodd, jadi lubang dan bagian luar tetap benar.
  const at = new Map();
  segs.forEach((s, i) => {
    for (const k of [s.a, s.b]) { const l = at.get(k); if (l) l.push(i); else at.set(k, [i]); }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const loop = [];
    let cur = i;
    let key = segs[i].a; // titik awal loop; kita bergerak dari a ke b
    const startKey = key;
    while (cur !== -1 && !used[cur]) {
      used[cur] = 1;
      const s = segs[cur];
      const forward = s.a === key;
      loop.push(forward ? s.p : s.q);
      key = forward ? s.b : s.a;
      if (key === startKey) break;
      const cand = at.get(key);
      cur = -1;
      if (cand) for (const k of cand) if (!used[k]) { cur = k; break; }
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// ---------- geometri kecil ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

export function polyArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

// ---------- Schneider ----------
function bez(ctrl, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [a * ctrl[0][0] + b * ctrl[1][0] + c * ctrl[2][0] + d * ctrl[3][0], a * ctrl[0][1] + b * ctrl[1][1] + c * ctrl[2][1] + d * ctrl[3][1]];
}
function bez1(ctrl, t) {
  const mt = 1 - t;
  const q = [0, 1, 2].map((i) => sub(ctrl[i + 1], ctrl[i]));
  return [3 * (mt * mt * q[0][0] + 2 * mt * t * q[1][0] + t * t * q[2][0]), 3 * (mt * mt * q[0][1] + 2 * mt * t * q[1][1] + t * t * q[2][1])];
}
function bez2(ctrl, t) {
  const mt = 1 - t;
  const q = [0, 1, 2].map((i) => sub(ctrl[i + 1], ctrl[i]));
  const r = [0, 1].map((i) => sub(q[i + 1], q[i]));
  return [6 * (mt * r[0][0] + t * r[1][0]), 6 * (mt * r[0][1] + t * r[1][1])];
}

function chordParams(d, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(d[i], d[i - 1])));
  const tot = u[u.length - 1] || 1;
  return u.map((v) => v / tot);
}

function generateBezier(d, first, last, u, t1, t2) {
  const n = last - first + 1;
  const p0 = d[first], p3 = d[last];
  const C = [[0, 0], [0, 0]], X = [0, 0];
  for (let i = 0; i < n; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const A1 = mul(t1, b1), A2 = mul(t2, b2);
    C[0][0] += dot(A1, A1); C[0][1] += dot(A1, A2); C[1][1] += dot(A2, A2);
    const tmp = sub(d[first + i], add(add(mul(p0, b0 + b1), mul(p3, b2 + b3)), [0, 0]));
    X[0] += dot(A1, tmp); X[1] += dot(A2, tmp);
  }
  C[1][0] = C[0][1];
  const det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
  const dseg = len(sub(p3, p0));
  let a1, a2;
  if (Math.abs(det) > 1e-12) {
    a1 = (X[0] * C[1][1] - X[1] * C[0][1]) / det;
    a2 = (C[0][0] * X[1] - C[1][0] * X[0]) / det;
  } else { a1 = a2 = 0; }
  const eps = 1e-6 * dseg;
  if (a1 < eps || a2 < eps) { a1 = a2 = dseg / 3; }
  return [p0, add(p0, mul(t1, a1)), add(p3, mul(t2, a2)), p3];
}

function maxError(d, first, last, ctrl, u) {
  let maxD = 0, split = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const dd = sub(bez(ctrl, u[i - first]), d[i]);
    const e = dot(dd, dd);
    if (e >= maxD) { maxD = e; split = i; }
  }
  return [maxD, split];
}

function reparam(d, first, last, u, ctrl) {
  return u.map((t, i) => {
    const p = d[first + i];
    const q = bez(ctrl, t), q1 = bez1(ctrl, t), q2 = bez2(ctrl, t);
    const diff = sub(q, p);
    const num = dot(diff, q1);
    const den = dot(q1, q1) + dot(diff, q2);
    if (Math.abs(den) < 1e-12) return t;
    const nt = t - num / den;
    return nt < 0 ? 0 : nt > 1 ? 1 : nt;
  });
}

function fitCubic(d, first, last, t1, t2, err2, out) {
  if (last - first === 1) {
    const dist = len(sub(d[last], d[first])) / 3;
    out.push([d[first], add(d[first], mul(t1, dist)), add(d[last], mul(t2, dist)), d[last]]);
    return;
  }
  let u = chordParams(d, first, last);
  let ctrl = generateBezier(d, first, last, u, t1, t2);
  let [me, split] = maxError(d, first, last, ctrl, u);
  if (me < err2) { out.push(ctrl); return; }
  if (me < err2 * 16) {
    for (let i = 0; i < 6; i++) {
      u = reparam(d, first, last, u, ctrl);
      ctrl = generateBezier(d, first, last, u, t1, t2);
      [me, split] = maxError(d, first, last, ctrl, u);
      if (me < err2) { out.push(ctrl); return; }
    }
  }
  split = Math.max(first + 1, Math.min(last - 1, split));
  const c = norm(sub(d[split - 1], d[split + 1]));
  fitCubic(d, first, split, t1, c, err2, out);
  fitCubic(d, split, last, mul(c, -1), t2, err2, out);
}

// Sudut tajam: sudut belok pada jendela k titik > ambang, dan maksimum lokal.
function findCorners(p, k, thrDeg) {
  const n = p.length;
  const ang = new Float32Array(n);
  const thr = (thrDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = norm(sub(p[i], p[(i - k + n) % n])), b = norm(sub(p[(i + k) % n], p[i]));
    ang[i] = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  }
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < thr) continue;
    let isMax = true;
    for (let j = -k; j <= k && isMax; j++) if (j !== 0 && ang[(i + j + n) % n] > ang[i]) isMax = false;
    if (isMax) corners.push(i);
  }
  return corners;
}

// Pecah loop tertutup di sudut lalu cocokkan; tanpa sudut: pecah di dua titik berseberangan dengan tangen menerus.
export function fitLoop(pts, tol, { k = 4, cornerDeg = 55 } = {}) {
  const n = pts.length;
  if (n < 4) return null;
  const err2 = tol * tol;
  let corners = findCorners(pts, Math.min(k, Math.floor(n / 4)), cornerDeg);
  const curves = [];
  const piece = (from, to, tStart, tEnd) => {
    const arr = [];
    for (let i = from; ; i = (i + 1) % n) { arr.push(pts[i]); if (i === to) break; }
    if (arr.length < 2) return;
    const kk = Math.min(3, arr.length - 1);
    const t1 = tStart || norm(sub(arr[kk], arr[0]));
    const t2 = tEnd || norm(sub(arr[arr.length - 1 - kk], arr[arr.length - 1]));
    fitCubic(arr, 0, arr.length - 1, t1, t2, err2, curves);
  };
  if (corners.length === 0) {
    const a = 0, b = Math.floor(n / 2);
    const tan = (i) => norm(sub(pts[(i + 1) % n], pts[(i - 1 + n) % n]));
    piece(a, b, tan(a), mul(tan(b), -1));
    piece(b, a, tan(b), mul(tan(a), -1));
  } else {
    for (let c = 0; c < corners.length; c++) {
      const from = corners[c], to = corners[(c + 1) % corners.length];
      if (corners.length === 1) {
        // satu sudut: pecah di titik berseberangan agar fitting stabil
        const mid = (from + Math.floor(n / 2)) % n;
        const tan = norm(sub(pts[(mid + 1) % n], pts[(mid - 1 + n) % n]));
        piece(from, mid, null, mul(tan, -1));
        piece(mid, from, tan, null);
      } else piece(from, to, null, null);
    }
  }
  return curves;
}

const r2 = (v) => Math.round(v * 100) / 100;
// kurva -> string path (satu subpath tertutup). map: koordinat medan -> koordinat keluaran.
export function curvesToPath(curves, map, flatTol = 0.04) {
  if (!curves || curves.length === 0) return '';
  const m = (p) => { const q = map(p); return [r2(q[0]), r2(q[1])]; };
  const s = m(curves[0][0]);
  let d = `M ${s[0]} ${s[1]}`;
  for (const c of curves) {
    const p0 = m(c[0]), p1 = m(c[1]), p2 = m(c[2]), p3 = m(c[3]);
    // hampir lurus -> L (lebih mudah diedit di Illustrator/Corel)
    const L = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) || 1;
    const dist = (p) => Math.abs((p3[0] - p0[0]) * (p0[1] - p[1]) - (p0[0] - p[0]) * (p3[1] - p0[1])) / L;
    if (dist(p1) < flatTol && dist(p2) < flatTol) d += ` L ${p3[0]} ${p3[1]}`;
    else d += ` C ${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]}`;
  }
  return d + ' Z';
}
