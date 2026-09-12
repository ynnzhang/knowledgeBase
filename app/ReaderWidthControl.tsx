'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';

export default function ReaderWidthControl({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const [open, setOpen] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="reader-width-menu" ref={element} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); element.current?.querySelector('button')?.focus(); } }}>
    <button className="quiet-control" title="调整页宽" aria-label="调整页宽" aria-expanded={open} aria-controls="reader-width-popover" onClick={() => setOpen(!open)}><Maximize2 size={15} /></button>
    {open && <div className="reader-width-popover" id="reader-width-popover">
      <label htmlFor="page-width-range">页宽<span>{width} px</span></label>
      <input id="page-width-range" type="range" min={480} max={1600} step={1} value={width} onChange={(event) => onChange(Number(event.target.value))} />
    </div>}
  </div>;
}
