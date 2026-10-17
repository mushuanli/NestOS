import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({ build: {
    lib: { entry: resolve(__dirname, 'src/flow.ts'), formats: ['es'], fileName: () => 'flow.js' },
    emptyOutDir: false,
    rollupOptions: { external: ['@itookit/mdxeditor'], output: { assetFileNames: asset => asset.name?.endsWith('.css') ? 'flow.css' : '[name][extname]' } },
} });
