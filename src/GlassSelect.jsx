import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

// Dropdown kustom bergaya glassmorphism (pengganti <select> bawaan yang daftar pilihannya tidak bisa distyling).
// options: [{ value, label }]. Daftar dirender lewat portal + posisi fixed supaya tidak terpotong overflow induk.
export default function GlassSelect({ value, onChange, options, isDark = true, className = '', ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, up: false, maxH: 280 });
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const uid = useId();
  const sel = Math.max(0, options.findIndex((o) => String(o.value) === String(value)));

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    setPos({ left: r.left, top: up ? r.top - 6 : r.bottom + 6, width: r.width, up, maxH: Math.max(140, Math.min(300, up ? above : below)) });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => { if (!listRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const pick = (i) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKey = (e) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); setActive(sel); setOpen(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const trigger = isDark
    ? 'bg-white/[0.06] border-white/15 text-slate-100 hover:bg-white/10 hover:border-white/25'
    : 'bg-white/60 border-slate-300/70 text-slate-800 hover:bg-white/80';
  const panel = isDark
    ? 'bg-slate-900/60 border-white/15 text-slate-100 shadow-[0_12px_40px_rgba(0,0,0,0.55)]'
    : 'bg-white/70 border-white/80 text-slate-800 shadow-[0_12px_40px_rgba(15,23,42,0.18)]';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${uid}-list`}
        aria-label={ariaLabel}
        onClick={() => { setActive(sel); setOpen((o) => !o); }}
        onKeyDown={onKey}
        className={`w-full min-h-[40px] flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs text-left backdrop-blur-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${trigger} ${open ? 'border-cyan-400/60' : ''} ${className}`}
      >
        <span className="truncate">{options[sel]?.label}</span>
        <ChevronDown className={`w-4 h-4 shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <ul
          ref={listRef}
          id={`${uid}-list`}
          role="listbox"
          style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, maxHeight: pos.maxH, zIndex: 80 }}
          className={`overflow-auto rounded-2xl border p-1.5 backdrop-blur-2xl backdrop-saturate-150 ${panel}`}
        >
          {options.map((o, i) => {
            const isSel = i === sel;
            return (
              <li
                key={String(o.value)}
                data-i={i}
                role="option"
                aria-selected={isSel}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(i)}
                className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs cursor-pointer transition-colors ${
                  i === active ? (isDark ? 'bg-white/12' : 'bg-slate-900/8') : ''
                } ${isSel ? (isDark ? 'text-cyan-300' : 'text-indigo-600') + ' font-semibold' : ''}`}
              >
                <span className="truncate">{o.label}</span>
                {isSel && <Check className="w-3.5 h-3.5 shrink-0" />}
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </>
  );
}
