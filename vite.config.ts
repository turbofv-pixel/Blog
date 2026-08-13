import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  // `vite preview` reports the same command ('serve') as `vite dev` — there's no separate
  // 'preview' value here — but it serves the actual dist/ build, whose index.html already has
  // '/Blog/'-prefixed asset paths baked in from the `vite build` step. So `command` alone can't
  // tell dev and preview apart; check argv for the one bit that does.
  const isPreview = process.argv.includes('preview');
  return {
    // GitHub Pages serves this as a project site at /Blog/, so the production build (and
    // anything serving that build, i.e. preview) needs that prefix. Only the plain dev server
    // has no such prefix — serve it at '/' so the LAN URL printed by `npm run dev:lan` (e.g.
    // http://192.168.x.x:5173/) works as-is on a phone, no "/Blog/" to remember or mistype.
    base: command === 'build' || isPreview ? '/Blog/' : '/',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
