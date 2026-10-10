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
                .replace('src/styles/index.css', './src/style.css')
                .replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]+>/g, '');
        } },
    }],
    resolve: {
        alias: workspaceAliases(__dirname),
        dedupe: ['@codemirror/state', '@codemirror/view'],
    },
    build: { target: 'esnext' },
    optimizeDeps: { exclude: workspaceExcludes(), include: REGISTRY_PREBUNDLES },
});
