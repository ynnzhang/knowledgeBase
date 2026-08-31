import type { Metadata } from 'next';
import '@mdxeditor/editor/style.css';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: '知序 · 高效学习与笔记整理',
  description: '本地优先的 Markdown 学习与笔记工作台，用文件夹、全文搜索和标签提升知识整理效率。',
  openGraph: {
    title: '知序 · 高效学习与笔记整理',
    description: '读取并整理本地 Markdown 知识库，用搜索、标签和时效提醒提高学习效率。',
    type: 'website',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: '知序 · 高效学习与快速整理' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '知序 · 高效学习与笔记整理',
    description: '读取并整理本地 Markdown 知识库，用搜索、标签和时效提醒提高学习效率。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
