import React, { useEffect, useRef, useState } from 'react';
import { ScanSearch, Loader2, Crosshair, X } from 'lucide-react';
import { scanImage, scanMicro, DEFECT_TYPES } from './detector.js';

const ZOOMS = [100, 200, 400];
const CROP = 160; // piksel kanvas

function CropCanvas({ img, cx, cy, zoom }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    const win = Math.round(CROP / (zoom / 100));
    const sx = Math.max(0, Math.min(img.naturalWidth - win, Math.round(cx - win / 2)));
    const sy = Math.max(0, Math.min(img.naturalHeight - win, Math.round(cy - win / 2)));
    c.width = CROP;
    c.height = CROP;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, CROP, CROP);
    ctx.drawImage(img, sx, sy, win, win, 0, 0, CROP, CROP);
  }, [img, cx, cy, zoom]);
  return <canvas ref={ref} className="w-full aspect-square rounded-md border border-white/10 bg-black" style={{ imageRendering: 'pixelated' }} />;
}

export default function DefectScanner({ imageUrl, isDark, onOpenLoupe }) {
  const [sensitivity, setSensitivity] = useState(1);
  const [symmetry, setSymmetry] = useState('off');
  const [mode, setMode] = useState('standar'); // 'standar' | 'mikro'
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [imgEl, setImgEl] = useState(null);
  const overlayRef = useRef(null);
  const cancelRef = useRef(false);
  const cardRefs = useRef({});

  // Reset hasil bila gambar berganti
  useEffect(() => {
    setResult(null);
    setSelected(null);
    setImgEl(null);
    setError('');
  }, [imageUrl]);

  const run = async () => {
    if (!imageUrl || busy) return;
    setBusy(true);
    setError('');
    setProgress(0);
    cancelRef.current = false;
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Gambar gagal dimuat'));
        i.src = imageUrl;
      });
      const out = mode === 'mikro'
        ? await scanMicro(img, { sensitivity }, setProgress, () => cancelRef.current)
        : await scanImage(img, { sensitivity, symmetry }, setProgress, () => cancelRef.current);
      if (out) {
        setImgEl(img);
        setResult(out);
        setSelected(null);
      }
    } catch (e) {
      setError(e.message || 'Pemindaian gagal');
    } finally {
      setBusy(false);
    }
  };

  // Gambar heatmap + kotak temuan
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !result) return;
    const cw = 900;
    const ch = Math.round((cw * result.H) / result.W);
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    const sc = cw / result.W;
    for (const t of result.tiles) {
      if (t.score < 0.15) continue;
      ctx.globalAlpha = Math.min(0.5, 0.12 + t.score * 0.45);
      ctx.fillStyle = DEFECT_TYPES[t.type].color;
      ctx.fillRect(t.x * sc, t.y * sc, t.w * sc, t.h * sc);
    }
    ctx.globalAlpha = 1;
    result.findings.forEach((t, n) => {
      const col = DEFECT_TYPES[t.type].color;
      ctx.lineWidth = selected === n ? 6 : 3;
      ctx.strokeStyle = col;
      ctx.strokeRect(t.x * sc, t.y * sc, t.w * sc, t.h * sc);
      ctx.fillStyle = col;
      const r = 15;
      ctx.beginPath();
      ctx.arc(t.x * sc + r, t.y * sc + r, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#020617';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n + 1), t.x * sc + r, t.y * sc + r + 1);
    });
  }, [result, selected]);

  const onOverlayClick = (e) => {
    if (!result) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * result.W;
    const py = ((e.clientY - rect.top) / rect.height) * result.H;
    const n = result.findings.findIndex((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h);
    if (n >= 0) {
      setSelected(n);
      cardRefs.current[n]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const panel = isDark ? 'bg-slate-900/80 border-white/10' : 'bg-white border-slate-200';

  return (
    <div className={`p-5 rounded-2xl border ${panel} backdrop-blur-xl space-y-4`}>
      <div>
        <h3 className="font-bold text-base flex items-center gap-2">
          <ScanSearch className="w-4 h-4 text-cyan-400" /> Pemindai Cacat Visual
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Mencari area curiga (blur, noda, blok JPEG, asimetri, olesan) lalu menampilkannya di zoom 100/200/400%. Ini penyaring otomatis berbasis algoritma, bukan AI:
          jari berlebih atau anatomi janggal <strong>tidak</strong> terdeteksi, dan bagian yang sengaja buram atau asimetris bisa ikut ditandai.
        </p>
      </div>

      <div className="space-y-1.5 text-xs">
        <div className="font-semibold text-slate-300">Mode pindai</div>
        <div className="flex gap-1 p-1 rounded-xl bg-slate-950 border border-white/10">
          {[['standar', 'Standar (blur, noda, blok, simetri)'], ['mikro', 'Mikro (olesan hasil upscale)']].map(([v, l]) => (
            <button key={v} type="button" onClick={() => { setMode(v); setResult(null); }}
              className={`flex-1 px-2 py-1.5 rounded-lg font-bold transition ${mode === v ? 'bg-gradient-to-r from-cyan-500 to-indigo-500 text-white' : 'text-slate-400'}`}>
              {l}
            </button>
          ))}
        </div>
        {mode === 'mikro' && (
          <p className="text-[11px] text-slate-400">Tile 32px pada resolusi asli untuk mencari olesan: tekstur lembek/berlilin hasil upscale AI. Halo tepi dan tepi bergelombang belum andal, jadi belum dilaporkan. Area yang berolesan merata di seluruh gambar tidak ditandai, karena pembandingnya adalah sekitar; periksa dengan zoom.</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div className="space-y-1.5">
          <div className="font-semibold text-slate-300">Sensitivitas</div>
          <div className="flex gap-1 p-1 rounded-xl bg-slate-950 border border-white/10">
            {[[1.3, 'Longgar'], [1, 'Normal'], [0.75, 'Ketat']].map(([v, l]) => (
              <button key={l} type="button" onClick={() => setSensitivity(v)}
                className={`flex-1 px-2 py-1.5 rounded-lg font-bold transition ${sensitivity === v ? 'bg-gradient-to-r from-cyan-500 to-indigo-500 text-white' : 'text-slate-400'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {mode === 'standar' && <div className="space-y-1.5">
          <div className="font-semibold text-slate-300">Cek simetri cermin</div>
          <div className="flex gap-1 p-1 rounded-xl bg-slate-950 border border-white/10">
            {[['off', 'Mati'], ['vertical', 'Kiri↔Kanan'], ['horizontal', 'Atas↔Bawah']].map(([v, l]) => (
              <button key={v} type="button" onClick={() => setSymmetry(v)}
                className={`flex-1 px-2 py-1.5 rounded-lg font-bold transition ${symmetry === v ? 'bg-gradient-to-r from-cyan-500 to-indigo-500 text-white' : 'text-slate-400'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>}
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={run} disabled={!imageUrl || busy}
          className="px-4 py-2.5 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-indigo-500 text-white disabled:opacity-40 flex items-center gap-2">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
          {busy ? `Memindai ${Math.round(progress * 100)}%` : 'Pindai Gambar'}
        </button>
        {busy && (
          <button type="button" onClick={() => { cancelRef.current = true; }} className="text-xs text-slate-400 flex items-center gap-1">
            <X className="w-3.5 h-3.5" /> Batal
          </button>
        )}
        {!imageUrl && <span className="text-xs text-slate-400">Muat gambar dulu di tab Studio.</span>}
      </div>
      {error && <div className="text-xs text-rose-400">{error}</div>}

      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            {Object.entries(DEFECT_TYPES).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: v.color }} /> {v.label}
              </span>
            ))}
            <span className="font-mono">Tile {result.T}px • {result.cols}×{result.rows}</span>
            {result.stats.symCorr !== null && <span className="font-mono">Korelasi cermin {result.stats.symCorr.toFixed(2)}</span>}
          </div>

          <div className="relative w-full rounded-xl overflow-hidden border border-white/10 bg-slate-950">
            <img src={imageUrl} alt="Hasil pindai" className="w-full h-auto block" draggable={false} />
            <canvas ref={overlayRef} onClick={onOverlayClick} className="absolute inset-0 w-full h-full cursor-pointer" />
          </div>

          {result.findings.length === 0 ? (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
              Tidak ada area yang melewati ambang pada sensitivitas ini. Coba "Ketat" untuk pemeriksaan lebih rapat. Ingat: ini tidak menjamin gambar bebas cacat.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-xs font-bold text-slate-300">{result.findings.length} area paling curiga (urut skor)</div>
              {result.findings.map((t, n) => {
                const def = DEFECT_TYPES[t.type];
                const ccx = t.x + t.w / 2;
                const ccy = t.y + t.h / 2;
                return (
                  <div key={n} ref={(el) => { cardRefs.current[n] = el; }}
                    className={`p-3 rounded-xl border space-y-2 ${selected === n ? 'border-cyan-400' : 'border-white/10'} ${isDark ? 'bg-slate-950/70' : 'bg-slate-50'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-bold flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] text-slate-950" style={{ background: def.color }}>{n + 1}</span>
                          {def.label} • skor {Math.round(t.score * 100)}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">{def.hint} Posisi ≈ x {Math.round((ccx / result.W) * 100)}%, y {Math.round((ccy / result.H) * 100)}%.</p>
                      </div>
                      {onOpenLoupe && (
                        <button type="button" onClick={() => onOpenLoupe(Math.round((ccx / result.W) * 100), Math.round((ccy / result.H) * 100))}
                          className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-bold border border-white/10 text-cyan-300 flex items-center gap-1">
                          <Crosshair className="w-3 h-3" /> Loupe
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {ZOOMS.map((z) => (
                        <div key={z} className="space-y-1">
                          <CropCanvas img={imgEl} cx={ccx} cy={ccy} zoom={z} />
                          <div className="text-center text-[10px] font-mono text-slate-400">{z}%</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
