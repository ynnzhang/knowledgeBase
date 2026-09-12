'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ListTree } from 'lucide-react';
import { extractNoteHeadings } from './note-outline';
import { cleanFeishuMarkdown } from './remark-clean-feishu';

type OutlineEntry = { title: string; level: number; element?: HTMLElement; offset?: number; end?: number };
type Props = {
  title: string;
  markdown: string;
  readerRef: RefObject<HTMLElement | null>;
  onNavigate: () => void;
};

export default function NoteOutline({ title, markdown, readerRef, onNavigate }: Props) {
  const sourceHeadings = useMemo(() => extractNoteHeadings(cleanFeishuMarkdown(markdown)), [markdown]);
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const entriesRef = useRef<OutlineEntry[]>([]);
  const navigationFrame = useRef(0);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    let frame = 0;
    let rebuild = true;

    function refresh() {
      frame = 0;
      if (rebuild) {
        rebuild = false;
        const content = reader!.querySelector('.zhixu-rich-content');
        const source = reader!.querySelector('.editor-source-fallback textarea');
        const next: OutlineEntry[] = content
          ? Array.from(content.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
            .filter((element) => {
              const nonEditable = element.closest('[contenteditable="false"]');
              return !nonEditable || nonEditable === content || !content.contains(nonEditable);
            })
            .map((element) => ({
              title: element.textContent?.replace(/\s+/g, ' ').trim() || '未命名标题',
              level: Number(element.tagName.slice(1)),
              element,
            }))
          : source ? sourceHeadings : [];
        entriesRef.current = next;
        setEntries((previous) => previous.length === next.length && previous.every((item, index) =>
          item.title === next[index].title && item.level === next[index].level &&
          item.element === next[index].element && item.offset === next[index].offset && item.end === next[index].end)
          ? previous : next);
        setReady(Boolean(content || source));
      }

      const rendered = entriesRef.current;
      if (!rendered.some((entry) => entry.element)) return;
      const mobile = window.matchMedia('(max-width: 720px)').matches;
      const top = mobile ? reader!.getBoundingClientRect().top + 28 : 104;
      let index = 0;
      for (let i = 0; i < rendered.length; i++) {
        if (rendered[i].element!.getBoundingClientRect().top <= top) index = i;
        else break;
      }
      const scroller = mobile ? reader! : document.documentElement;
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        index = rendered.length - 1;
      }
      setActiveIndex(index);
    }

    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(refresh);
    }
    const observer = new MutationObserver(() => { rebuild = true; schedule(); });
    observer.observe(reader, { subtree: true, childList: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(reader);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    reader.addEventListener('load', schedule, true);
    schedule();
    return () => {
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      reader.removeEventListener('load', schedule, true);
      window.cancelAnimationFrame(frame);
    };
  }, [readerRef, sourceHeadings]);

  useEffect(() => () => window.cancelAnimationFrame(navigationFrame.current), []);

  function navigate(entry: OutlineEntry, index: number) {
    onNavigate();
    window.cancelAnimationFrame(navigationFrame.current);
    navigationFrame.current = window.requestAnimationFrame(() => {
      if (entry.element?.isConnected) {
        entry.element.scrollIntoView({
          block: 'start',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      } else {
        const source = readerRef.current?.querySelector<HTMLTextAreaElement>('.editor-source-fallback textarea');
        if (source && entry.offset !== undefined) {
          source.focus();
          source.setSelectionRange(entry.offset, entry.end ?? entry.offset);
        }
      }
      setActiveIndex(index);
    });
  }

  const baseLevel = entries.length ? Math.min(...entries.map((entry) => entry.level)) : 1;
  return (
    <div className="note-outline" id="note-outline-panel">
      <div className="note-outline-heading"><strong title={title}>{title}</strong><span>{entries.length} 个标题</span></div>
      {entries.length ? (
        <nav className="note-outline-nav" aria-label={`${title}的笔记大纲`}>
          <ol>
            {entries.map((entry, index) => (
              <li key={index}>
                <button type="button" title={entry.title}
                  style={{ paddingLeft: 10 + (entry.level - baseLevel) * 14 }}
                  aria-current={activeIndex === index ? 'location' : undefined}
                  onClick={() => navigate(entry, index)}>
                  <span className="outline-level" aria-label={`${entry.level} 级标题`}>{`H${entry.level}`}</span>
                  <span>{entry.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <div className="outline-empty" role="status"><ListTree size={24} />
          <strong>{ready ? '这篇笔记还没有标题' : '正在读取大纲…'}</strong>
          {ready && <p>在正文中添加一级到六级标题，即可生成大纲。</p>}
        </div>
      )}
    </div>
  );
}
