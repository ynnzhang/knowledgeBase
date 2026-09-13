'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { usePublisher } from '@mdxeditor/gurx';
import { $createParagraphNode, $getNodeByKey, $isElementNode } from 'lexical';
import type { Html } from 'mdast';
import { AlignCenter, AlignLeft, AlignRight, Settings2, Trash2 } from 'lucide-react';
import {
  $createImageNode,
  $isImageNode,
  MDXEditor,
  type MDXEditorMethods,
  addImportVisitor$,
  addSyntaxExtension$,
  addToMarkdownExtension$,
  codeBlockPlugin,
  headingsPlugin,
  type ImageNode,
  type MdastImportVisitor,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  openEditImageDialog$,
  quotePlugin,
  realmPlugin,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import { resolveNoteImageUrl, uploadNoteImage } from './note-images';
import { editorContextMenuPlugin } from './EditorContextMenu';
import { cleanFeishuMarkdown } from './remark-clean-feishu';
import { cjkSyntax, cjkSerialization } from './markdown-syntax.mjs';
import { tableToolsPlugin } from './TableTools';
import { NoteCodeBlock } from './NoteCodeBlock';
import { registerCodeFence } from './code-fence.mjs';
import { addComposerChild$, addNestedEditorChild$, addTableCellEditorChild$ } from '@mdxeditor/editor';

function CodeFenceShortcut() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerCodeFence(editor), [editor]);
  return null;
}
const codeFencePlugin = realmPlugin({
  init(realm) { realm.pubIn({ [addComposerChild$]: CodeFenceShortcut, [addNestedEditorChild$]: CodeFenceShortcut, [addTableCellEditorChild$]: CodeFenceShortcut }); },
});

const cjkMarkdownPlugin = realmPlugin({
  init(realm) { realm.pubIn({ [addSyntaxExtension$]: cjkSyntax, [addToMarkdownExtension$]: cjkSerialization }); },
});

export type MarkdownRichEditorProps = {
  markdown: string;
  notePath: string;
  readOnly?: boolean;
  onChange: (markdown: string) => void;
};

type ImageAlignment = 'left' | 'center' | 'right';

type ImageEditToolbarProps = {
  nodeKey: string;
  imageSource: string;
  initialImagePath: string | null;
  title: string;
  alt: string;
  width?: number | 'inherit';
  height?: number | 'inherit';
};

type WritableImageNode = {
  __rest: ReturnType<ImageNode['getRest']>;
  getWritable: () => WritableImageNode;
};

const ALIGNMENT_CLASS = /(?:^|\s)image-align-(?:left|center|right)(?=\s|$)/g;

function readImageAlignment(node: ImageNode): ImageAlignment {
  const classAttribute = node.getRest().find((attribute) =>
    attribute.type === 'mdxJsxAttribute' && (attribute.name === 'class' || attribute.name === 'className'));
  const className = classAttribute?.type === 'mdxJsxAttribute' && typeof classAttribute.value === 'string'
    ? classAttribute.value
    : '';
  if (className.includes('image-align-left')) return 'left';
  if (className.includes('image-align-right')) return 'right';
  return 'center';
}

function writeImageAlignment(node: ImageNode, alignment: ImageAlignment) {
  const rest = node.getRest().filter((attribute) =>
    !(attribute.type === 'mdxJsxAttribute' && (attribute.name === 'class' || attribute.name === 'className')));
  const existingClass = node.getRest().find((attribute) =>
    attribute.type === 'mdxJsxAttribute' && (attribute.name === 'class' || attribute.name === 'className'));
  const className = existingClass?.type === 'mdxJsxAttribute' && typeof existingClass.value === 'string'
    ? existingClass.value.replace(ALIGNMENT_CLASS, ' ').replace(/\s+/g, ' ').trim()
    : '';
  rest.push({
    type: 'mdxJsxAttribute',
    name: 'class',
    value: [className, `image-align-${alignment}`].filter(Boolean).join(' '),
  });
  (node as unknown as WritableImageNode).getWritable().__rest = rest;
}

function parseDimension(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// MDXEditor serializes resized images as HTML. This higher-priority importer keeps
// the alignment class when a note is reopened instead of dropping it on parse.
const alignedHtmlImageVisitor: MdastImportVisitor<Html> = {
  priority: 100,
  testNode: (node) => node.type === 'html' && node.value.trimStart().startsWith('<img'),
  visitNode: ({ mdastNode, lexicalParent }) => {
    if (!$isElementNode(lexicalParent)) throw new Error('图片必须插入到可包含子节点的元素中。');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = mdastNode.value;
    const imageElement = wrapper.querySelector('img');
    if (!imageElement) return;

    const reservedAttributes = new Set(['src', 'alt', 'title', 'width', 'height']);
    const rest = Array.from(imageElement.attributes)
      .filter((attribute) => !reservedAttributes.has(attribute.name))
      .map((attribute) => ({
        type: 'mdxJsxAttribute' as const,
        name: attribute.name,
        value: attribute.value,
      }));
    const imageNode = $createImageNode({
      src: imageElement.getAttribute('src') || '',
      altText: imageElement.getAttribute('alt') || '',
      title: imageElement.getAttribute('title') || undefined,
      width: parseDimension(imageElement.getAttribute('width')),
      height: parseDimension(imageElement.getAttribute('height')),
      rest,
    });

    if (lexicalParent.getType() === 'root') {
      const paragraph = $createParagraphNode();
      paragraph.append(imageNode);
      lexicalParent.append(paragraph);
    } else {
      lexicalParent.append(imageNode);
    }
  },
};

const alignedImageHtmlPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({ [addImportVisitor$]: alignedHtmlImageVisitor });
  },
});

function ImageEditToolbar({
  nodeKey,
  imageSource,
  initialImagePath,
  title,
  alt,
  width,
  height,
}: ImageEditToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const openEditImageDialog = usePublisher(openEditImageDialog$);
  const [alignment, setAlignment] = useState<ImageAlignment>('center');

  useEffect(() => {
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) setAlignment(readImageAlignment(node));
    });
  }, [editor, nodeKey]);

  const alignImage = (nextAlignment: ImageAlignment) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) writeImageAlignment(node, nextAlignment);
    });
    setAlignment(nextAlignment);
  };

  const alignmentButtons = [
    { value: 'left' as const, label: '左对齐', Icon: AlignLeft },
    { value: 'center' as const, label: '居中', Icon: AlignCenter },
    { value: 'right' as const, label: '右对齐', Icon: AlignRight },
  ];

  return (
    <div className="image-edit-toolbar" role="toolbar" aria-label="图片布局工具" onMouseDown={(event) => event.preventDefault()}>
      <div className="image-align-group" aria-label="图片对齐方式">
        {alignmentButtons.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className={alignment === value ? 'active' : ''}
            title={label}
            aria-label={label}
            aria-pressed={alignment === value}
            onClick={() => alignImage(value)}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>
      <span className="image-toolbar-divider" />
      <button
        type="button"
        title="精确设置图片尺寸"
        aria-label="精确设置图片尺寸"
        onClick={() => openEditImageDialog({
          nodeKey,
          initialValues: {
            src: initialImagePath || imageSource,
            title,
            altText: alt,
            width: typeof width === 'number' ? width : undefined,
            height: typeof height === 'number' ? height : undefined,
          },
        })}
      >
        <Settings2 size={15} />
      </button>
      <button
        type="button"
        className="image-delete-button"
        title="删除图片"
        aria-label="删除图片"
        onClick={() => editor.update(() => $getNodeByKey(nodeKey)?.remove())}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

export default function MarkdownRichEditorInner({ markdown, notePath, readOnly = false, onChange }: MarkdownRichEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const [sourceFallback, setSourceFallback] = useState(false);
  const cleanMarkdown = useMemo(() => cleanFeishuMarkdown(markdown), [markdown]);
  const lastMarkdown = useRef(cleanMarkdown);
  useEffect(() => {
    if (lastMarkdown.current !== cleanMarkdown) {
      lastMarkdown.current = cleanMarkdown;
      editorRef.current?.setMarkdown(cleanMarkdown);
    }
  }, [cleanMarkdown]);
  const plugins = useMemo(() => [
    alignedImageHtmlPlugin(),
    editorContextMenuPlugin(),
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    imagePlugin({
      disableImageResize: false,
      allowSetImageDimensions: true,
      EditImageToolbar: ImageEditToolbar as FC,
      imageUploadHandler: (image) => uploadNoteImage(notePath, image),
      imagePreviewHandler: async (imageSource) => resolveNoteImageUrl(notePath, imageSource),
    }),
    tablePlugin(),
    tableToolsPlugin(),
    cjkMarkdownPlugin(),
    thematicBreakPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: 'txt', codeBlockEditorDescriptors: [{ priority: 10, match: () => true, Editor: NoteCodeBlock }] }),
    markdownShortcutPlugin(),
    codeFencePlugin(),
  ], [notePath]);

  if (sourceFallback) return <div className="editor-source-fallback">
    <p role="status">这篇笔记包含暂不支持的排版，已保留完整原文，可继续编辑。</p>
    <textarea aria-label="笔记原文" value={cleanMarkdown} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
  </div>;

  return (
    <MDXEditor
      ref={editorRef}
      markdown={cleanMarkdown}
      readOnly={readOnly}
      onError={() => queueMicrotask(() => setSourceFallback(true))}
      onChange={(nextMarkdown, initialNormalize) => {
        if (!initialNormalize) {
          lastMarkdown.current = nextMarkdown;
          onChange(nextMarkdown);
        }
      }}
      className="zhixu-rich-editor"
      contentEditableClassName="zhixu-rich-content"
      placeholder="开始输入… 输入 #、-、1. 或 > 后按空格即可排版"
      spellCheck
      plugins={plugins}
    />
  );
}
