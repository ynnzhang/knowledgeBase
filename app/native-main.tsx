import { createRoot } from 'react-dom/client';
import Home from './page';
import '@mdxeditor/editor/style.css';
import './globals.css';
createRoot(document.getElementById('root')!).render(<Home />);
