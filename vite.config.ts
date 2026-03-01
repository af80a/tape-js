import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'tape-processor': resolve(__dirname, 'src/worklet/tape-processor.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'tape-processor') {
            return 'worklets/tape-processor.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
