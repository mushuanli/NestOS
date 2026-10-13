import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import { workspaceAliases, workspaceExcludes, REGISTRY_PREBUNDLES } from '../../scripts/workspace-sources.mjs';

export default defineConfig({
    base: './',
    plugins: [{
        name: 'mindos-web-shell',
        transformIndexHtml: { order: 'pre', handler() {
            const source = createRequire(import.meta.url).resolve('mind-os/index.html');
            return readFileSync(source, 'utf8')
                .replace('<head>', '<head>\n<link rel="icon" href="data:,">')
                .replace('src/styles/index.css', './src/style.css')
                .replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]+>/g, '');
        } },
    }],
    resolve: {
        alias: workspaceAliases(__dirname),
        dedupe: ['@codemirror/state', '@codemirror/view'],
    },
    // Open pages may still import lazy chunks from the previous build.
    build: { target: 'esnext', emptyOutDir: false },
    optimizeDeps: { exclude: workspaceExcludes(), include: REGISTRY_PREBUNDLES },
});
