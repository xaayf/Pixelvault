import React, { useEffect, useMemo, useRef, useState } from 'react';
import GlassSelect from './GlassSelect.jsx';
import { Shapes, Loader2, Download, AlertTriangle, CheckCircle2, UploadCloud, Archive, Wand2 } from 'lucide-react';
import { DETAIL_LEVELS, SMOOTHNESS, RATIOS, DEFAULT_LIMITS, meanAbsDiff } from './vectorize.js';
import { makeZip } from './zip.js';

const EDGES = [1000, 1400, 2000];
const CHECKER = {
  backgroundImage:
    'linear-gradient(45deg,#8883 25%,transparent 25%),linear-gradient(-45deg,#8883 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8883 75%),linear-gradient(-45deg,transparent 75%,#8883 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0'
};

const loadImage = (url) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Gambar gagal dimuat'));
    i.src = url;
  });

const saveBlob = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

export default function VectorTrace({ imageUrl, baseName, isDark }) {
  const [ownUrl, setOwnUrl] = useState('');
  const [ownName, setOwnName] = useState('');
  const [colors, setColors] = useState(14);
  const [detail, setDetail] = useState('sedang');
  const [removeBg, setRemoveBg] = useState(true);
  const [bgTol, setBgTol] = useState(8);
  const [shadow, setShadow] = useState(true);
  const [ratio, setRatio] = useState('asli');
  const [smoothness, setSmoothness] = useState('seimbang');
  const [edge, setEdge] = useState(1400);
  const [maxNodes, setMaxNodes] = useState(DEFAULT_LIMITS.maxNodes);
  const [maxColors, setMaxColors] = useState(DEFAULT_LIMITS.maxColors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [auto, setAuto] = useState(true);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const workerRef = useRef(null);
  const reqRef = useRef(0);

  const srcUrl = ownUrl || imageUrl || '';
  const name = (ownUrl ? ownName : baseName) || 'trace';

  useEffect(() => () => { workerRef.current?.terminate(); if (ownUrl) URL.revokeObjectURL(ownUrl); }, []); // eslint-disable-line
  useEffect(() => { setResult(null); setError(''); setAuto(true); }, [srcUrl]);
  // Deteksi otomatis: ukur karakter gambar (sisi pendek 800 px) lalu isi pengaturan. Mengubah kontrol manual mematikan mode otomatis.
  const applySettings = (st) => {
    if (!st) return;
    setColors(st.colors); setEdge(st.edge); setSmoothness(st.smoothness); setBgTol(st.bgTol); setRemoveBg(st.removeBg); setShadow(st.shadow);
  };
  const autoRef = useRef(true);
  useEffect(() => { autoRef.current = auto; }, [auto]);
  useEffect(() => {
    if (!srcUrl) { setAnalysis(null); return undefined; }
    let dead = false;
    let worker = null;
    const timer = setTimeout(async () => {
      setAnalyzing(true);
      try {
        const img = await loadImage(srcUrl);
        const k = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k));
        const h = Math.max(1, Math.round(img.naturalHeight * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        const buf = ctx.getImageData(0, 0, w, h).data.buffer.slice(0);
        worker = new Worker(new URL('./vectorWorker.js', import.meta.url), { type: 'module' });
        const out = await new Promise((res, rej) => {
          worker.onmessage = (ev) => (ev.data.ok ? res(ev.data) : rej(new Error(ev.data.error)));
          worker.onerror = (ev) => rej(new Error(ev.message || 'Analisis gagal'));
          worker.postMessage({ id: 0, kind: 'analyze', width: w, height: h, buffer: buf, opts: { limits: { maxNodes, maxColors }, naturalLong: Math.max(img.naturalWidth, img.naturalHeight) } }, [buf]);
        });
        if (dead) return;
        setAnalysis(out);
        if (autoRef.current) applySettings(out.settings);
      } catch { if (!dead) setAnalysis(null); } finally {
        worker?.terminate();
        if (!dead) setAnalyzing(false);
      }
    }, 350);
    return () => { dead = true; clearTimeout(timer); worker?.terminate(); };
  }, [srcUrl, maxColors]); // eslint-disable-line

  const man = (fn) => (v) => { setAuto(false); fn(v); };
  const turnAuto = (on) => { setAuto(on); if (on && analysis) applySettings(analysis.settings); };


  const pickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (ownUrl) URL.revokeObjectURL(ownUrl);
    setOwnUrl(URL.createObjectURL(f));
    setOwnName(f.name.replace(/\.[^/.]+$/, ''));
    e.target.value = '';
  };

  const run = async () => {
    if (!srcUrl || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    const id = ++reqRef.current;
    try {
      const img = await loadImage(srcUrl);
      const k = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const src = ctx.getImageData(0, 0, w, h);
      workerRef.current?.terminate();
      const worker = new Worker(new URL('./vectorWorker.js', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      const out = await new Promise((res, rej) => {
        worker.onmessage = (ev) => (ev.data.ok ? res(ev.data) : rej(new Error(ev.data.error)));
        worker.onerror = (ev) => rej(new Error(ev.message || 'Worker gagal'));
        const copy = src.data.buffer.slice(0);
        worker.postMessage({ id, width: w, height: h, buffer: copy, opts: { colors, detail, removeBg, bgTol, shadow, ratio, smoothness, limits: { maxNodes, maxColors } } }, [copy]);
      });
      worker.terminate();
      workerRef.current = null;
      if (id !== reqRef.current) return;
      // cek kemiripan: render SVG gabungan di kanvasnya, bandingkan dengan sumber yang diletakkan pada posisi tata letaknya
      const svgBlob = new Blob([out.svg], { type: 'image/svg+xml' });
      const svgUrl = URL.createObjectURL(svgBlob);
      const objects = out.objects.map((o) => {
        const blob = new Blob([o.svg], { type: 'image/svg+xml' });
        return { ...o, blob, url: URL.createObjectURL(blob) };
      });
      let diff = null;
      try {
        const rimg = await loadImage(svgUrl);
        const cw = Math.max(1, Math.round(out.layout.W));
        const chh = Math.max(1, Math.round(out.layout.H));
        const rc = document.createElement('canvas');
        rc.width = cw;
        rc.height = chh;
        const rctx = rc.getContext('2d', { willReadFrequently: true });
        rctx.fillStyle = '#fff';
        rctx.fillRect(0, 0, cw, chh);
        rctx.drawImage(rimg, 0, 0, cw, chh);
        const sc = document.createElement('canvas');
        sc.width = cw;
        sc.height = chh;
        const sctx = sc.getContext('2d', { willReadFrequently: true });
        sctx.fillStyle = '#fff';
        sctx.fillRect(0, 0, cw, chh);
        sctx.drawImage(c, Math.round(out.layout.originX), Math.round(out.layout.originY));
        // hanya bandingkan piksel di dalam objek (latar yang dibuang sengaja berbeda dari sumber)
        const a = rctx.getImageData(0, 0, cw, chh).data;
        const b = sctx.getImageData(0, 0, cw, chh).data;
        let sum = 0, n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] === 255 && a[i + 1] === 255 && a[i + 2] === 255) continue;
          sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          n += 3;
        }
        diff = n ? sum / n / 255 : null;
      } catch { /* pratinjau tetap tampil tanpa skor */ }
      setResult({ ...out, svgUrl, svgBlob, objects, diff, w, h });
    } catch (e) {
      setError(e.message || 'Trace gagal');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => { if (result?.svgUrl) URL.revokeObjectURL(result.svgUrl); result?.objects?.forEach((o) => URL.revokeObjectURL(o.url)); }, [result]);

  const warnings = useMemo(() => {
    if (!result) return [];
    const w = [...result.stats.warnings];
    if (result.diff != null && result.diff > 0.09) w.push(`Hasil menyimpang ${(result.diff * 100).toFixed(1)}% dari gambar asli. Naikkan jumlah warna atau detail.`);
    return w;
  }, [result]);

  const downloadJpg = async () => {
    if (!result) return;
    const img = await loadImage(result.svgUrl);
    const long = 2000;
    const k = long / Math.max(result.layout.W, result.layout.H);
    const c = document.createElement('canvas');
    c.width = Math.round(result.layout.W * k);
    c.height = Math.round(result.layout.H * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob((b) => b && saveBlob(b, `${name}_preview.jpg`), 'image/jpeg', 0.92);
  };

  const downloadZip = () => {
    if (!result) return;
    const files = [{ name: `${name}_gabungan.svg`, data: result.svg }, ...result.objects.map((o) => ({ name: `${name}_objek${o.index}.svg`, data: o.svg }))];
    saveBlob(makeZip(files), `${name}_svg.zip`);
  };

  const panel = isDark ? 'bg-slate-900/80 border-white/10' : 'bg-white border-slate-200';
  const sub = isDark ? 'text-slate-400' : 'text-slate-500';
  const field = `w-full rounded-lg border px-2 py-2 text-xs ${isDark ? 'bg-slate-950 border-white/10' : 'bg-slate-50 border-slate-200'}`;
  const chip = (ok) => `px-2 py-0.5 rounded-full text-[10px] font-mono border ${ok ? 'border-emerald-500/40 text-emerald-400' : 'border-amber-500/40 text-amber-400'}`;

  return (
    <div className={`p-4 sm:p-5 rounded-2xl border ${panel} backdrop-blur-xl space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2"><Shapes className="w-4 h-4 text-cyan-400" /> Auto-Trace ke SVG (Adobe Stock Vector)</h2>
          <p className={`text-[11px] leading-relaxed mt-1 ${sub}`}>
            Untuk gambar datar warna solid (stiker/ilustrasi flat) di latar polos atau bergradasi lembut, satu objek atau banyak objek. Latar dan bayangan dibuang otomatis, tiap objek jadi SVG sendiri plus satu SVG gabungan. Gambar painterly atau penuh gradasi tidak cocok.
          </p>
        </div>
        <label className="shrink-0 min-h-[40px] px-3 rounded-xl border border-white/15 text-xs font-medium flex items-center gap-1.5 cursor-pointer">
          <UploadCloud className="w-3.5 h-3.5" /> Pilih gambar
          <input type="file" accept="image/*" className="hidden" onChange={pickFile} />
        </label>
      </div>

      {!srcUrl ? (
        <div className={`py-10 text-center text-xs ${sub}`}>Pilih gambar, atau muat gambar di tab Studio dulu.</div>
      ) : (
        <>
          <div className={`rounded-xl border p-3 space-y-2 backdrop-blur-md ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-200 bg-white/60'}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold">
                {analyzing ? <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> : <Wand2 className="w-4 h-4 text-cyan-400" />}
                Pengaturan otomatis
                {analysis?.profile && !analyzing && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 text-cyan-300">
                    {analysis.profile === 'garis-tipis' ? 'Garis tipis' : analysis.profile === 'gradasi' ? 'Gradasi / painterly' : 'Stiker / bentuk tebal'}
                  </span>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={auto}
                aria-label="Pengaturan otomatis"
                onClick={() => turnAuto(!auto)}
                disabled={!analysis?.settings}
                className={`relative h-6 w-11 rounded-full border transition-colors disabled:opacity-40 ${auto ? 'bg-cyan-500/70 border-cyan-400/60' : isDark ? 'bg-white/10 border-white/20' : 'bg-slate-200 border-slate-300'}`}
              >
                <span className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-all ${auto ? 'left-[22px]' : 'left-0.5'}`} style={{ height: 18, width: 18 }} />
              </button>
            </div>
            {analysis?.settings && (
              <p className={`text-[11px] leading-relaxed ${sub}`}>
                {auto ? 'Terdeteksi: ' : 'Saran otomatis: '}
                <span className={isDark ? 'text-slate-200' : 'text-slate-700'}>
                  {analysis.settings.edge}px, {analysis.settings.colors} warna, kurva {SMOOTHNESS[analysis.settings.smoothness]?.label.split(' (')[0].toLowerCase()}, toleransi latar {analysis.settings.bgTol}
                </span>
                . {analysis.reasons.join('; ')}.
                {!auto && ' Kamu sudah mengubah pengaturan manual.'}
              </p>
            )}
            {analysis?.warnings?.length > 0 && (
              <ul className="space-y-1">
                {analysis.warnings.map((w, i) => <li key={i} className="text-[11px] text-amber-400 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w}</li>)}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label className="text-[11px] space-y-1">
              <span className={sub}>Jumlah warna: {colors}</span>
              <input type="range" min={4} max={24} value={colors} onChange={(e) => man(setColors)(+e.target.value)} className="w-full" />
            </label>
            <label className="text-[11px] space-y-1">
              <span className={sub}>Detail (hanya untuk mode lama)</span>
              <GlassSelect isDark={isDark} ariaLabel="Detail" value={detail} onChange={man(setDetail)} options={Object.entries(DETAIL_LEVELS).map(([k, v]) => ({ value: k, label: v.label }))} />
            </label>
            <label className="text-[11px] space-y-1">
              <span className={sub}>Sisi terpanjang kerja</span>
              <GlassSelect isDark={isDark} ariaLabel="Sisi terpanjang kerja" value={edge} onChange={(v) => man(setEdge)(+v)} options={EDGES.map((v) => ({ value: v, label: `${v}px${analysis?.settings?.edge === v ? ' (disarankan)' : ''}` }))} />
            </label>
            <label className="text-[11px] space-y-1">
              <span className={sub}>Kehalusan kurva</span>
              <GlassSelect isDark={isDark} ariaLabel="Kehalusan kurva" value={smoothness} onChange={man(setSmoothness)} options={Object.entries(SMOOTHNESS).map(([k, v]) => ({ value: k, label: v.label }))} />
            </label>
            <label className="text-[11px] space-y-1">
              <span className={sub}>Rasio kanvas SVG</span>
              <GlassSelect isDark={isDark} ariaLabel="Rasio kanvas SVG" value={ratio} onChange={setRatio} options={Object.entries(RATIOS).map(([k, v]) => ({ value: k, label: v.label }))} />
            </label>
            <label className="text-[11px] flex items-center gap-2 min-h-[40px]">
              <input type="checkbox" checked={removeBg} onChange={(e) => man(setRemoveBg)(e.target.checked)} className="w-5 h-5" />
              <span>Buang latar otomatis</span>
            </label>
            <label className={`text-[11px] flex items-center gap-2 min-h-[40px] ${removeBg ? '' : 'opacity-40'}`}>
              <input type="checkbox" checked={shadow} disabled={!removeBg} onChange={(e) => man(setShadow)(e.target.checked)} className="w-5 h-5" />
              <span>Buang bayangan lembut</span>
            </label>
            <label className={`text-[11px] space-y-1 ${removeBg ? '' : 'opacity-40'}`}>
              <span className={sub}>Toleransi latar: {bgTol}</span>
              <input type="range" min={2} max={30} value={bgTol} disabled={!removeBg} onChange={(e) => man(setBgTol)(+e.target.value)} className="w-full" />
            </label>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <label className="space-y-1"><span className={sub}>Maks titik</span>
                <input type="number" min={1000} step={1000} value={maxNodes} onChange={(e) => setMaxNodes(Math.max(1000, +e.target.value || 1000))} className={field} /></label>
              <label className="space-y-1"><span className={sub}>Maks warna</span>
                <input type="number" min={2} max={24} value={maxColors} onChange={(e) => setMaxColors(Math.max(2, +e.target.value || 2))} className={field} /></label>
            </div>
          </div>

          <button onClick={run} disabled={busy} className="w-full min-h-[46px] rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-500 text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shapes className="w-4 h-4" />}
            {busy ? 'Men-trace...' : 'Jalankan Auto-Trace'}
          </button>
          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className={`text-[10px] uppercase tracking-wider ${sub}`}>Asli</div>
              <div className="rounded-xl overflow-hidden border border-white/10 bg-white"><img src={srcUrl} alt="asli" className="w-full max-h-[360px] object-contain" /></div>
            </div>
            <div className="space-y-1">
              <div className={`text-[10px] uppercase tracking-wider ${sub}`}>SVG hasil trace</div>
              <div className="rounded-xl overflow-hidden border border-white/10 min-h-[120px]" style={CHECKER}>
                {result ? <img src={result.svgUrl} alt="svg" className="w-full max-h-[360px] object-contain" /> : <div className={`py-10 text-center text-xs ${sub}`}>Belum ada hasil</div>}
              </div>
            </div>
          </div>

          {result && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <span className={chip(result.stats.nodes <= maxNodes)}>{result.stats.nodes} titik</span>
                <span className={chip(result.stats.colors <= maxColors)}>{result.stats.colors} warna</span>
                <span className={chip(true)}>{result.stats.paths} path</span>
                <span className={chip(true)}>{(result.stats.bytes / 1024).toFixed(1)} KB</span>
                {result.diff != null && <span className={chip(result.diff <= 0.09)}>selisih {(result.diff * 100).toFixed(1)}%</span>}
                <span className={chip(!result.stats.hasRaster)}>{result.stats.hasRaster ? 'ada raster' : 'tanpa raster'}</span>
              </div>
              {warnings.length > 0 ? (
                <ul className="space-y-1">
                  {warnings.map((w, i) => <li key={i} className="text-[11px] text-amber-400 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w}</li>)}
                </ul>
              ) : (
                <p className="text-[11px] text-emerald-400 flex gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />Lolos pemeriksaan otomatis. Tetap buka di Illustrator/Inkscape dan cek manual sebelum unggah.</p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => saveBlob(result.svgBlob, `${name}_gabungan.svg`)} className="min-h-[44px] rounded-xl bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5"><Download className="w-4 h-4" /> SVG gabungan</button>
                <button onClick={downloadJpg} className="min-h-[44px] rounded-xl border border-white/15 text-xs font-semibold flex items-center justify-center gap-1.5"><Download className="w-4 h-4" /> Pratinjau JPG</button>
              </div>
              <button onClick={downloadZip} className="w-full min-h-[44px] rounded-xl bg-indigo-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5"><Archive className="w-4 h-4" /> Unduh semua (ZIP: gabungan + {result.objects.length} objek)</button>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {result.objects.map((o) => (
                  <div key={o.index} className="rounded-xl border border-white/10 p-2 space-y-1.5">
                    <div className="rounded-lg overflow-hidden" style={CHECKER}><img src={o.url} alt={`objek ${o.index}`} className="w-full h-24 object-contain" /></div>
                    <div className={`text-[10px] font-mono ${sub}`}>Objek {o.index} · {o.stats.nodes} titik · {o.stats.colors} warna</div>
                    <button onClick={() => saveBlob(o.blob, `${name}_objek${o.index}.svg`)} className="w-full min-h-[36px] rounded-lg border border-white/15 text-[11px] font-medium flex items-center justify-center gap-1"><Download className="w-3.5 h-3.5" /> SVG</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={`rounded-xl border p-3 text-[11px] leading-relaxed space-y-1 ${isDark ? 'border-white/10 bg-slate-950/60' : 'border-slate-200 bg-slate-50'}`}>
            <div className="font-semibold">Catatan Adobe Stock (Vector, konten AI)</div>
            <div className={sub}>
              Terima format AI/EPS/SVG (bukan ZIP/JPEG). Hasil AI harus dirapikan agar semudah diedit seperti vektor biasa. Wajib centang &quot;Created using generative AI tools&quot; saat unggah. Angka batas titik dan warna di atas hanya asumsi, bukan aturan resmi Adobe. Cek halaman syarat teknis vektor Adobe sebelum unggah massal, dan uji 5 file dulu.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
