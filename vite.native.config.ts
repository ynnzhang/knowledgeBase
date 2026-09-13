import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localApiPort } from './scripts/local-config.mjs';
export default defineConfig({
  plugins: [react()], publicDir: false,
  build: { outDir: 'dist/native-ui', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 3000, strictPort: true, proxy: { '/local-api': { target: `http://127.0.0.1:${localApiPort}`, changeOrigin: true } } },
});
