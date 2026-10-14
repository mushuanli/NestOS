// @file: llm-runtime/vite.config.ts

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      rollupTypes: true
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'LLMEngine',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`
    },
    rollupOptions: {
      external: [
        '@itookit/driver-llm',
        '@itookit/vfs'
      ],
      output: {
        globals: {
          '@itookit/driver-llm': 'LLMDriver',
          '@itookit/vfs': 'VFSCore'
        }
      }
    },
    sourcemap: true,
    minify: false
  }
});
