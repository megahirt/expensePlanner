import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Pass 2 of 2: the Amazon content script. Built as a single self-contained IIFE
// because Chrome content scripts have no module loader — a code-split chunk would
// simply fail to load at runtime with no visible error.
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false, // pass 1 already populated dist/
    sourcemap: true,
    target: 'chrome110',
    lib: {
      entry: resolve(__dirname, 'src/content/amazon.ts'),
      name: 'expensePlannerAmazon',
      formats: ['iife'],
      fileName: () => 'content-amazon.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true, extend: true } },
  },
});
