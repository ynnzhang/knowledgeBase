'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parse as parseYaml } from 'yaml';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Folder,
  FolderOpen,
  RefreshCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tags,
  X,
} from 'lucide-react';

type NoteStatus = 'expired' | 'stale' | 'soon' | 'fresh';
type ViewFilter = 'all' | 'attention' | 'soon' | 'fresh';

type RawNote = {
  id: string;
  name: string;
  path: string;
  raw: string;
  modified: Date;
  source: 'demo' | 'local';
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

type LocalFileHandle = {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
};

type LocalDirectoryHandle = {
  kind: 'directory';
  name: string;
  values: () => AsyncIterableIterator<LocalFileHandle | LocalDirectoryHandle>;
};

type FolderNode = {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  notes: Note[];
};

type NotesIndexPayload = {
  root?: string;
  rootName?: string;
  generatedAt?: string;
  error?: string | null;
  notes?: Array<Omit<RawNote, 'modified'> & { modified: string }>;
};

const DAY = 86_400_000;
const STATUS_META: Record<NoteStatus, { label: string; className: string }> = {
  expired: { label: '已过期', className: 'status-expired' },
  stale: { label: '需复查', className: 'status-stale' },
  soon: { label: '即将到期', className: 'status-soon' },
  fresh: { label: '状态良好', className: 'status-fresh' },
};

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
}

function isoDaysFromNow(days: number) {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

function createDemoNotes(): RawNote[] {
  const samples = [
    {
      name: 'RAG 检索质量评估.md',
      path: 'AI/RAG 检索质量评估.md',
      modifiedDays: 126,
      raw: `---
title: RAG 检索质量评估
tags: [AI, RAG, 评估]
updated: ${isoDaysAgo(126)}
review_interval_days: 60
---

# RAG 检索质量评估

> 检索质量决定了生成答案的事实边界。评估时，应把“能否找回正确证据”和“答案是否忠实使用证据”拆开观察。

## 核心指标

| 层级 | 指标 | 关注点 |
| --- | --- | --- |
| 检索 | Recall@K | 相关文档是否进入候选集 |
| 排序 | MRR / NDCG | 最有价值的证据是否足够靠前 |
| 生成 | Faithfulness | 回答是否忠实使用检索上下文 |

## 复查清单

- [ ] 增加真实失败样本，而不只使用合成问题
- [ ] 分开记录“没有召回”和“召回后未使用”
- [ ] 针对长文档测试切块边界

## 待确认

当前评估集对多跳问题的覆盖仍然不足。`,
    },
    {
      name: 'Cloudflare Workers 运行时差异.md',
      path: 'Web/Cloudflare Workers 运行时差异.md',
      modifiedDays: 45,
      raw: `---
title: Cloudflare Workers 运行时差异
tags: [Web, Cloudflare, Runtime]
updated: ${isoDaysAgo(45)}
expires: ${isoDaysFromNow(-3)}
review_interval_days: 30
---

# Cloudflare Workers 运行时差异

这是一份容易随平台更新而变化的运行时兼容性记录。

## 当前结论

- Worker 默认运行在 V8 isolate 中，不是传统的常驻 Node.js 进程。
- 采用 Node.js API 前，应确认对应的兼容性标志和支持范围。
- 文件系统、原始 TCP 连接等能力需要按部署环境重新确认。

> 本笔记含明确有效期。继续使用前应对照官方文档重新核验。`,
    },
    {
      name: '个人知识库维护原则.md',
      path: '方法论/个人知识库维护原则.md',
      modifiedDays: 74,
      raw: `---
title: 个人知识库维护原则
tags: [知识管理, 方法论]
reviewed: ${isoDaysAgo(74)}
review_interval_days: 90
---

# 个人知识库维护原则

知识库的价值不在于收藏数量，而在于能够在需要时被找到、理解和更新。

## 三条维护原则

1. **一个主题，一个稳定入口。** 新资料优先补充到已有主题，而不是反复创建近似笔记。
2. **把结论和来源放在一起。** 对可能变化的知识，记录更新时间与核验来源。
3. **定期处理过期内容。** 过期不等于错误，它只是意味着需要重新建立信任。

## 每周整理

- 清空 Inbox 中可以归类的条目
- 合并重复主题
- 优先复查近期会用到的旧笔记`,
    },
    {
      name: 'TypeScript 类型收窄.md',
      path: '编程/TypeScript 类型收窄.md',
      modifiedDays: 11,
      raw: `---
title: TypeScript 类型收窄
tags: [TypeScript, 编程语言]
reviewed: ${isoDaysAgo(11)}
review_interval_days: 120
---

# TypeScript 类型收窄

类型收窄是 TypeScript 根据运行时检查，将联合类型推断为更具体类型的过程。

## 常见方式

\`typeof\`、\`instanceof\`、\`in\`、判别联合和用户自定义类型谓词都可以触发收窄。

\`\`\`ts
type Result =
  | { ok: true; value: string }
  | { ok: false; error: Error };

function print(result: Result) {
  if (result.ok) console.log(result.value);
  else console.error(result.error.message);
}
\`\`\`

判别字段比依赖对象形状更易读，也更容易穷尽检查。`,
    },
    {
      name: '间隔复习的实践方式.md',
      path: '学习/间隔复习的实践方式.md',
      modifiedDays: 28,
      raw: `---
title: 间隔复习的实践方式
tags: [学习方法, 记忆]
updated: ${isoDaysAgo(28)}
review_interval_days: 180
---

# 间隔复习的实践方式

与其在一次学习中反复阅读，不如把回忆分散到逐渐拉长的时间间隔中。

## 实践建议

- 用问题而不是长段摘要作为复习入口
- 优先复习答错、迟疑或无法迁移应用的内容
- 笔记变化后重新评估复习间隔

复习的目标不是记住句子，而是能在新问题中调用核心模型。`,
    },
  ];

  return samples.map((sample, index) => ({
    id: `demo-${index}`,
    name: sample.name,
    path: sample.path,
    raw: sample.raw,
    modified: new Date(Date.now() - sample.modifiedDays * DAY),
    source: 'demo' as const,
  }));
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

async function readDirectory(handle: LocalDirectoryHandle, prefix = ''): Promise<RawNote[]> {
  const notes: RawNote[] = [];
  for await (const entry of handle.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      notes.push(...(await readDirectory(entry, path)));
    } else if (/\.md(?:own)?$/i.test(entry.name)) {
      const file = await entry.getFile();
      notes.push({
        id: `local-${path}`,
        name: entry.name,
        path,
        raw: await file.text(),
        modified: new Date(file.lastModified),
        source: 'local',
      });
    }
  }
  return notes;
}

function StatusBadge({ status }: { status: NoteStatus }) {
  const meta = STATUS_META[status];
  return <span className={`status-badge ${meta.className}`}>{meta.label}</span>;
}

function buildFolderTree(notes: Note[]): FolderNode {
  const root: FolderNode = { name: 'E:\\Note', path: '', folders: new Map(), notes: [] };

  for (const note of notes) {
    const parts = note.path.split('/').filter(Boolean);
    let current = root;
    for (const folderName of parts.slice(0, -1)) {
      const folderPath = current.path ? `${current.path}/${folderName}` : folderName;
      if (!current.folders.has(folderName)) {
        current.folders.set(folderName, { name: folderName, path: folderPath, folders: new Map(), notes: [] });
      }
      current = current.folders.get(folderName)!;
    }
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
              <button
                key={note.id}
                className={selectedId === note.id ? 'file-row selected' : 'file-row'}
                onClick={() => onSelect(note)}
                style={{ paddingLeft: 31 + depth * 18 }}
              >
                <FileText size={16} />
                <span title={note.name}>{note.name}</span>
                <small>{formatDate(note.baseline).replace(/\d{4}年/, '')}</small>
                <StatusBadge status={note.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const rootFolders = [...root.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const rootFiles = [...root.notes].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return (
    <div className="file-tree" role="tree" aria-label="E:\\Note 文件夹和笔记">
      {rootFolders.map((folder) => renderFolder(folder, 0))}
      {rootFiles.map((note) => (
        <button key={note.id} className={selectedId === note.id ? 'file-row selected' : 'file-row'} onClick={() => onSelect(note)}>
          <FileText size={16} /><span title={note.name}>{note.name}</span><small>{formatDate(note.baseline).replace(/\d{4}年/, '')}</small><StatusBadge status={note.status} />
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const [rawNotes, setRawNotes] = useState<RawNote[]>(createDemoNotes);
  const [folderName, setFolderName] = useState('演示知识库');
  const [defaultInterval, setDefaultInterval] = useState(90);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewFilter>('all');
  const [selectedId, setSelectedId] = useState('demo-0');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('当前展示安全的示例笔记；选择文件夹后会切换到你的本地知识库。');
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(['AI', 'Web', '方法论', '编程', '学习']),
  );
  const inputRef = useRef<HTMLInputElement>(null);
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

        if (!payload.notes?.length) {
          setFolderName('E:\\Note（暂无笔记）');
          setMessage('E:\\Note 中暂时没有 Markdown 文件，当前保留示例内容。');
          return;
        }

        const nextNotes: RawNote[] = payload.notes.map((note) => ({
          ...note,
          modified: new Date(note.modified),
          source: 'local',
        }));
        setRawNotes(nextNotes);
        setFolderName(payload.root || 'E:\\Note');
        setSelectedId((current) => nextNotes.some((note) => note.id === current) ? current : nextNotes[0].id);
        setExpandedFolders(new Set(nextNotes.filter((note) => note.path.includes('/')).map((note) => note.path.split('/')[0])));
        setMessage(`正在读取 ${payload.root || 'E:\\Note'}，共 ${nextNotes.length} 篇笔记；原文件保持不变。`);
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

  const counts = useMemo(
    () => ({
      all: notes.length,
      attention: notes.filter((note) => note.status === 'expired' || note.status === 'stale').length,
      soon: notes.filter((note) => note.status === 'soon').length,
      fresh: notes.filter((note) => note.status === 'fresh').length,
    }),
    [notes],
  );

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    const rank: Record<NoteStatus, number> = { expired: 0, stale: 1, soon: 2, fresh: 3 };
    return notes
      .filter((note) => {
        const matchesView =
          view === 'all' ||
          (view === 'attention' && (note.status === 'expired' || note.status === 'stale')) ||
          note.status === view;
        const haystack = `${note.title} ${note.path} ${note.tags.join(' ')} ${note.body}`.toLocaleLowerCase('zh-CN');
        return matchesView && (!normalizedQuery || haystack.includes(normalizedQuery));
      })
      .sort((a, b) => rank[a.status] - rank[b.status] || b.baseline.getTime() - a.baseline.getTime());
  }, [notes, query, view]);

  const folderTree = useMemo(() => buildFolderTree(filteredNotes), [filteredNotes]);

  const selectedNote =
    filteredNotes.find((note) => note.id === selectedId) ||
    filteredNotes[0] ||
    notes.find((note) => note.id === selectedId);
  const oldestAttention = notes
    .filter((note) => note.status === 'expired' || note.status === 'stale')
    .sort((a, b) => b.ageDays - a.ageDays)[0];

  async function openFolder() {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<LocalDirectoryHandle>;
      }
    ).showDirectoryPicker;

    if (!picker) {
      inputRef.current?.click();
      return;
    }

    setLoading(true);
    try {
      const handle = await picker.call(window, { mode: 'read' });
      const nextNotes = await readDirectory(handle);
      if (!nextNotes.length) {
        setMessage('这个文件夹中没有找到 Markdown 笔记，请选择包含 .md 文件的目录。');
        return;
      }
      setRawNotes(nextNotes);
      setFolderName(handle.name);
      setSelectedId(nextNotes[0].id);
      setView('all');
      setMessage(`已在本地读取 ${nextNotes.length} 篇笔记。内容不会上传到服务器。`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage('无法读取这个文件夹。请检查浏览器的文件访问权限后重试。');
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadFromInput(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])].filter((file) => /\.md(?:own)?$/i.test(file.name));
    if (!files.length) {
      setMessage('选择的文件夹中没有 Markdown 笔记。');
      return;
    }
    setLoading(true);
    const nextNotes = await Promise.all(
      files.map(async (file, index) => {
        const path = file.webkitRelativePath || file.name;
        return {
          id: `upload-${path}-${index}`,
          name: file.name,
          path,
          raw: await file.text(),
          modified: new Date(file.lastModified),
          source: 'local' as const,
        };
      }),
    );
    const rootName = nextNotes[0].path.split('/')[0] || '本地知识库';
    setRawNotes(nextNotes);
    setFolderName(rootName);
    setSelectedId(nextNotes[0].id);
    setMessage(`已在本地读取 ${nextNotes.length} 篇笔记。内容不会上传到服务器。`);
    setLoading(false);
    event.target.value = '';
  }

  function selectView(nextView: ViewFilter) {
    setView(nextView);
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-mark" aria-hidden="true"><BookOpen size={20} strokeWidth={2.2} /></div>
          <div><div className="brand-name">知序</div><div className="brand-subtitle">让知识保持新鲜</div></div>
        </div>

        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或标签…" aria-label="搜索笔记" />
          <kbd>Ctrl K</kbd>
        </label>

        <div className="top-actions">
          <div className="privacy-pill" title="笔记只在当前浏览器中读取"><ShieldCheck size={15} /><span>仅本地读取</span></div>
          <button className="primary-button" onClick={openFolder} disabled={loading}>
            {loading ? <RefreshCcw className="spin" size={17} /> : <FolderOpen size={17} />}
            {loading ? '正在读取' : '打开 E:\\Note'}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            onChange={loadFromInput}
            className="hidden-input"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
        </div>
      </header>

      <div className="workspace">
        <main className="main-content">
          <section className="collection-panel">
            <div className="collection-head">
              <div>
                <div className="breadcrumb"><span>{folderName}</span><ChevronRight size={13} /><span>文件</span></div>
                <h1>{view === 'attention' ? '需要复查' : view === 'soon' ? '即将到期' : view === 'fresh' ? '状态良好' : 'E:\\Note'}</h1>
                <p>{filteredNotes.length} 个 Markdown 文件</p>
              </div>
              <label className="explorer-interval" title="没有单独设置复查周期时使用这个值">
                <Settings2 size={14} />
                <select value={defaultInterval} onChange={(event) => setDefaultInterval(Number(event.target.value))} aria-label="默认复查周期">
                  <option value={30}>30 天</option><option value={60}>60 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option>
                </select>
              </label>
            </div>

            <nav className="status-tabs" aria-label="按时效性筛选文件">
              <button className={view === 'all' ? 'active' : ''} onClick={() => selectView('all')}>全部 <em>{counts.all}</em></button>
              <button className={view === 'attention' ? 'active' : ''} onClick={() => selectView('attention')}>需复查 <em>{counts.attention}</em></button>
              <button className={view === 'soon' ? 'active' : ''} onClick={() => selectView('soon')}>即将到期 <em>{counts.soon}</em></button>
              <button className={view === 'fresh' ? 'active' : ''} onClick={() => selectView('fresh')}>良好 <em>{counts.fresh}</em></button>
            </nav>

            {counts.attention > 0 && view === 'all' && (
              <button className="review-alert" onClick={() => selectView('attention')}>
                <span className="alert-icon"><AlertTriangle size={18} /></span>
                <span><strong>{counts.attention} 篇笔记需要重新确认</strong><small>最旧的一篇已有 {oldestAttention?.ageDays || 0} 天未复查</small></span>
                <ChevronRight size={18} />
              </button>
            )}

            <div className="list-heading"><span>名称</span><small>修改日期 · 状态</small></div>

            <div className="note-list">
              <FileTree
                root={folderTree}
                expanded={expandedFolders}
                selectedId={selectedNote?.id}
                onToggle={toggleFolder}
                onSelect={(note) => { setSelectedId(note.id); setMobileReaderOpen(true); }}
              />
              {!filteredNotes.length && (
                <div className="empty-state"><Search size={24} /><strong>没有匹配的笔记</strong><span>换个关键词或清除筛选条件试试。</span><button onClick={() => { setQuery(''); setView('all'); }}>清除筛选</button></div>
              )}
            </div>
          </section>

          <section className={`reader-panel ${mobileReaderOpen ? 'mobile-reader-open' : ''}`}>
            {selectedNote ? (
              <>
                <header className="reader-head">
                  <button className="mobile-reader-back" onClick={() => setMobileReaderOpen(false)} aria-label="返回笔记列表"><X size={18} />返回列表</button>
                  <div className="reader-path">{selectedNote.path.split('/').map((part, index, parts) => <span key={`${part}-${index}`}>{part}{index < parts.length - 1 && <ChevronRight size={12} />}</span>)}</div>
                  <div className="reader-title-row">
                    <div><StatusBadge status={selectedNote.status} /><h2>{selectedNote.title}</h2></div>
                    <div className="reader-actions"><button title="重新从文件夹读取" onClick={openFolder} aria-label="重新读取知识库"><RefreshCcw size={17} /></button></div>
                  </div>
                  <div className="reader-meta">
                    <span><Clock3 size={14} />最近核验：{formatDate(selectedNote.reviewed || selectedNote.updated)}</span>
                    <span><FileText size={14} />约 {selectedNote.wordCount} 字</span>
                    {selectedNote.tags.length > 0 && <span><Tags size={14} />{selectedNote.tags.join(' · ')}</span>}
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

                <article className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
                      input: (props) => <input {...props} disabled={props.type === 'checkbox'} />,
                    }}
                  >
                    {selectedNote.body}
                  </ReactMarkdown>
                </article>

                <footer className="reader-footer">
                  <div><Sparkles size={16} /><span>下次复查</span><strong>{selectedNote.daysUntilDue < 0 ? '现在' : `${selectedNote.daysUntilDue} 天后`}</strong></div>
                  <p>建议复查后在 frontmatter 中更新 <code>reviewed</code> 日期。</p>
                </footer>
              </>
            ) : (
              <div className="reader-empty"><BookOpen size={28} /><strong>选择一篇笔记开始阅读</strong></div>
            )}
          </section>
        </main>
      </div>

      <div className="toast" role="status" aria-live="polite"><ShieldCheck size={15} /><span>{message}</span></div>
    </div>
  );
}
