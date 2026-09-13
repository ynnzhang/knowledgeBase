'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent } from 'react';
import { parse as parseYaml } from 'yaml';
import MarkdownRichEditor from './MarkdownRichEditor';
import { treeWindow } from './tree-window.mjs';
import NoteOutline from './NoteOutline';
import FeishuSyncPanel from './FeishuSyncPanel';
import TagManager from './TagManager';
import FileRename, { type RenameTarget } from './FileRename';
import ReaderWidthControl from './ReaderWidthControl';
import FileActions, { type FileResult } from './FileActions';
import LocalFolderPicker from './LocalFolderPicker';
import { setLocalWorkspace, workspaceHeaders } from './local-workspace';
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
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  Search,
  Settings2,
  X,
} from 'lucide-react';

type NoteStatus = 'expired' | 'stale' | 'soon' | 'fresh';
type DraggedItem = { path: string; kind: 'note' | 'folder' };

// The platform does not change during a browser session.
function subscribePlatform() {
  return () => {};
}

type RawNote = {
  id: string;
  name: string;
  path: string;
  raw: string;
  version?: string;
  bodyLoaded?: boolean;
  summaryRaw?: string;
  wordCount?: number;
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
  workspace?: string;
  generatedAt?: string;
  epoch?: string;
  revision?: number;
  full?: boolean;
  removed?: string[];
  engine?: string;
  error?: string | null;
  folders?: string[];
  notes?: Array<Omit<RawNote, 'modified'> & { modified: string }>;
};

type NoteOverridePayload = {
  overrides?: Array<{ path: string; raw: string; updated_at: string }>;
};

const parsedNoteCache = new WeakMap<RawNote, { interval: number; note: Note }>();
const DAY = 86_400_000;
const READER_WIDTH_STORAGE_KEY = 'zhixu.reader-width';
const READER_WIDTH_EVENT = 'zhixu-reader-width-change';
const SIDEBAR_EVENT = 'zhixu-sidebar-change';
const SIDEBAR_KEY = 'zhixu.sidebar-collapsed';
function subscribeSidebar(callback: () => void) {
  window.addEventListener('storage', callback); window.addEventListener(SIDEBAR_EVENT, callback);
  return () => { window.removeEventListener('storage', callback); window.removeEventListener(SIDEBAR_EVENT, callback); };
}
function subscribeMobile(callback: () => void) {
  const media = window.matchMedia('(max-width: 720px)'); media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

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

function replaceNoteBody(raw: string, body: string) {
  const frontmatter = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/)?.[0] || '';
  return `${frontmatter}${body}`;
}

function isLocalWorkspace() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
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

  const plain = rawNote.bodyLoaded === false ? '' : stripMarkdown(body);
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
    wordCount: rawNote.wordCount ?? plain.replace(/\s/g, '').length,
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
  selectedFolder,
  onToggle,
  onSelect,
  disabled,
  onMove,
  onRename,
  onDelete,
  dragged,
  setDragged,
}: {
  root: FolderNode;
  expanded: Set<string>;
  selectedId?: string;
  selectedFolder: string;
  onToggle: (path: string) => void;
  onSelect: (note: Note) => void;
  disabled: boolean;
  onMove: (source: string, kind: 'note' | 'folder', folder: string) => void;
  onRename: (source: string, kind: 'note' | 'folder', name: string) => Promise<void>;
  onDelete: (source: string) => Promise<void>;
  dragged: DraggedItem | null;
  setDragged: (item: DraggedItem | null) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  function renameHandlers(path: string, kind: 'note' | 'folder') {
    return {
      onContextMenu(event: React.MouseEvent) {
        if (disabled || !isLocalWorkspace()) return;
        event.preventDefault(); event.stopPropagation();
        setRenameTarget({ path, kind, x: event.clientX, y: event.clientY });
      },
      onKeyDown(event: React.KeyboardEvent) {
        if (event.key !== 'F2' || disabled || !isLocalWorkspace()) return;
        event.preventDefault();
        setRenameTarget({ path, kind, x: 0, y: 0, editing: true });
      },
    };
  }
  function startDrag(event: DragEvent, path: string, kind: 'note' | 'folder') {
    if (disabled || !isLocalWorkspace()) { event.preventDefault(); return; }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-zhixu-file', JSON.stringify({ path, kind }));
    setDragged({ path, kind });
  }
  function validTarget(folder: string) {
    return !disabled && dragged && folder !== dragged.path.split('/').slice(0, -1).join('/')
      && !(dragged.kind === 'folder' && (folder === dragged.path || folder.startsWith(`${dragged.path}/`)));
  }
  function dropHandlers(folder: string) {
    return {
      onDragOver(event: DragEvent) {
        event.stopPropagation();
        if (!validTarget(folder)) { event.dataTransfer.dropEffect = 'none'; return; }
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(folder);
      },
      onDragLeave(event: DragEvent) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
      },
      onDrop(event: DragEvent) {
        event.preventDefault(); event.stopPropagation();
        if (validTarget(folder) && dragged) onMove(dragged.path, dragged.kind, folder);
        setDragged(null); setDropTarget(null);
      },
    };
  }
  function endDrag() { setDragged(null); setDropTarget(null); }

  const treeRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const rows = useMemo(() => {
    const result: Array<{ folder?: FolderNode; note?: Note; depth: number }> = [];
    function visit(folder: FolderNode, depth: number) {
      for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
        result.push({ folder: child, depth });
        if (expanded.has(child.path)) visit(child, depth + 1);
      }
      for (const note of [...folder.notes].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) result.push({ note, depth });
    }
    visit(root, 0); return result;
  }, [root, expanded]);
  useEffect(() => {
    const scroll = treeRef.current?.parentElement;
    if (!scroll) return;
    const update = () => setViewport({ top: scroll.scrollTop, height: scroll.clientHeight || 600 });
    scroll.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update); observer.observe(scroll); update();
    return () => { observer.disconnect(); scroll.removeEventListener('scroll', update); };
  }, []);
  const virtual = rows.length > 200;
  const window = treeWindow(rows.length, viewport.top, viewport.height);
  const start = virtual ? window.start : 0;
  const visible = virtual ? rows.slice(start, window.end) : rows;
  function navigateRows(event: React.KeyboardEvent) {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-row]');
    if (!button || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Number(button.dataset.treeRow);
    const next = Math.max(0, Math.min(rows.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1)));
    const scroll = treeRef.current?.parentElement;
    if (scroll && virtual) { if (next * 38 < scroll.scrollTop) scroll.scrollTo({ top: next * 38 }); else if ((next + 1) * 38 > scroll.scrollTop + scroll.clientHeight) scroll.scrollTo({ top: (next + 1) * 38 - scroll.clientHeight }); setViewport({ top: scroll.scrollTop, height: scroll.clientHeight }); }
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-tree-row="${next}"]`)?.focus({ preventScroll: virtual }));
  }
  return (
    <div ref={treeRef} className="file-tree" role="tree" aria-label="知识库文件夹和笔记" onKeyDown={navigateRows}>
      {renameTarget && <FileRename key={`${renameTarget.path}:${renameTarget.x}:${renameTarget.y}`} target={renameTarget} onClose={() => setRenameTarget(null)} onRename={onRename} onDelete={onDelete} />}
      <div style={virtual ? { height: window.total, position: 'relative' } : undefined}>
        <div style={virtual ? { position: 'absolute', top: window.offset, left: 0, right: 0 } : undefined}>
          {visible.map(({ folder, note, depth }, index) => folder ? (
            <button key={`folder-${folder.path}`} data-tree-row={start + index} role="treeitem" aria-level={depth + 1} aria-expanded={expanded.has(folder.path)} className={`folder-row ${selectedFolder === folder.path ? 'selected-folder' : ''} ${dropTarget === folder.path ? 'drop-target' : ''}`} draggable={!disabled} onDragStart={(event) => startDrag(event, folder.path, 'folder')} onDragEnd={endDrag} {...dropHandlers(folder.path)} {...renameHandlers(folder.path, 'folder')} title={`${folder.name} · 右键或 F2 重命名`} aria-selected={selectedFolder === folder.path} onClick={() => onToggle(folder.path)} style={{ paddingLeft: 10 + depth * 18, height: 38 }}>
              <ChevronDown className={expanded.has(folder.path) ? 'tree-chevron open' : 'tree-chevron'} size={14} />
              {expanded.has(folder.path) ? <FolderOpen size={17} /> : <Folder size={17} />}<span>{folder.name}</span>
            </button>
          ) : note ? (
            <div key={note.id} className={selectedId === note.id ? 'file-row selected' : 'file-row'} style={{ height: 38 }}>
              <button data-tree-row={start + index} role="treeitem" aria-level={depth + 1} aria-selected={selectedId === note.id} className="file-open" {...renameHandlers(note.path, 'note')} draggable={!disabled} onDragStart={(event) => startDrag(event, note.path, 'note')} onDragEnd={endDrag} onClick={() => onSelect(note)} style={{ paddingLeft: 13 + depth * 18 }}>
                <FileText size={16} /><span title={note.name}>{note.name}</span>
              </button>
            </div>
          ) : null)}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const shortcutModifier = useSyncExternalStore(
    subscribePlatform,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl',
    () => 'Ctrl',
  );
  const [rawNotes, setRawNotes] = useState<RawNote[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [defaultInterval, setDefaultInterval] = useState(90);
  const [query, setQuery] = useState('');
  const [nativeEngine, setNativeEngine] = useState(false);
  const [searchPaths, setSearchPaths] = useState<Set<string> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const versionsRef = useRef(new Map<string, string>());

  const [selectedId, setSelectedId] = useState('');
  const [sidebarView, setSidebarView] = useState<'files' | 'outline'>('files');
  const readerRef = useRef<HTMLElement>(null);
  const [indexError, setIndexError] = useState('');
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const readerWidth = useSyncExternalStore(subscribeReaderWidth, readReaderWidth, () => 780);
  const sidebarCollapsed = useSyncExternalStore(subscribeSidebar, () => window.localStorage.getItem(SIDEBAR_KEY) === 'true', () => false);
  const isMobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia('(max-width: 720px)').matches, () => false);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState(false);
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [fileError, setFileError] = useState('');
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const loadedWorkspaceRef = useRef('');
  const hasDraftsRef = useRef(false);
  const [editorError, setEditorError] = useState('');
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);
  const sidebarHidden = sidebarCollapsed || (isMobile && mobileReaderOpen);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const lastSyncRef = useRef('');
  const autoSaveTimerRef = useRef<number | null>(null);
  const pendingNoteSavesRef = useRef<Record<string, { note: Note; body: string }>>({});
  const saveLoopRunningRef = useRef(false);

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
    let inFlight = false;
    let etag = '';
    let epoch = '';
    let revision = 0;
    let controller: AbortController | null = null;

    async function loadLocalIndex() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10_000);
      try {
        const local = isLocalWorkspace();
        let response = await fetch(local ? `/local-api/index?${new URLSearchParams({ epoch, since: String(revision) })}` : '/notes-index.json', { cache: 'no-cache', signal: controller.signal, headers: local && etag ? { 'If-None-Match': etag } : {} });
        // Keep reading the last published index while the local API restarts.
        if (local && response.status !== 304 && !response.ok) response = await fetch('/notes-index.json', { cache: 'no-cache', signal: controller.signal });
        if (response.status === 304) return;
        if (!response.ok) return;
        if (local) etag = response.headers.get('ETag') || '';
        const payload = (await response.json()) as NotesIndexPayload;
        if (!active || !payload.generatedAt) return;
        if (payload.engine !== 'rust' && payload.generatedAt <= lastSyncRef.current) return;
        if (payload.engine === 'rust') { setNativeEngine(true); epoch = payload.epoch || ''; revision = payload.revision || 0; }
        if (payload.workspace && loadedWorkspaceRef.current && loadedWorkspaceRef.current !== payload.workspace) {
          if (hasDraftsRef.current) { setEditorError('另一个窗口已切换知识库，请先复制未保存的内容，再刷新页面。'); return; }
          window.location.reload(); return;
        }
        if (payload.workspace) { loadedWorkspaceRef.current = payload.workspace; setWorkspacePath(payload.workspace); setLocalWorkspace(payload.workspace); }
        const hadIndex = Boolean(lastSyncRef.current);
        lastSyncRef.current = payload.generatedAt;

        if (payload.error) {
          setIndexError(payload.error);
          if (hadIndex || !payload.notes?.length) return;
        }

        const nextFolders = payload.folders || [];
        let indexedNotes = payload.notes || [];
        if (!isLocalWorkspace()) {
          try {
            const overrideResponse = await fetch('/api/note-overrides', { cache: 'no-store' });
            if (overrideResponse.ok) {
              const overridePayload = await overrideResponse.json() as NoteOverridePayload;
              const overrides = new Map((overridePayload.overrides || []).map((override) => [override.path, override]));
              indexedNotes = indexedNotes.map((note) => {
                const override = overrides.get(note.path);
                return override ? { ...note, raw: override.raw, modified: override.updated_at } : note;
              });
            }
          } catch {
            // 云端覆盖读取失败时仍展示构建时的笔记，下一轮同步会重试。
          }
        }
        const nextNotes: RawNote[] = indexedNotes.map((note) => ({
          ...note,
          modified: new Date(note.modified),
          source: 'local',
        }));
        setRawNotes((previous) => {
          if (payload.engine !== 'rust') return nextNotes;
          const removed = new Set(payload.removed || []);
          const current = new Map(previous.filter((n) => !removed.has(n.path)).map((n) => [n.id, n]));
          const incoming = new Set(nextNotes.map((n) => n.id));
          if (payload.full) for (const id of current.keys()) if (!incoming.has(id)) current.delete(id);
          for (const n of nextNotes) { const old = current.get(n.id); if (old?.version !== n.version || !old) { if (old?.bodyLoaded === true && hasDraftsRef.current) continue; current.set(n.id, n); } }
          return [...current.values()];
        });
        setFolderPaths(nextFolders);
        setSelectedId((current) => payload.engine === 'rust' && payload.full === false ? current : nextNotes.some((note) => note.id === current) ? current : nextNotes[0]?.id || '');
        setExpandedFolders((current) => {
          const available = new Set(nextFolders);
          const preserved = [...current].filter((folder) => available.has(folder));
          return new Set(preserved.length ? preserved : nextFolders.filter((folder) => !folder.includes('/')));
        });
        setIndexError(payload.error || '');
      } catch {
        // 开发服务器首次启动时索引可能尚未生成，下一轮会自动重试。
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
      }
    }

    void loadLocalIndex();
    const timer = window.setInterval(() => void loadLocalIndex(), 4_000);
    const refresh = () => { if (!document.hidden) void loadLocalIndex(); };
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => { hasDraftsRef.current = savingNote || Object.keys(editorDrafts).length > 0; }, [savingNote, editorDrafts]);

  useEffect(() => () => {
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
  }, []);

  const notes = useMemo(
    () => rawNotes.map((raw) => {
      const cached = parsedNoteCache.get(raw);
      if (cached?.interval === defaultInterval) return cached.note;
      const note = parseNote(raw, defaultInterval);
      parsedNoteCache.set(raw, { interval: defaultInterval, note }); return note;
    }),
    [rawNotes, defaultInterval],
  );

  const counts = useMemo(
    () => ({
      attention: notes.filter((note) => note.status === 'expired' || note.status === 'stale').length,
      soon: notes.filter((note) => note.status === 'soon').length,
    }),
    [notes],
  );

  const searchableNotes = useMemo(() => notes.map((note) => ({ note, text: nativeEngine ? '' : `${note.title} ${note.path} ${note.tags.join(' ')} ${note.body}`.toLocaleLowerCase('zh-CN') })), [notes, nativeEngine]);
  useEffect(() => {
    if (!nativeEngine || !query.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/local-api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal, headers: workspaceHeaders() }).then(async (response) => { if (!response.ok) throw new Error('搜索失败'); return response.json() as Promise<{ paths: string[] }>; }).then((result) => setSearchPaths(new Set(result.paths))).catch((error) => { if (error.name !== 'AbortError') setFileError('搜索暂不可用，请稍后重试。'); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [nativeEngine, query, rawNotes]);
  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return searchableNotes.filter(({ note, text }) => (!normalizedQuery || (nativeEngine ? searchPaths?.has(note.path) : text.includes(normalizedQuery))) && tagFilters.every((tag) => note.tags.includes(tag))).map(({ note }) => note);
  }, [searchableNotes, query, tagFilters, nativeEngine, searchPaths]);

  const folderTree = useMemo(() => {
    const visibleFolders = query.trim() || tagFilters.length
      ? [...new Set(filteredNotes.flatMap((note) => { const parts = note.path.split('/').slice(0, -1); return parts.map((_, index) => parts.slice(0, index + 1).join('/')); }))]
      : folderPaths;
    return buildFolderTree(filteredNotes, visibleFolders);
  }, [filteredNotes, folderPaths, query, tagFilters]);

  const selectedNote =
    filteredNotes.find((note) => note.id === selectedId) ||
    filteredNotes[0];
  const selectedPath = selectedNote?.path;
  const selectedVersion = selectedNote?.version;
  const needsBody = selectedNote?.bodyLoaded === false;
  useEffect(() => {
    if (!nativeEngine || !selectedPath || !needsBody) return;
    const controller = new AbortController();
    void fetch(`/local-api/notes/read?path=${encodeURIComponent(selectedPath)}`, { signal: controller.signal, headers: workspaceHeaders() }).then(async (response) => {
      const result = await response.json() as { raw: string; modified: string; version: string; error?: string };
      if (!response.ok) throw new Error(result.error || '打开笔记失败');
      if (controller.signal.aborted) return;
      versionsRef.current.set(selectedPath, result.version);
      setRawNotes((current) => current.map((n) => n.path === selectedPath ? { ...n, summaryRaw: n.raw, raw: result.raw, bodyLoaded: true, modified: new Date(result.modified), version: result.version } : n.bodyLoaded === true && n.summaryRaw !== undefined ? { ...n, raw: n.summaryRaw, bodyLoaded: false } : n));
      setLoadError('');
    }).catch((error) => { if (error.name !== 'AbortError') setLoadError(error.message); });
    return () => controller.abort();
  }, [nativeEngine, selectedPath, selectedVersion, needsBody, loadAttempt]);
  const editorBody = selectedNote
    ? (editorDrafts[selectedNote.id] ?? selectedNote.body)
    : '';
  const editorDirty = Boolean(selectedNote && editorBody !== selectedNote.body);
  const canDropToRoot = Boolean(draggedItem?.path.includes('/') && !fileBusy && !savingNote && !feishuBusy && !Object.keys(editorDrafts).length);
  function updateDraggedItem(item: DraggedItem | null) {
    setDraggedItem(item);
    setRootDropActive(false);
  }

  function toggleSidebar() {
    const collapse = !sidebarHidden;
    window.localStorage.setItem(SIDEBAR_KEY, String(collapse));
    window.dispatchEvent(new Event(SIDEBAR_EVENT));
    if (isMobile) setMobileReaderOpen(collapse);
  }

  function toggleFolder(path: string) {
    setSelectedFolder(path);
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function completeFileAction(result: FileResult, action: string) {
    lastSyncRef.current = result.index.generatedAt;
    setRawNotes(result.index.notes.map((note) => ({ ...note, modified: new Date(note.modified) })));
    setFolderPaths(result.index.folders);
    const folder = action.endsWith('-folder') ? result.path : result.path.split('/').slice(0, -1).join('/');
    setSelectedFolder(folder);
    setExpandedFolders((current) => {
      const remap = (item: string) => result.previousPath && (item === result.previousPath || item.startsWith(`${result.previousPath}/`)) ? result.path + item.slice(result.previousPath.length) : item;
      const next = new Set([...current].map(remap));
      const parts = folder.split('/');
      parts.forEach((_, index) => next.add(parts.slice(0, index + 1).join('/')));
      return next;
    });
    if (action === 'move-folder' || action === 'rename-folder') {
      if (selectedNote && result.previousPath && selectedNote.path.startsWith(`${result.previousPath}/`)) setSelectedId(`local-${result.path}${selectedNote.path.slice(result.previousPath.length)}`);
    } else if (action !== 'create-folder') { setSelectedId(`local-${result.path}`); setMobileReaderOpen(true); }
    setQuery('');
    if (action === 'create-note') setTagFilters([]);
  }

  async function moveTreeItem(source: string, kind: 'note' | 'folder', folder: string) {
    if (fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length) return;
    setFileBusy(true); setFileError('');
    try {
      const action = kind === 'folder' ? 'move-folder' : 'move-note';
      const response = await fetch('/local-api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() }, body: JSON.stringify({ action, path: source, folder }) });
      const result = await response.json() as FileResult & { error?: string };
      if (!response.ok) throw new Error(result.error || '移动失败。');
      completeFileAction(result, action);
    } catch (failure) { setFileError(failure instanceof Error ? failure.message : '移动失败。'); }
    finally { setFileBusy(false); }
  }

  async function renameTreeItem(source: string, kind: 'note' | 'folder', name: string) {
    if (fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length) throw new Error('请等待笔记保存或同步完成后重命名。');
    setFileBusy(true);
    try {
      const action = kind === 'folder' ? 'rename-folder' : 'rename-note';
      const response = await fetch('/local-api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() }, body: JSON.stringify({ action, path: source, name }) });
      const result = await response.json() as FileResult & { error?: string };
      if (!response.ok) throw new Error(result.error || '重命名失败。');
      completeFileAction(result, action);
    } finally { setFileBusy(false); }
  }

  async function deleteTreeItem(source: string) {
    if (fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length) throw new Error('请等待笔记保存或同步完成后删除。');
    setFileBusy(true); setFileError('');
    try {
      const response = await fetch('/local-api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() }, body: JSON.stringify({ action: 'delete-note', path: source, confirmed: true }) });
      const result = await response.json() as FileResult & { error?: string };
      if (!response.ok) throw new Error(result.error || '删除失败。');
      lastSyncRef.current = result.index.generatedAt;
      setRawNotes(result.index.notes.map((note) => ({ ...note, modified: new Date(note.modified) })));
      setFolderPaths(result.index.folders);
      if (selectedNote?.path === source) {
        const remaining = filteredNotes.filter((note) => note.path !== source && result.index.notes.some((item) => item.id === note.id));
        const next = remaining[Math.min(filteredNotes.findIndex((note) => note.path === source), remaining.length - 1)];
        setSelectedId(next?.id || '');
        if (next) setSelectedFolder(next.path.split('/').slice(0, -1).join('/'));
        else setMobileReaderOpen(false);
      }
    } finally { setFileBusy(false); }
  }

  function updateReaderWidth(nextWidth: number) {
    const clampedWidth = Math.min(1600, Math.max(480, Math.round(nextWidth)));
    window.localStorage.setItem(READER_WIDTH_STORAGE_KEY, String(clampedWidth));
    window.dispatchEvent(new Event(READER_WIDTH_EVENT));
  }

  async function saveNoteTags(note: Note, tags: string[]) {
    setFileBusy(true);
    try {
      const response = await fetch('/local-api/notes/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
        body: JSON.stringify({ path: note.path, tags, version: versionsRef.current.get(note.path) || note.version }),
      });
      const result = (await response.json()) as { error?: string; raw?: string; modified?: string; version?: string; summary?: RawNote; tags?: string[] };
      if (!response.ok || !result.raw || !result.modified) {
        throw new Error(result.error || '本地标签服务没有响应，请重新启动知识库网站。');
      }

      if (result.version) versionsRef.current.set(note.path, result.version);
      setRawNotes((current) => current.map((rawNote) => rawNote.id === note.id
        ? { ...rawNote, raw: result.raw!, version: result.version || rawNote.version, summaryRaw: result.summary?.raw || rawNote.summaryRaw, bodyLoaded: true, modified: new Date(result.modified!) }
        : rawNote));
    } finally { setFileBusy(false); }
  }

  async function manageTags(action: 'rename-tag' | 'delete-tag', tag: string, name?: string) {
    setFileBusy(true);
    try {
      const response = await fetch('/local-api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders() }, body: JSON.stringify({ action, tag, name }) });
      const result = await response.json() as { error?: string; index: FileResult['index'] };
      if (!response.ok) throw new Error(result.error || '标签更新失败。');
      lastSyncRef.current = result.index.generatedAt;
      setRawNotes(result.index.notes.map((note) => ({ ...note, modified: new Date(note.modified) })));
      setTagFilters((current) => [...new Set(current.flatMap((item) => item !== tag ? [item] : action === 'rename-tag' && name ? [name.trim().replace(/^#+/, '').trim().slice(0, 32)] : []))]);
    } finally { setFileBusy(false); }
  }

  async function persistNoteContent(note: Note, body: string) {
    const localWorkspace = isLocalWorkspace();
    const response = await fetch(localWorkspace ? '/local-api/notes/content' : '/api/note-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
      body: JSON.stringify(localWorkspace
        ? { path: note.path, body, version: versionsRef.current.get(note.path) || note.version }
        : { path: note.path, raw: replaceNoteBody(note.raw, body) }),
    });
    const result = (await response.json()) as { error?: string; raw?: string; modified?: string; version?: string; summary?: RawNote };
    if (!response.ok || !result.raw || !result.modified) {
      throw new Error(result.error || (localWorkspace
        ? '本地编辑服务没有响应，请重新启动知识库网站。'
        : '云端保存服务没有响应，请稍后重试。'));
    }

    if (result.version) versionsRef.current.set(note.path, result.version);
    setRawNotes((current) => current.map((rawNote) => rawNote.id === note.id
      ? { ...rawNote, raw: result.raw!, version: result.version || rawNote.version, summaryRaw: result.summary?.raw || rawNote.summaryRaw, bodyLoaded: true, modified: new Date(result.modified!) }
      : rawNote));
    setEditorDrafts((current) => {
      if (current[note.id] !== body) return current;
      const next = { ...current };
      delete next[note.id];
      return next;
    });
  }

  async function flushPendingNoteSaves() {
    if (saveLoopRunningRef.current) return;
    saveLoopRunningRef.current = true;
    setSavingNote(true);
    setEditorError('');
    try {
      while (true) {
        const nextEntry = Object.entries(pendingNoteSavesRef.current)[0];
        if (!nextEntry) break;
        const [noteId, pendingSave] = nextEntry;
        delete pendingNoteSavesRef.current[noteId];
        await persistNoteContent(pendingSave.note, pendingSave.body);
      }
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : '笔记保存失败。');
    } finally {
      saveLoopRunningRef.current = false;
      setSavingNote(false);
      if (Object.keys(pendingNoteSavesRef.current).length) void flushPendingNoteSaves();
    }
  }

  function queueNoteSave(note: Note, body: string, delay = 0) {
    pendingNoteSavesRef.current[note.id] = { note, body };
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    if (delay > 0) {
      autoSaveTimerRef.current = window.setTimeout(() => {
        autoSaveTimerRef.current = null;
        void flushPendingNoteSaves();
      }, delay);
    } else {
      autoSaveTimerRef.current = null;
      void flushPendingNoteSaves();
    }
  }

  function saveNoteContent(note: Note, body: string) {
    queueNoteSave(note, body);
  }

  return (
    <div className="app-shell" onKeyDownCapture={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (selectedNote && editorDirty && !feishuBusy && !fileBusy) saveNoteContent(selectedNote, editorBody);
      }
    }}>
      <header className="topbar">
        <div className="top-navigation">
          <button className="quiet-control sidebar-toggle" onClick={toggleSidebar} title={sidebarHidden ? '展开目录' : '收起目录'} aria-label={sidebarHidden ? '展开目录' : '收起目录'} aria-expanded={!sidebarHidden} aria-controls="collection-panel">{sidebarHidden ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
          <label className="search-box">
            <Search size={17} aria-hidden="true" />
            <input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setSidebarView('files'); }} placeholder="搜索标题、正文或标签…" aria-label="搜索笔记" />
            <kbd>{shortcutModifier} K</kbd>
          </label>
        </div>

        <div className="top-actions">
          <TagManager note={selectedNote} notes={notes} filters={tagFilters}
            onFilter={(tags) => { setTagFilters(tags); setSidebarView('files'); setExpandedFolders(new Set(folderPaths)); }}
            disabled={fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length > 0}
            onSave={async (tags) => { if (selectedNote) await saveNoteTags(selectedNote, tags); }} onManage={manageTags} />
          <FeishuSyncPanel notePath={selectedNote?.path} folders={folderPaths} notePaths={notes.map((note) => note.path)} selectedFolder={selectedFolder} dirty={fileBusy || editorDirty || savingNote || Object.keys(editorDrafts).length > 0} onBusyChange={setFeishuBusy} />
          <button className="top-refresh-button" title="重新读取本地笔记" aria-label="重新读取本地笔记" onClick={() => window.location.reload()}>
            <RefreshCcw size={17} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <main className={`main-content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <section className="collection-panel" id="collection-panel">
            <div className="collection-head">
              <div>
                <div className={`breadcrumb root-drop-breadcrumb ${rootDropActive && canDropToRoot ? 'drop-target' : ''}`}
                  title="将文件或文件夹拖到这里，移至知识库根目录"
                  onDragOver={(event) => {
                    if (!canDropToRoot) { event.dataTransfer.dropEffect = 'none'; return; }
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setRootDropActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRootDropActive(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault(); event.stopPropagation();
                    if (canDropToRoot && draggedItem) void moveTreeItem(draggedItem.path, draggedItem.kind, '');
                    updateDraggedItem(null);
                  }}>
                  <span>知识库</span><ChevronRight size={13} /><span>{canDropToRoot ? '移至根目录' : '文件'}</span>
                </div>
                <h1>我的笔记</h1>
              </div>
              <div className="collection-head-actions">
                <FileActions folders={folderPaths} selectedFolder={selectedFolder}
                  disabled={fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length > 0}
                  onBusyChange={setFileBusy} onComplete={completeFileAction} />
                <LocalFolderPicker path={workspacePath} disabled={fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length > 0} onBusyChange={setFileBusy} />
                <details className="review-settings">
                  <summary title="时效提醒设置" aria-label="时效提醒设置"><Settings2 size={15} /></summary>
                  <div className="review-settings-panel">
                    <strong>时效提醒</strong>
                    <p>{counts.attention} 篇待复查 · {counts.soon} 篇即将到期</p>
                    <label>默认复查周期
                      <select value={defaultInterval} onChange={(event) => setDefaultInterval(Number(event.target.value))} aria-label="默认复查周期">
                        <option value={30}>30 天</option><option value={60}>60 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option>
                      </select>
                    </label>
                    <p>只用于没有单独设置复查周期的笔记。</p>
                  </div>
                </details>
              </div>
            </div>

            {fileError && <p className="editor-error" role="alert">{fileError}</p> }

            {indexError && <p className="editor-error" role="alert">{indexError}</p>}

            <div className="collection-view-switch" role="group" aria-label="左侧导航内容">
              <button type="button" aria-pressed={sidebarView === 'files'} aria-controls="note-file-list" onClick={() => setSidebarView('files')}>文件</button>
              <button type="button" aria-pressed={sidebarView === 'outline'} aria-controls="note-outline-panel" disabled={!selectedNote} onClick={() => setSidebarView('outline')}>大纲</button>
            </div>

            <div className="note-list" id="note-file-list" hidden={sidebarView !== 'files' && Boolean(selectedNote)}>
              <FileTree
                root={folderTree}
                dragged={draggedItem}
                setDragged={updateDraggedItem}
                expanded={expandedFolders}
                selectedId={selectedNote?.id}
                selectedFolder={selectedFolder}
                disabled={fileBusy || savingNote || feishuBusy || Object.keys(editorDrafts).length > 0}
                onMove={(source, kind, folder) => void moveTreeItem(source, kind, folder)}
                onRename={renameTreeItem}
                onDelete={deleteTreeItem}
                onToggle={toggleFolder}
                onSelect={(note) => { setSelectedId(note.id); setSelectedFolder(note.path.split('/').slice(0, -1).join('/')); setMobileReaderOpen(true); }}
              />
              {!filteredNotes.length && (
                <div className="empty-state">
                  {notes.length ? <Search size={24} /> : <FolderOpen size={24} />}
                  <strong>{notes.length ? '没有匹配的笔记' : '知识库中没有 Markdown 笔记'}</strong>
                  <span>{notes.length ? '换个关键词或清除筛选条件试试。' : '点击上方“新建笔记”开始记录，也可以先创建文件夹。'}</span>
                  {notes.length > 0 && <button onClick={() => { setQuery(''); setTagFilters([]); }}>清除筛选</button>}
                </div>
              )}
            </div>
            {sidebarView === 'outline' && selectedNote && (
              <NoteOutline key={selectedNote.id} title={selectedNote.title} markdown={editorBody}
                readerRef={readerRef} onNavigate={() => setMobileReaderOpen(true)} />
            )}
          </section>

          <section
            ref={readerRef}
            className={`reader-panel ${mobileReaderOpen ? 'mobile-reader-open' : ''}`}
            style={{ '--reader-page-width': `${readerWidth}px` } as CSSProperties}
          >
            {selectedNote ? (
              <>
                <header className="reader-head">
                  <button className="mobile-reader-back" onClick={() => { window.localStorage.setItem(SIDEBAR_KEY, 'false'); window.dispatchEvent(new Event(SIDEBAR_EVENT)); setSidebarView('files'); setMobileReaderOpen(false); }} aria-label="返回笔记列表"><X size={18} />返回列表</button>
                  <div className="reader-path">{selectedNote.path.split('/').map((part, index, parts) => <span key={`${part}-${index}`}>{part}{index < parts.length - 1 && <ChevronRight size={12} />}</span>)}</div>
                  <div className="reader-title-row">
                    <div><h2>{selectedNote.title}</h2></div>
                    <div className="reader-actions">
                      <ReaderWidthControl width={readerWidth} onChange={updateReaderWidth} />
                      <MetadataInfo note={selectedNote} />
                    </div>
                  </div>
                  <div className="reader-workspace-controls">
                    <div className="editor-save-status" role="status"><Check size={14} /><span>{editorError ? '保存失败' : savingNote ? '正在保存…' : editorDirty ? '等待保存' : '已保存'}</span></div>

                  </div>
                </header>

                {(selectedNote.status === 'expired' || selectedNote.status === 'stale') && (
                  <div className={`stale-callout ${selectedNote.status === 'expired' ? 'expired-callout' : ''}`}>
                    <AlertTriangle size={19} />
                    <div>
                      <strong>{selectedNote.status === 'expired' ? '这篇笔记的有效期已经结束' : '这篇笔记可能已经陈旧'}</strong>
                      <p>{selectedNote.status === 'expired' ? `设定的有效期已过去 ${Math.abs(selectedNote.daysUntilDue)} 天。继续使用前，请重新核对来源。` : `距离上次可靠更新已有 ${selectedNote.ageDays} 天，超过了 ${selectedNote.reviewInterval} 天的复查周期。`}</p>
                    </div>
                  </div>
                )}

                {selectedNote.status === 'soon' && (
                  <div className="stale-callout soon-callout"><CalendarClock size={19} /><div><strong>即将进入复查周期</strong><p>建议在未来 {Math.max(0, selectedNote.daysUntilDue)} 天内重新确认这篇笔记。</p></div></div>
                )}

                <section
                  className="markdown-editor"
                  aria-label={`编辑 ${selectedNote.title}`}

                >
                  {needsBody ? <div className="rich-editor-loading" role="status">{loadError || '正在打开笔记…'}{loadError && <button type="button" onClick={() => { setLoadError(''); setLoadAttempt((n) => n + 1); }}>重试</button>}</div> : <MarkdownRichEditor
                    key={selectedNote.id}
                    markdown={editorBody}
                    notePath={selectedNote.path}
                    readOnly={feishuBusy || fileBusy || Boolean(indexError)}
                    onChange={(nextMarkdown) => {
                      setEditorDrafts((current) => ({ ...current, [selectedNote.id]: nextMarkdown }));
                      setEditorError('');
                      queueNoteSave(selectedNote, nextMarkdown, 600);
                    }}
                  />}
                  {editorError && <p className="editor-error">{editorError}</p>}
                </section>

              </>
            ) : (
              <div className="reader-empty"><BookOpen size={28} /><strong>{notes.length ? '选择左侧文件开始阅读' : '知识库中暂无可阅读的 Markdown 文件'}</strong></div>
            )}
          </section>
        </main>
      </div>

    </div>
  );
}
