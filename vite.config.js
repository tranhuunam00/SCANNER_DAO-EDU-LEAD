import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  build: {
    rollupOptions: {
      input: {
        popup: 'index.html',
      },
      output: {
        // Đặt tên cố định cho content scripts (không có hash)
        // để background.js có thể inject đúng đường dẫn
        entryFileNames: (chunkInfo) => {
          const name = chunkInfo.name.toLowerCase();
          if (name.includes('content')) {
            return 'assets/content.js';
          }
          if (name.includes('batch-queue')) {
            return 'assets/batch-queue.js';
          }
          if (name.includes('background')) {
            return 'assets/background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
