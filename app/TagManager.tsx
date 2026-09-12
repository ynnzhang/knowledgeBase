'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Tag, Plus, Pencil, Trash2, X } from 'lucide-react';

type TagNote = { path: string; title: string; tags: string[] };
type Props = {
  note?: TagNote;
  notes: TagNote[];
  filters: string[];
  onFilter: (tags: string[]) => void;
  disabled: boolean;
  onSave: (tags: string[]) => Promise<void>;
  onManage: (action: 'rename-tag' | 'delete-tag', tag: string, name?: string) => Promise<void>;
};
const subscribe = () => () => {};

export default function TagManager(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button className={`tag-manager-trigger ${props.filters.length ? 'has-filter' : ''}`} onClick={() => setOpen(true)} title={props.filters.length ? `标签筛选：${props.filters.join('、')}` : '标签'} aria-label="添加、管理或筛选标签" aria-haspopup="dialog" aria-expanded={open}>
      <Tag size={17} />{props.filters.length > 0 && <i />}
    </button>
    {open && <TagDialog {...props} onClose={() => setOpen(false)} />}
  </>;
}

function TagDialog({ note, notes, filters, onFilter, disabled, onSave, onManage, onClose }: Props & { onClose: () => void }) {
  const local = useSyncExternalStore(subscribe, () => ['localhost', '127.0.0.1'].includes(location.hostname), () => false);
  const [tab, setTab] = useState<'note' | 'filter' | 'manage'>(filters.length || !note ? 'filter' : 'note');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ tag: string; action: 'rename-tag' | 'delete-tag'; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const counts = new Map<string, number>();
  notes.forEach((item) => [...new Set(item.tags)].forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const visibleTags = tags.filter((tag) => tag.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  async function manage() {
    if (!editing || busy || disabled) return;
    setBusy(true); setError('');
    try { await onManage(editing.action, editing.tag, editing.name); setEditing(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '标签更新失败。'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="tag-manager-dialog" aria-labelledby="tag-manager-title" onClick={(event) => {
    if (event.target !== event.currentTarget || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h3 id="tag-manager-title">标签</h3><button disabled={busy} onClick={onClose} aria-label="关闭标签面板"><X size={17} /></button></header>
    <div className="tag-manager-tabs" aria-label="标签操作">
      {([['note', '当前笔记'], ['filter', '筛选'], ['manage', '统一管理']] as const).map(([value, label]) => <button key={value} aria-pressed={tab === value} disabled={busy} onClick={() => { setTab(value); setEditing(null); setError(''); }}>{label}</button>)}
    </div>
    {tab === 'note' ? note ? <CurrentNoteTags key={`${note.path}:${JSON.stringify(note.tags)}`} note={note} tags={tags} disabled={disabled || !local} onSave={onSave} onBusyChange={setBusy} /> : <p className="tag-manager-empty">先选择一篇笔记</p> : <>
      <input className="tag-manager-search" aria-label="搜索标签" placeholder="搜索标签…" value={query} onChange={(event) => setQuery(event.target.value)} disabled={busy} />
      {tab === 'filter' && <div className="tag-filter-summary"><span>{filters.length ? `匹配全部 ${filters.length} 个标签` : '显示全部笔记'}</span>{filters.length > 0 && <button onClick={() => onFilter([])}>清除筛选</button>}</div>}
      <div className="tag-manager-list">
        {visibleTags.map((tag) => <div className="managed-tag-row" key={tag}>
          {tab === 'filter' ? <label><input type="checkbox" checked={filters.includes(tag)} onChange={() => onFilter(filters.includes(tag) ? filters.filter((item) => item !== tag) : [...filters, tag])} /><span>{tag}</span><small>{counts.get(tag)}</small></label> : <>
            <span>{tag}</span><small>{counts.get(tag)}</small>
            <button aria-label={`重命名标签 ${tag}`} title="重命名" disabled={busy || disabled || !local} onClick={() => setEditing({ tag, name: tag, action: 'rename-tag' })}><Pencil size={14} /></button>
            <button aria-label={`删除标签 ${tag}`} title="删除标签" disabled={busy || disabled || !local} onClick={() => setEditing({ tag, name: '', action: 'delete-tag' })}><Trash2 size={14} /></button>
          </>}
        </div>)}
        {!visibleTags.length && <p className="tag-manager-empty">{tags.length ? '没有匹配的标签' : '还没有标签，可先给当前笔记添加'}</p>}
      </div>
      {editing && <form className="tag-bulk-edit" onSubmit={(event) => { event.preventDefault(); void manage(); }}>
        {editing.action === 'rename-tag' ? <label>重命名「{editing.tag}」<input autoFocus aria-label="新标签名称" maxLength={32} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} disabled={busy} /></label> : <p>从 {counts.get(editing.tag) || 0} 篇笔记中移除「{editing.tag}」？</p>}
        <div><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy || disabled || (editing.action === 'rename-tag' && (!editing.name.trim() || editing.name.trim() === editing.tag))}>{busy ? '正在更新…' : editing.action === 'delete-tag' ? '移除标签' : '应用到全部笔记'}</button></div>
      </form>}
      {error && <p className="editor-error" role="alert">{error}</p>}
    </>}
  </dialog>;
}

function CurrentNoteTags({ note, tags, disabled, onSave, onBusyChange }: { note: TagNote; tags: string[]; disabled: boolean; onSave: Props['onSave']; onBusyChange: (value: boolean) => void }) {
  const [draft, setDraft] = useState(note.tags);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function add(value: string) {
    const tag = value.trim().replace(/^#+/, '').trim().slice(0, 32);
    if (!tag || draft.includes(tag) || draft.length >= 20) return;
    setDraft([...draft, tag]); setInput('');
  }
  async function save() {
    if (busy || disabled) return;
    setBusy(true); onBusyChange(true); setError('');
    try { await onSave(draft); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '标签保存失败。'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <div className="current-note-tags">
    <p className="tag-note-title" title={note.path}>{note.title}</p>
    <div className="tag-drafts">{draft.map((tag) => <span key={tag}>{tag}<button disabled={busy || disabled} onClick={() => setDraft(draft.filter((item) => item !== tag))} aria-label={`移除 ${tag}`}><X size={11} /></button></span>)}</div>
    <form className="tag-add-form" onSubmit={(event) => { event.preventDefault(); add(input); }}>
      <input aria-label="新标签名称" maxLength={32} placeholder="添加标签…" value={input} disabled={busy || disabled} onChange={(event) => setInput(event.target.value)} />
      <button aria-label="添加标签" title="添加标签" disabled={busy || disabled || !input.trim() || draft.length >= 20}><Plus size={16} /></button>
    </form>
    <div className="tag-pick-existing">{tags.filter((tag) => !draft.includes(tag)).map((tag) => <button key={tag} disabled={busy || disabled || draft.length >= 20} onClick={() => add(tag)}>{tag}</button>)}</div>
    {error && <p className="editor-error" role="alert">{error}</p>}
    <footer><button className="primary" onClick={() => void save()} disabled={busy || disabled || JSON.stringify(draft) === JSON.stringify(note.tags)}>{busy ? '正在保存…' : '应用标签'}</button></footer>
  </div>;
}
