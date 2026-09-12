import { statSync } from 'node:fs';
import path from 'node:path';

// These are project sources, not npm packages. Keep this check dependency-free
// so an incomplete copy can be diagnosed before installation or service startup.
export const requiredProjectFiles = [
  'package.json', 'package-lock.json', 'vite.config.ts', 'next.config.ts',
  'tsconfig.json', '.openai/hosting.json',
  ...[
    'start-local', 'check-project', 'sync-notes', 'local-config', 'local-platform',
    'local-workspace', 'local-files', 'note-tags', 'feishu-sync',
    'feishu-content', 'feishu-markdown', 'feishu-media',
  ].map((name) => `scripts/${name}.mjs`),
  ...[
    'page.tsx', 'layout.tsx', 'globals.css', 'MarkdownRichEditor.tsx',
    'MarkdownRichEditorInner.tsx', 'EditorContextMenu.tsx', 'FeishuSyncPanel.tsx',
    'FileActions.tsx', 'FileRename.tsx', 'LocalFolderPicker.tsx', 'NoteOutline.tsx',
    'ReaderWidthControl.tsx', 'TagManager.tsx', 'local-workspace.ts',
    'note-outline.ts', 'note-images.ts', 'remark-clean-feishu.ts',
    'api/note-overrides/route.ts', 'api/note-images/route.ts',
  ].map((name) => `app/${name}`),
  'db/schema.ts',
];

export function assertProjectFiles(projectRoot) {
  const missing = requiredProjectFiles.filter((file) => {
    try { return !statSync(path.join(projectRoot, file)).isFile(); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return true;
      throw error;
    }
  });
  if (missing.length) {
    throw new Error(`项目文件不完整，缺少以下源码或配置：\n${missing.map((file) => `  - ${file}`).join('\n')}\n请完整解压同一版本的项目包，或从原电脑同步完整项目源码后重试。\nnpm install / npm ci 只安装依赖，不会补回这些文件。请保留 Windows 本机的笔记目录和本地配置，不要复制其他电脑的 node_modules。`);
  }
}
