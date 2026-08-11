import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // GitHub Pages serves this as a project site at /Blog/, so the production build needs that
  // prefix baked in. Locally (`npm run dev`) there's no such prefix — serve at '/' so the LAN
  // URL printed by `npm run dev:lan` (e.g. http://192.168.x.x:5173/) works as-is on a phone,
  // no "/Blog/" to remember or mistype.
  base: command === 'build' ? '/Blog/' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}));
