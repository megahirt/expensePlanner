import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Pass 1 of 2: the React app page and the MV3 service worker, both as ES modules.
// The content script is built separately (vite.content.config.ts) because content
// scripts cannot load code-split chunks.
export default defineConfig({
  // Relative asset URLs so the page works from the chrome-extension:// origin
  // regardless of how Chrome resolves the extension root.
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome110',
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'app.html'),
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        // Stable, predictable filenames: the manifest references these by path.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
