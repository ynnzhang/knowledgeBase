'use client';

import { useState, useSyncExternalStore } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { workspaceHeaders } from './local-workspace';
const subscribe = () => () => {};

export default function LocalFolderPicker({ path, disabled, onBusyChange }: { path: string; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const local = useSyncExternalStore(subscribe, () => ['localhost', '127.0.0.1'].includes(location.hostname), () => false);
  const [busy, setBusy] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [error, setError] = useState('');
  async function choose(manual = false) {
    if (disabled || busy) return;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const response = await fetch(`/local-api/workspace/${manual ? 'open' : 'select'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() }, body: JSON.stringify({ path: manualPath }),
      });
      const result = await response.json() as { error?: string; cancelled?: boolean };
      if (!response.ok) throw new Error(result.error || '无法打开本地文件夹。');
      if (!result.cancelled) window.location.reload();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开本地文件夹。'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  if (!local) return null;
  return <div className="local-folder-picker">
    <button className="open-local-folder" disabled={disabled || busy} onClick={() => void choose()}
      aria-label={busy ? '正在选择文件夹' : '打开本地文件夹'}
      title={busy ? '正在选择文件夹…' : `打开本地文件夹${path ? `\n当前：${path}` : ''}`}>
      <FolderOpen size={15} />
    </button>
    {error && <div className="local-folder-error-panel">
      <button className="local-folder-error-close" aria-label="关闭提示" onClick={() => setError('')}><X size={14} /></button>
      <p className="editor-error" role="alert">{error}</p>
      <form onSubmit={(event) => { event.preventDefault(); void choose(true); }}>
        <input aria-label="电脑上的文件夹完整路径" value={manualPath} placeholder={path || '文件夹的完整路径'} onChange={(event) => setManualPath(event.target.value)} disabled={disabled || busy} />
        <button disabled={disabled || busy || !manualPath.trim()}>打开</button>
      </form>
    </div>}
  </div>;
}
