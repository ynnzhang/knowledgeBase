'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X } from 'lucide-react';
export type RenameTarget = { path: string; kind: 'note' | 'folder'; x: number; y: number; editing?: boolean };
type Props = { target: RenameTarget; onClose: () => void; onRename: (path: string, kind: 'note' | 'folder', name: string) => Promise<void> };

export default function FileRename({ target, onClose, onRename }: Props) {
  const [editing, setEditing] = useState(Boolean(target.editing));
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) return;
    const element = menu.current!;
    element.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector('button')?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) onClose(); };
    const closeOnScroll = () => onClose();
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnScroll);
    return () => { document.removeEventListener('pointerdown', closeOutside); window.removeEventListener('scroll', closeOnScroll, true); window.removeEventListener('resize', closeOnScroll); };
  }, [editing, onClose, target.x, target.y]);
  if (editing) return <RenameDialog target={target} onClose={onClose} onRename={onRename} />;
  return createPortal(<div ref={menu} className="file-context-menu" role="menu" aria-label="文件操作" style={{ left: target.x, top: target.y }} onKeyDown={(event) => { if (event.key === 'Escape' || event.key === 'Tab') onClose(); }}>
    <button role="menuitem" onClick={() => setEditing(true)}><Pencil size={14} />重命名<kbd>F2</kbd></button>
  </div>, document.body);
}

function RenameDialog({ target, onClose, onRename }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const original = target.path.split('/').at(-1)!;
  const [name, setName] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    element.showModal(); input.current?.focus();
    input.current?.setSelectionRange(0, target.kind === 'note' ? original.replace(/\.md(?:own)?$/i, '').length : original.length);
    return () => element.close();
  }, [original, target.kind]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy || !name.trim() || name.trim() === original) return;
    setBusy(true); setError('');
    try { await onRename(target.path, target.kind, name); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '重命名失败。'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="file-dialog rename-dialog" aria-labelledby="rename-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => void submit(event)}>
      <header><h3 id="rename-title">重命名{target.kind === 'folder' ? '文件夹' : '笔记'}</h3><button type="button" disabled={busy} onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      <label className="file-name-label">名称<input ref={input} required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      {error && <p className="editor-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !name.trim() || name.trim() === original}>{busy ? '正在更新…' : '确定'}</button></footer>
    </form>
  </dialog>;
}
