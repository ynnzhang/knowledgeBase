'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { parse as parseYaml } from 'yaml';
import MarkdownRichEditor from './MarkdownRichEditor';
import { resolveNoteImageUrl } from './note-images';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Check,
  Eye,
  Info,
  Maximize2,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Tag,
  X,
} from 'lucide-react';

type NoteStatus = 'expired' | 'stale' | 'soon' | 'fresh';
type ReaderMode = 'view' | 'edit';

type RawNote = {
  id: string;
  name: string;
  path: string;
  raw: string;
  modified: Date;
  source: 'local';
};

type Note = RawNote & {
  title: string;
  body: string;
  excerpt: string;
  tags: string[];
  folder: string;
  updated: Date;
  reviewed?: Date;
  expires?: Date;
  baseline: Date;
  ageDays: number;
  reviewInterval: number;
  daysUntilDue: number;
  status: NoteStatus;
  wordCount: number;
};

type FolderNode = {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  notes: Note[];
};

type NotesIndexPayload = {
  generatedAt?: string;
  error?: string | null;
  folders?: string[];
  notes?: Array<Omit<RawNote, 'modified'> & { modified: string }>;
};

const DAY = 86_400_000;
const READER_WIDTH_STORAGE_KEY = 'zhixu.reader-width';
const READER_WIDTH_EVENT = 'zhixu-reader-width-change';
const STATUS_META: Record<NoteStatus, string> = {
  expired: '已过期',
  stale: '需复查',
  soon: '即将到期',
  fresh: '状态良好',
};

function readReaderWidth() {
  const savedWidth = Number(window.localStorage.getItem(READER_WIDTH_STORAGE_KEY));
  return Number.isFinite(savedWidth) && savedWidth >= 480 && savedWidth <= 1600 ? savedWidth : 780;
}

function subscribeReaderWidth(callback: () => void) {
  window.addEventListener('storage', callback);
  window.addEventListener(READER_WIDTH_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(READER_WIDTH_EVENT, callback);
  };
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseFrontmatter(raw: string) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { attributes: {}, body: raw };

  try {
    return {
      attributes: safeRecord(parseYaml(match[1])),
      body: raw.slice(match[0].length),
    };
  } catch {
    return { attributes: {}, body: raw };
  }
}

function firstValue(attributes: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (attributes[key] !== undefined && attributes[key] !== null) return attributes[key];
  }
  return undefined;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(/[,，]/)
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNote(rawNote: RawNote, defaultInterval: number): Note {
  const { attributes, body } = parseFrontmatter(rawNote.raw);
  const titleFromHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const titleFromMeta = firstValue(attributes, ['title', 'name']);
  const title =
    (typeof titleFromMeta === 'string' && titleFromMeta.trim()) ||
    titleFromHeading ||
    rawNote.name.replace(/\.md(?:own)?$/i, '');
  const reviewed = toDate(firstValue(attributes, ['reviewed', 'last_reviewed', 'lastReviewed']));
  const updated =
    toDate(firstValue(attributes, ['updated', 'last_updated', 'modified', 'date'])) ||
    rawNote.modified;
  const expires = toDate(firstValue(attributes, ['expires', 'expiry', 'valid_until', 'validUntil']));
  const intervalValue = Number(
    firstValue(attributes, ['review_interval_days', 'review_interval', 'freshness_days', 'ttl_days']),
  );
  const reviewInterval =
    Number.isFinite(intervalValue) && intervalValue > 0 ? Math.round(intervalValue) : defaultInterval;
  const baseline = reviewed || updated;
  const now = new Date();
  const ageDays = Math.max(0, Math.floor((now.getTime() - baseline.getTime()) / DAY));
  const expiryDistance = expires ? Math.ceil((expires.getTime() - now.getTime()) / DAY) : undefined;
  const daysUntilDue = expiryDistance ?? reviewInterval - ageDays;
  let status: NoteStatus = 'fresh';
  if (expiryDistance !== undefined && expiryDistance < 0) status = 'expired';
  else if (ageDays > reviewInterval) status = 'stale';
  else if (daysUntilDue <= 14 || ageDays >= reviewInterval * 0.8) status = 'soon';

  const plain = stripMarkdown(body);
  const folderParts = rawNote.path.split('/');
  const folder = folderParts.length > 1 ? folderParts.slice(0, -1).join(' / ') : '根目录';

  return {
    ...rawNote,
    title,
    body,
    excerpt: plain.slice(0, 110) || '这篇笔记暂时没有可预览的正文。',
    tags: toTags(firstValue(attributes, ['tags', 'tag', 'keywords'])),
    folder,
    updated,
    reviewed,
    expires,
    baseline,
    ageDays,
    reviewInterval,
    daysUntilDue,
    status,
    wordCount: plain.replace(/\s/g, '').length,
  };
}

function formatDate(date?: Date) {
  return date
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
    : '未记录';
}

function MetadataInfo({ note }: { note: Note }) {
  return (
    <span className="metadata-info" tabIndex={0} aria-label={`查看 ${note.title} 的笔记信息`}>
      <Info size={14} aria-hidden="true" />
      <span className="metadata-tooltip" role="tooltip">
        <strong>笔记信息</strong>
        <span><em>状态</em><b>{STATUS_META[note.status]}</b></span>
        <span><em>标签</em><b>{note.tags.length ? note.tags.map((tag) => `#${tag}`).join(' · ') : '无标签'}</b></span>
        <span><em>最近核验</em><b>{formatDate(note.reviewed || note.updated)}</b></span>
        {note.expires && <span><em>有效期至</em><b>{formatDate(note.expires)}</b></span>}
        <span><em>复查周期</em><b>{note.reviewInterval} 天</b></span>
        <span><em>内容</em><b>约 {note.wordCount} 字</b></span>
      </span>
    </span>
  );
}

function TagEditor({
  note,
  allTags,
  onSave,
}: {
  note: Note;
  allTags: string[];
  onSave: (tags: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note.tags);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const suggestions = allTags.filter((tag) => !draft.includes(tag));

  function addTag(value: string) {
    const tag = value.trim().replace(/^#+/, '').slice(0, 32);
    if (!tag || draft.includes(tag) || draft.length >= 20) return;
    setDraft((current) => [...current, tag]);
    setInput('');
    setError('');
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '标签保存失败。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tag-editor">
      <button
        className={open ? 'tag-editor-trigger active' : 'tag-editor-trigger'}
        title="创建或管理标签"
        aria-label="创建或管理标签"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Tag size={17} />
        <Plus className="tag-plus" size={10} />
      </button>
      {open && (
        <div className="tag-editor-panel">
          <div className="tag-editor-head">
            <div><strong>管理标签</strong><small>保存后写入 Markdown 元数据，AI 可直接读取</small></div>
            <button onClick={() => setOpen(false)} aria-label="关闭标签编辑"><X size={15} /></button>
          </div>

          <div className="tag-drafts">
            {draft.length ? draft.map((tag) => (
              <span key={tag}>#{tag}<button onClick={() => setDraft((current) => current.filter((item) => item !== tag))} aria-label={`移除标签 ${tag}`}><X size={11} /></button></span>
            )) : <small>还没有标签，输入一个新标签开始分类。</small>}
          </div>

          <div className="tag-input-row">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(input); } }}
              placeholder="新标签，例如：前端、英语、算法"
              maxLength={32}
              autoFocus
            />
            <button onClick={() => addTag(input)} disabled={!input.trim()}><Plus size={15} />添加</button>
          </div>

          {suggestions.length > 0 && (
            <div className="tag-suggestions"><small>已有标签</small><div>{suggestions.slice(0, 12).map((tag) => <button key={tag} onClick={() => addTag(tag)}>#{tag}</button>)}</div></div>
          )}

          {error && <p className="tag-error">{error}</p>}
          <button className="tag-save" onClick={() => void save()} disabled={saving}>
            <Check size={15} />{saving ? '正在保存…' : '保存标签'}
          </button>
        </div>
      )}
    </div>
  );
}

function buildFolderTree(notes: Note[], folderPaths: string[]): FolderNode {
  const root: FolderNode = { name: '知识库', path: '', folders: new Map(), notes: [] };

  function ensureFolder(folderPath: string) {
    const parts = folderPath.split('/').filter(Boolean);
    let current = root;
    for (const folderName of parts) {
      const nextPath = current.path ? `${current.path}/${folderName}` : folderName;
      if (!current.folders.has(folderName)) {
        current.folders.set(folderName, { name: folderName, path: nextPath, folders: new Map(), notes: [] });
      }
      current = current.folders.get(folderName)!;
    }
    return current;
  }

  folderPaths.forEach(ensureFolder);

  for (const note of notes) {
    const parts = note.path.split('/').filter(Boolean);
    const current = ensureFolder(parts.slice(0, -1).join('/'));
    current.notes.push(note);
  }

  return root;
}

function FileTree({
  root,
  expanded,
  selectedId,
  onToggle,
  onSelect,
}: {
  root: FolderNode;
  expanded: Set<string>;
  selectedId?: string;
  onToggle: (path: string) => void;
  onSelect: (note: Note) => void;
}) {
  function countNotes(folder: FolderNode): number {
    return folder.notes.length + [...folder.folders.values()].reduce((sum, child) => sum + countNotes(child), 0);
  }

  function renderFolder(folder: FolderNode, depth: number) {
    const isOpen = expanded.has(folder.path);
    const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const files = [...folder.notes].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const itemCount = countNotes(folder);

    return (
      <div key={folder.path} className="tree-folder">
        <button className="folder-row" onClick={() => onToggle(folder.path)} style={{ paddingLeft: 10 + depth * 18 }}>
          <ChevronDown className={isOpen ? 'tree-chevron open' : 'tree-chevron'} size={14} />
          {isOpen ? <FolderOpen size={17} /> : <Folder size={17} />}
          <span>{folder.name}</span>
          <em>{itemCount}</em>
        </button>
        {isOpen && (
          <div>
            {folders.map((child) => renderFolder(child, depth + 1))}
            {files.map((note) => (
              <div key={note.id} className={selectedId === note.id ? 'file-row selected' : 'file-row'}>
                <button className="file-open" onClick={() => onSelect(note)} style={{ paddingLeft: 31 + depth * 18 }}>
                  <FileText size={16} />
                  <span title={note.name}>{note.name}</span>
                </button>
                <MetadataInfo note={note} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const rootFolders = [...root.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const rootFiles = [...root.notes].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return (
    <div className="file-tree" role="tree" aria-label="知识库文件夹和笔记">
      {rootFolders.map((folder) => renderFolder(folder, 0))}
      {rootFiles.map((note) => (
        <div key={note.id} className={selectedId === note.id ? 'file-row selected' : 'file-row'}>
          <button className="file-open" onClick={() => onSelect(note)}>
            <FileText size={16} /><span title={note.name}>{note.name}</span>
          </button>
          <MetadataInfo note={note} />
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [rawNotes, setRawNotes] = useState<RawNote[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [defaultInterval, setDefaultInterval] = useState(90);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('正在读取本地知识库…');
  const [readerMode, setReaderMode] = useState<ReaderMode>('view');
  const readerWidth = useSyncExternalStore(subscribeReaderWidth, readReaderWidth, () => 780);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const lastSyncRef = useRef('');

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadLocalIndex() {
      try {
        const response = await fetch(`/notes-index.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as NotesIndexPayload;
        if (!active || !payload.generatedAt || payload.generatedAt === lastSyncRef.current) return;
        lastSyncRef.current = payload.generatedAt;

        if (payload.error) {
          setMessage(payload.error);
          return;
        }

        const nextFolders = payload.folders || [];
        const nextNotes: RawNote[] = (payload.notes || []).map((note) => ({
          ...note,
          modified: new Date(note.modified),
          source: 'local',
        }));
        setRawNotes(nextNotes);
        setFolderPaths(nextFolders);
        setSelectedId((current) => nextNotes.some((note) => note.id === current) ? current : nextNotes[0]?.id || '');
        setExpandedFolders((current) => {
          const available = new Set(nextFolders);
          const preserved = [...current].filter((folder) => available.has(folder));
          return new Set(preserved.length ? preserved : nextFolders.filter((folder) => !folder.includes('/')));
        });
        setMessage(`知识库已更新：${nextFolders.length} 个文件夹、${nextNotes.length} 篇 Markdown 笔记。`);
      } catch {
        // 开发服务器首次启动时索引可能尚未生成，下一轮会自动重试。
      }
    }

    void loadLocalIndex();
    const timer = window.setInterval(() => void loadLocalIndex(), 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const notes = useMemo(
    () => rawNotes.map((note) => parseNote(note, defaultInterval)),
    [rawNotes, defaultInterval],
  );

  const allTags = useMemo(
    () => [...new Set(notes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [notes],
  );

  const counts = useMemo(
    () => ({
      attention: notes.filter((note) => note.status === 'expired' || note.status === 'stale').length,
      soon: notes.filter((note) => note.status === 'soon').length,
    }),
    [notes],
  );

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return notes
      .filter((note) => {
        const haystack = `${note.title} ${note.path} ${note.tags.join(' ')} ${note.body}`.toLocaleLowerCase('zh-CN');
        return !normalizedQuery || haystack.includes(normalizedQuery);
      });
  }, [notes, query]);

  const folderTree = useMemo(() => buildFolderTree(filteredNotes, folderPaths), [filteredNotes, folderPaths]);

  const selectedNote =
    filteredNotes.find((note) => note.id === selectedId) ||
    filteredNotes[0] ||
    notes.find((note) => note.id === selectedId);
  const editorBody = selectedNote
    ? (editorDrafts[selectedNote.id] ?? selectedNote.body)
    : '';
  const editorDirty = Boolean(selectedNote && editorBody !== selectedNote.body);
  const oldestAttention = notes
    .filter((note) => note.status === 'expired' || note.status === 'stale')
    .sort((a, b) => b.ageDays - a.ageDays)[0];

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function updateReaderWidth(nextWidth: number) {
    const clampedWidth = Math.min(1600, Math.max(480, Math.round(nextWidth)));
    window.localStorage.setItem(READER_WIDTH_STORAGE_KEY, String(clampedWidth));
    window.dispatchEvent(new Event(READER_WIDTH_EVENT));
  }

  async function saveNoteTags(note: Note, tags: string[]) {
    const response = await fetch('/local-api/notes/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: note.path, tags }),
    });
    const result = (await response.json()) as { error?: string; raw?: string; modified?: string; tags?: string[] };
    if (!response.ok || !result.raw || !result.modified) {
      throw new Error(result.error || '本地标签服务没有响应，请重新启动知识库网站。');
    }

    setRawNotes((current) => current.map((rawNote) => rawNote.id === note.id
      ? { ...rawNote, raw: result.raw!, modified: new Date(result.modified!) }
      : rawNote));
    setMessage(`已保存 ${result.tags?.length || 0} 个标签到「${note.title}」。`);
  }

  async function saveNoteContent(note: Note, body: string) {
    if (savingNote) return;
    setSavingNote(true);
    setEditorError('');
    try {
      const response = await fetch('/local-api/notes/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: note.path, body }),
      });
      const result = (await response.json()) as { error?: string; raw?: string; modified?: string };
      if (!response.ok || !result.raw || !result.modified) {
        throw new Error(result.error || '本地编辑服务没有响应，请重新启动知识库网站。');
      }

      setRawNotes((current) => current.map((rawNote) => rawNote.id === note.id
        ? { ...rawNote, raw: result.raw!, modified: new Date(result.modified!) }
        : rawNote));
      setEditorDrafts((current) => {
        const next = { ...current };
        delete next[note.id];
        return next;
      });
      setMessage(`已保存「${note.title}」。`);
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : '笔记保存失败。');
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-mark" aria-hidden="true"><BookOpen size={20} strokeWidth={2.2} /></div>
          <div><div className="brand-name">知序</div><div className="brand-subtitle">高效学习 · 快速整理</div></div>
        </div>

        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或标签…" aria-label="搜索笔记" />
          <kbd>Ctrl K</kbd>
        </label>

        <div className="top-actions">
          <div className="privacy-pill" title="笔记数据只在本机处理"><ShieldCheck size={15} /><span>仅本地处理</span></div>
          <button className="top-refresh-button" title="重新读取本地笔记" aria-label="重新读取本地笔记" onClick={() => window.location.reload()}>
            <RefreshCcw size={17} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <main className="main-content">
          <section className="collection-panel">
            <div className="collection-head">
              <div>
                <div className="breadcrumb"><span>知识库</span><ChevronRight size={13} /><span>文件</span></div>
                <h1>我的笔记</h1>
                <p>{filteredNotes.length} 个 Markdown 文件</p>
              </div>
              <details className="review-settings">
                <summary title="时效提醒设置" aria-label="时效提醒设置"><Settings2 size={15} /></summary>
                <div className="review-settings-panel">
                  <strong>时效提醒</strong>
                  <label>默认复查周期
                    <select value={defaultInterval} onChange={(event) => setDefaultInterval(Number(event.target.value))} aria-label="默认复查周期">
                      <option value={30}>30 天</option><option value={60}>60 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option>
                    </select>
                  </label>
                  <p>只用于没有单独设置复查周期的笔记。</p>
                </div>
              </details>
            </div>

            {(counts.attention > 0 || counts.soon > 0) && (
              <div className="review-alert">
                <CalendarClock size={15} />
                <span>
                  <strong>复查提醒</strong>
                  <small>{counts.attention > 0 ? `${counts.attention} 篇需要复查` : ''}{counts.attention > 0 && counts.soon > 0 ? ' · ' : ''}{counts.soon > 0 ? `${counts.soon} 篇即将到期` : ''}{counts.attention > 0 ? ` · 最旧 ${oldestAttention?.ageDays || 0} 天` : ''}</small>
                </span>
              </div>
            )}

            <div className="list-heading"><span>名称</span><small>信息</small></div>

            <div className="note-list">
              <FileTree
                root={folderTree}
                expanded={expandedFolders}
                selectedId={selectedNote?.id}
                onToggle={toggleFolder}
                onSelect={(note) => { setSelectedId(note.id); setMobileReaderOpen(true); }}
              />
              {!filteredNotes.length && (
                <div className="empty-state">
                  {notes.length ? <Search size={24} /> : <FolderOpen size={24} />}
                  <strong>{notes.length ? '没有匹配的笔记' : '知识库中没有 Markdown 笔记'}</strong>
                  <span>{notes.length ? '换个关键词或清除筛选条件试试。' : '请直接在本地目录中创建 .md 文件，页面会自动更新。'}</span>
                  {notes.length > 0 && <button onClick={() => setQuery('')}>清除筛选</button>}
                </div>
              )}
            </div>
          </section>

          <section
            className={`reader-panel ${mobileReaderOpen ? 'mobile-reader-open' : ''}`}
            style={{ '--reader-page-width': `${readerWidth}px` } as CSSProperties}
          >
            {selectedNote ? (
              <>
                <header className="reader-head">
                  <button className="mobile-reader-back" onClick={() => setMobileReaderOpen(false)} aria-label="返回笔记列表"><X size={18} />返回列表</button>
                  <div className="reader-path">{selectedNote.path.split('/').map((part, index, parts) => <span key={`${part}-${index}`}>{part}{index < parts.length - 1 && <ChevronRight size={12} />}</span>)}</div>
                  <div className="reader-title-row">
                    <div><h2>{selectedNote.title}</h2></div>
                    <div className="reader-actions">
                      {readerMode === 'edit' && (
                        <button
                          className="reader-save-action"
                          title={editorDirty ? '保存笔记（Ctrl+S）' : '笔记已保存'}
                          onClick={() => void saveNoteContent(selectedNote, editorBody)}
                          disabled={!editorDirty || savingNote}
                          aria-label={savingNote ? '正在保存笔记' : '保存笔记'}
                        >
                          <Save size={17} />
                        </button>
                      )}
                      <TagEditor key={selectedNote.id} note={selectedNote} allTags={allTags} onSave={(tags) => saveNoteTags(selectedNote, tags)} />
                      <MetadataInfo note={selectedNote} />
                      <button title="重新读取笔记" onClick={() => window.location.reload()} aria-label="重新读取知识库"><RefreshCcw size={17} /></button>
                    </div>
                  </div>
                  <div className="reader-workspace-controls">
                    <div className="mode-switch" aria-label="笔记模式">
                      <button className={readerMode === 'view' ? 'active' : ''} onClick={() => setReaderMode('view')}><Eye size={14} />查看</button>
                      <button
                        className={readerMode === 'edit' ? 'active' : ''}
                        title="快捷输入：# 标题、- 无序列表、1. 有序列表、> 引用，输入后按空格"
                        onClick={() => setReaderMode('edit')}
                      ><Pencil size={14} />编辑{editorDirty && <i aria-label="有未保存修改" />}</button>
                    </div>
                    <div className="reader-width-control" title="拖动或输入数字调整笔记页宽">
                      <Maximize2 size={14} />
                      <input
                        className="width-slider"
                        type="range"
                        min={480}
                        max={1600}
                        step={1}
                        value={readerWidth}
                        onChange={(event) => updateReaderWidth(Number(event.target.value))}
                        aria-label="拖动调整笔记页宽"
                      />
                      <label className="width-number">
                        <input
                          type="number"
                          min={480}
                          max={1600}
                          value={readerWidth}
                          onChange={(event) => {
                            const nextWidth = Number(event.target.value);
                            if (Number.isFinite(nextWidth)) updateReaderWidth(nextWidth);
                          }}
                          aria-label="输入笔记页宽像素"
                        />
                        <span>px</span>
                      </label>
                    </div>
                  </div>
                </header>

                {readerMode === 'view' && (selectedNote.status === 'expired' || selectedNote.status === 'stale') && (
                  <div className={`stale-callout ${selectedNote.status === 'expired' ? 'expired-callout' : ''}`}>
                    <AlertTriangle size={19} />
                    <div>
                      <strong>{selectedNote.status === 'expired' ? '这篇笔记的有效期已经结束' : '这篇笔记可能已经陈旧'}</strong>
                      <p>{selectedNote.status === 'expired' ? `设定的有效期已过去 ${Math.abs(selectedNote.daysUntilDue)} 天。继续使用前，请重新核对来源。` : `距离上次可靠更新已有 ${selectedNote.ageDays} 天，超过了 ${selectedNote.reviewInterval} 天的复查周期。`}</p>
                    </div>
                  </div>
                )}

                {readerMode === 'view' && selectedNote.status === 'soon' && (
                  <div className="stale-callout soon-callout"><CalendarClock size={19} /><div><strong>即将进入复查周期</strong><p>建议在未来 {Math.max(0, selectedNote.daysUntilDue)} 天内重新确认这篇笔记。</p></div></div>
                )}

                {readerMode === 'view' ? (
                  <article className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw]}
                      urlTransform={(url, key) => key === 'src'
                        ? resolveNoteImageUrl(selectedNote.path, url)
                        : defaultUrlTransform(url)}
                      components={{
                        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
                        img: ({ src, alt, ...props }) => <img {...props} src={src} alt={alt || ''} loading="lazy" />,
                        input: (props) => <input {...props} disabled={props.type === 'checkbox'} />,
                      }}
                    >
                      {editorBody}
                    </ReactMarkdown>
                  </article>
                ) : (
                  <section
                    className="markdown-editor"
                    aria-label={`编辑 ${selectedNote.title}`}
                    onKeyDownCapture={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                        event.preventDefault();
                        void saveNoteContent(selectedNote, editorBody);
                      }
                    }}
                  >
                    <MarkdownRichEditor
                      key={selectedNote.id}
                      markdown={editorBody}
                      notePath={selectedNote.path}
                      onChange={(nextMarkdown) => {
                        setEditorDrafts((current) => ({ ...current, [selectedNote.id]: nextMarkdown }));
                        setEditorError('');
                      }}
                    />
                    {editorError && <p className="editor-error">{editorError}</p>}
                  </section>
                )}

              </>
            ) : (
              <div className="reader-empty"><BookOpen size={28} /><strong>{notes.length ? '选择左侧文件开始阅读' : '知识库中暂无可阅读的 Markdown 文件'}</strong></div>
            )}
          </section>
        </main>
      </div>

      <div className="toast" role="status" aria-live="polite"><ShieldCheck size={15} /><span>{message}</span></div>
    </div>
  );
}
