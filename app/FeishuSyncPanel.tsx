'use client';

import { workspaceHeaders } from './local-workspace';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, X } from 'lucide-react';

type Result = { status: string; path?: string; message: string; url?: string };
type PullCandidate = { nodeToken: string; title: string; path: string; url: string };
type SyncStatus = {
  configured: boolean; appId: string; wikiUrl: string; environmentManaged: boolean; busy: boolean; error?: string;
  entry?: { url?: string; syncedAt?: string; warnings?: string[]; pending?: string };
  recovery?: { canRestoreOriginal: boolean; originalUrl: string };
  job?: { id: string; action?: string; state: string; progress: string; completed?: number; total?: number; results: Result[]; candidates?: PullCandidate[] };
};
const subscribeLocation = () => () => {};

async function request<T = SyncStatus>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`/local-api/feishu/${endpoint}`, {
    cache: 'no-store', headers: workspaceHeaders(), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() }, body: JSON.stringify(body) }),
  });
  let data: { error?: string };
  try { data = await response.json() as { error?: string }; } catch { throw new Error('本地飞书服务没有响应，请重启知识库启动程序。'); }
  if (!response.ok) throw new Error(data.error || '飞书操作失败。');
  return data as T;
}

export default function FeishuSyncPanel({ notePath, folders, notePaths, selectedFolder, dirty, onBusyChange }: {
  notePath?: string; folders: string[]; notePaths: string[]; selectedFolder: string; dirty: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const local = useSyncExternalStore(subscribeLocation, () => ['localhost', '127.0.0.1'].includes(window.location.hostname), () => false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [appId, setAppId] = useState('');
  const [wikiUrl, setWikiUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [selectedPushFolders, setSelectedPushFolders] = useState<string[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  function close() { setOpened(false); trigger.current?.focus(); }

  useEffect(() => {
    if (!local || !opened) return;
    let active = true, first = true;
    async function refresh() {
      try {
        const data = await request(`status?${new URLSearchParams(notePath ? { path: notePath } : {})}`) as SyncStatus;
        if (!active) return;
        setStatus(data);
        onBusyChange(data.busy);
        if (first) { setAppId(data.appId); setWikiUrl(data.wikiUrl); first = false; }
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : '无法连接飞书服务。'); }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [local, opened, notePath, onBusyChange]);

  async function saveConfig() {
    setPending(true); setError(''); setNotice('');
    try {
      await request('config', { appId, wikiUrl, appSecret: secret });
      setSecret(''); setNotice('配置已保存到本机。点击测试连接以核实访问权限。');
      setStatus(await request(`status?${new URLSearchParams(notePath ? { path: notePath } : {})}`));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '配置保存失败。'); }
    finally { setPending(false); }
  }
  async function start(action: string, copy = false, nodeTokens?: string[], pushFolders?: string[]) {
    const overwrite = !copy && (action === 'push' || action === 'push-folders');
    if (overwrite) {
      const scope = action === 'push-folders'
        ? `所选文件夹（含子目录）：\n${pushFolders?.map((folder) => folder || '整个知识库').join('\n')}`
        : `当前笔记：${notePath}`;
      const confirmed = window.confirm(`确认覆盖飞书原文？\n\n${scope}\n\n已关联笔记将用本地已保存内容更新飞书原文；新笔记会创建新文档，并按本地目录创建或复用父文档；已有页面会移到对应位置。移动父文档会携带其子页面。\n\n如果原文含同步引用块，覆盖后会转为普通文字和图片，不再跟随源文档更新。源文档本身不会被修改或删除。\n\n推送前会保留本地及飞书原文备份。点击“取消”不会推送。`);
      if (!confirmed) return;
    }
    setPending(true); setError(''); setNotice('');
    if (action === 'discover') setSelectedTokens([]);
    try {
      const result = await request<{ job: SyncStatus['job'] }>('jobs', { action, path: notePath, copy, nodeTokens, folders: pushFolders, overwriteSyncedBlocks: overwrite });
      setStatus((current) => current ? { ...current, busy: true, job: result.job } : current);
      onBusyChange(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '同步启动失败。'); }
    finally { setPending(false); }
  }
  if (!local) return null;
  const busy = pending || status?.busy;
  const blocked = busy || !status?.configured || Boolean(status?.error);
  const candidates = status?.job?.action === 'discover' ? status.job.candidates : undefined;
  const selection = candidates?.filter((item) => selectedTokens.includes(item.nodeToken)).map((item) => item.nodeToken) || [];
  const availableFolders = ['', ...folders.filter((folder) => !folder.split('/').some((part) => part.startsWith('.') || part === 'node_modules' || part.endsWith('.assets')))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const pushSelection = selectedPushFolders.filter((folder) => availableFolders.includes(folder));
  const noteCount = (selected: string[]) => notePaths.filter((file) => !file.split('/').some((part) => part.startsWith('.') || part === 'node_modules' || part.endsWith('.assets')) && selected.some((folder) => !folder || file.startsWith(folder + '/'))).length;
  return <div className="feishu-sync">
    <button ref={trigger} className="feishu-trigger" onClick={() => setOpened(true)}><Cloud size={17} />飞书同步</button>
    {opened && createPortal(<div className="feishu-backdrop" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) close(); }}>
      <section className="feishu-panel" role="dialog" aria-modal="true" aria-labelledby="feishu-heading" ref={(node) => {
        if (node && !node.contains(document.activeElement)) node.focus();
      }} tabIndex={-1} onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const elements = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]');
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header><h2 id="feishu-heading">飞书同步</h2><button aria-label="关闭飞书同步" disabled={busy} onClick={close}><X size={20} /></button></header>
        <p>点击按钮时同步。范围为指定页面及其子页面。</p>
        <details open={!status?.configured}>
          <summary>连接配置{status?.configured ? ' · 已配置' : ''}</summary>
          <label>App ID<input value={appId} onChange={(event) => setAppId(event.target.value)} disabled={busy || status?.environmentManaged} /></label>
          <label>App Secret<input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={busy || status?.environmentManaged} placeholder={status?.configured ? '已保存；留空保留原密钥' : '填写应用的 App Secret'} /></label>
          <label>飞书知识库页面<input type="url" value={wikiUrl} onChange={(event) => setWikiUrl(event.target.value)} disabled={busy || status?.environmentManaged} /></label>
          <p>密钥只保存在本机，不会写入笔记。{status?.environmentManaged && '当前由 .env.local 或环境变量管理。'}</p>
          <button onClick={() => void saveConfig()} disabled={busy || status?.environmentManaged}>保存配置</button>
          <p>应用需开通 wiki:wiki、docx:document、docx:document.block:convert，并获得目标知识库的阅读、编辑权限。</p>
        </details>
        <div className="feishu-buttons">
          <button disabled={blocked} onClick={() => void start('connect')}>测试连接</button>
          <button disabled={blocked} onClick={() => void start('discover')}>选择笔记拉取</button>
          <button disabled={blocked || dirty} onClick={() => void start('import')}>从飞书导入</button>
        </div>
        {!busy && candidates && <div className="feishu-note">
          <h3>尚未拉取的笔记 · {candidates.length} 篇</h3>
          {candidates.length ? <>
            <p>勾选要拉取的笔记，按知识库目录保存到本地。未勾选的父页面只创建目录。</p>
            <label className="feishu-selection">
              <input type="checkbox" checked={selection.length === candidates.length} disabled={blocked}
                onChange={(event) => setSelectedTokens(event.target.checked ? candidates.map((item) => item.nodeToken) : [])} />
              <span>全选 · 已选 {selection.length} 篇</span>
            </label>
            <div className="feishu-candidates" role="group" aria-label="待拉取笔记">
              {candidates.map((item) => <div key={item.nodeToken} className="feishu-candidate"><label className="feishu-selection">
                <input type="checkbox" checked={selection.includes(item.nodeToken)} disabled={blocked}
                  onChange={(event) => setSelectedTokens((current) => event.target.checked ? [...current, item.nodeToken] : current.filter((token) => token !== item.nodeToken))} />
                <span><strong>{item.title}</strong><small>{item.path}</small></span>
              </label><a href={item.url} target="_blank" rel="noreferrer" aria-label={`查看飞书原文：${item.path}`}>查看原文</a></div>)}
            </div>
            {dirty && <p className="feishu-error">请等待当前笔记保存完成后拉取。</p>}
          </> : <p>当前知识库下可拉取的笔记均已关联到本地。</p>}
          <div className="feishu-buttons">
            {candidates.length > 0 && <button disabled={blocked || dirty || !selection.length} onClick={() => void start('import-selected', false, selection)}>拉取所选（{selection.length}）</button>}
            <button disabled={blocked} onClick={() => void start('discover')}>刷新列表</button>
          </div>
        </div>}
        <div className="feishu-note">
          <h3>当前笔记</h3><p>{notePath || '尚未选择笔记'}</p>
          {status?.entry?.url && <a href={status.entry.url} target="_blank" rel="noreferrer">在飞书打开</a>}
          {status?.entry?.syncedAt && <p>上次同步：{new Date(status.entry.syncedAt).toLocaleString('zh-CN')}</p>}
          {dirty && <p className="feishu-error">请等待笔记保存完成后同步。</p>}
          {!busy && status?.entry?.pending && <>
            <p className="feishu-error">上次同步中断，已停止重复写入。备份：{status.entry.pending}</p>
            {status.recovery?.canRestoreOriginal ? <>
              <p>这次中断发生在另存为过程中。你可以取消本次另存为，重新关联到 <a href={status.recovery.originalUrl} target="_blank" rel="noreferrer">原飞书文档</a>。</p>
              <button disabled={blocked} onClick={() => void start('recover-original')}>取消另存为，恢复原文档关联</button>
              <p>保留本地内容和备份，不覆盖飞书原文。若已经生成新副本，也会保留。</p>
            </> : <>
              <button disabled={blocked} onClick={() => void start('recover')}>检查并恢复操作</button>
              <p>核对飞书原文未发生变化后解除保护，保留本地修改和备份。</p>
            </>}
          </>}
          <div className="feishu-buttons">
            <button disabled={blocked || dirty || !notePath || Boolean(status?.entry?.pending)} onClick={() => void start('push')}>推送当前笔记</button>
            <button disabled={blocked || dirty || !status?.entry || Boolean(status?.entry?.pending)} onClick={() => void start('pull')}>拉取当前笔记</button>
            <button disabled={blocked || dirty || !notePath || Boolean(status?.entry?.pending)} onClick={() => void start('push', true)}>另存为飞书新文档</button>
          </div>
        </div>
        <div className="feishu-note">
          <h3>推送文件夹</h3>
          <p>包含子文件夹中的 Markdown 笔记。已关联的笔记更新原文；本地文件夹对应飞书父文档，笔记挂在对应父文档下；已有页面也会按本地目录调整位置。重叠目录只推送一次。</p>
          <p>当前文件夹：{selectedFolder || '整个知识库'} · {noteCount([selectedFolder])} 篇</p>
          <button disabled={blocked || dirty || !availableFolders.includes(selectedFolder)} onClick={() => void start('push-folders', false, undefined, [selectedFolder])}>
            {selectedFolder ? '推送整个当前文件夹' : '推送整个知识库'}
          </button>
          <details>
            <summary>选择文件夹推送</summary>
            <div className="feishu-candidates" role="group" aria-label="待推送文件夹">
              {availableFolders.map((folder) => <label key={folder} className="feishu-selection">
                <input type="checkbox" checked={pushSelection.includes(folder)} disabled={blocked || dirty}
                  onChange={(event) => setSelectedPushFolders((current) => event.target.checked ? [...current, folder] : current.filter((item) => item !== folder))} />
                <span><strong>{folder || '整个知识库'}</strong><small>{noteCount([folder])} 篇，包含子目录；空文件夹也会创建父文档</small></span>
              </label>)}
            </div>
            <button disabled={blocked || dirty || !pushSelection.length} onClick={() => void start('push-folders', false, undefined, pushSelection)}>推送所选文件夹（{noteCount(pushSelection)} 篇）</button>
          </details>
          {dirty && <p className="feishu-error">请等待笔记保存完成后推送文件夹。</p>}
          <p>冲突或失败会逐篇列出，其余笔记继续推送；再次推送会跳过已同步内容。</p>
        </div>
        <p>支持文字、列表、代码、普通表格及图片。拉取会保存图片并展开同步块正文；推送时自动转换 HTML 图片，保留本地图片尺寸和对齐设置。支持本地 PNG、JPEG、GIF、WebP、BMP 图片（单张不超过 20 MB）。覆盖前会弹出提醒：同步引用块将转为普通内容，不再随源文档更新，源文档本身不受影响。</p>
        <div aria-live="polite">
          {(error || status?.error) && <p className="feishu-error">{error || status?.error}</p>}
          {notice && <p>{notice}</p>}
          {status?.busy && <p>{status.job?.total !== undefined && `已处理 ${status.job.completed || 0}/${status.job.total} 篇 · `}{status.job?.progress || '正在同步…'}</p>}
          {status?.job && !status.busy && <div className="feishu-results">
            <strong>{['error', 'attention'].includes(status.job.state) ? '同步需要处理' : '操作完成'}</strong>
            {status.job.results.map((result, index) => <p key={index} className={['error', 'conflict'].includes(result.status) ? 'feishu-error' : ''}>{result.path && <span>{result.path}<br /></span>}{result.message}{result.url && <> <a href={result.url} target="_blank" rel="noreferrer">打开飞书</a></>}</p>)}
          </div>}
        </div>
      </section>
    </div>, document.body)}
  </div>;
}
