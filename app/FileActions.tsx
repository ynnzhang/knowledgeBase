'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { workspaceHeaders } from './local-workspace';
import { FilePlus2, FolderPlus, Folder, X } from 'lucide-react';

type Action = 'create-note' | 'create-folder';
export type FileResult = {
  path: string;
  previousPath?: string;
  kind?: string;
  index: {
    generatedAt: string;
    workspace: string;
    folders: string[];
    notes: Array<{ id: string; name: string; path: string; raw: string; modified: string; source: 'local'; version?: string; bodyLoaded?: boolean }>;
  };
};
type Props = {
  folders: string[];
  selectedFolder: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onComplete: (result: FileResult, action: Action) => void;
};
const subscribe = () => () => {};

export default function FileActions(props: Props) {
  const local = useSyncExternalStore(subscribe, () => ['localhost', '127.0.0.1'].includes(location.hostname), () => false);
  const [action, setAction] = useState<Action | null>(null);
  if (!local) return null;
  return <>
    <div className="file-actions" role="group" aria-label="新建笔记或文件夹">
      <button disabled={props.disabled} title="新建笔记" aria-label="新建笔记" onClick={() => setAction('create-note')}><FilePlus2 size={15} /></button>
      <button disabled={props.disabled} title="新建文件夹" aria-label="新建文件夹" onClick={() => setAction('create-folder')}><FolderPlus size={15} /></button>
    </div>
    {action && <FileDialog {...props} action={action} onClose={() => setAction(null)} />}
  </>;
}

function FileDialog({ action, folders, selectedFolder, disabled, onBusyChange, onComplete, onClose }: Props & { action: Action; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [folder, setFolder] = useState(selectedFolder);
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = action === 'create-note' ? '新建笔记' : '新建文件夹';
  const choices = ['', ...folders].filter((item) => !search || (item || '知识库根目录').toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      const response = await fetch('/local-api/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
        body: JSON.stringify({ action, folder, name }),
      });
      const result = await response.json() as FileResult & { error?: string };
      if (!response.ok) throw new Error(result.error || '文件操作失败，请重试。');
      onComplete(result, action);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '文件操作失败。');
    } finally { setBusy(false); onBusyChange(false); }
  }
  return <dialog ref={dialog} className="file-dialog" aria-labelledby="file-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => void submit(event)}>
      <header><h3 id="file-dialog-title">{title}</h3><button type="button" disabled={busy} onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <label className="file-name-label">{action === 'create-folder' ? '文件夹名称' : '笔记名称'}<input autoFocus required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder={action === 'create-folder' ? '例如：学习计划' : '例如：MyBatis 学习笔记'} /></label>
      <div className="folder-picker-heading"><strong>选择保存文件夹</strong><span>{folder || '知识库根目录'}</span></div>
      <input className="folder-search" aria-label="搜索目标文件夹" placeholder="搜索文件夹…" value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} />
      <div className="folder-picker" role="radiogroup" aria-label="目标文件夹">
        {choices.map((item) => <label key={item} className={folder === item ? 'chosen' : ''}>
          <input type="radio" name="destination" checked={folder === item} disabled={busy} onChange={() => setFolder(item)} />
          <Folder size={17} /><span>{item || '知识库根目录'}</span>
        </label>)}
        {!choices.length && <p>没有匹配的文件夹</p>}
      </div>
      {error && <p className="editor-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || disabled || !name.trim()}>{busy ? '正在处理…' : title}</button></footer>
    </form>
  </dialog>;
}
