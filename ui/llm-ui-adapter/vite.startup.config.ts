import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: { entry: resolve(__dirname, 'src/startup.ts'), formats: ['es'], fileName: () => 'startup.js' },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: { external: id => !id.startsWith('.') && !id.startsWith('/') },
  },
});
