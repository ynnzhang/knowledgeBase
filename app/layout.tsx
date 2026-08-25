import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '知序 · 让知识保持新鲜',
  description: '本地优先的 Markdown 知识库阅读器，自动识别陈旧和过期笔记，提醒你及时复查。',
  openGraph: {
    title: '知序 · 让知识保持新鲜',
    description: '读取本地 Markdown 知识库，管理笔记时效性，让每条知识都值得信任。',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: '知序 · 让知识保持新鲜',
    description: '读取本地 Markdown 知识库，管理笔记时效性，让每条知识都值得信任。',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
