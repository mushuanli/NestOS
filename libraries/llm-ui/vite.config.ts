import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'node:path';

export default defineConfig({
    build: {
        lib: { entry: resolve(__dirname, 'src/index.ts'), name: 'LLMUI', formats: ['es', 'umd'],
            fileName: format => `llm-ui.${format === 'es' ? 'js' : 'umd.cjs'}` },
        sourcemap: true, emptyOutDir: true, cssCodeSplit: false,
        rollupOptions: { external: ['@itookit/mdxeditor', './flow.js'], output: {
            globals: { '@itookit/mdxeditor': 'MDxEditor' },
            assetFileNames: asset => asset.name?.endsWith('.css') ? 'style.css' : '[name][extname]',
        } },
    },
    plugins: [dts({ entryRoot: 'src', outDir: 'dist', insertTypesEntry: true })],
});
