import { moduleSeparationPlugin } from '../../scripts/check-module-separation.mjs';
import {firstPaintStyles} from '../../scripts/first-paint.mjs';
import { httpBuildGraph } from '../../scripts/httpd-build-graph.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import { workspaceAliases, workspaceExcludes } from '../../scripts/workspace-sources.mjs';

export default defineConfig({
    base: './',
    plugins: [moduleSeparationPlugin('frontend'), {
        name: 'mindos-web-shell',
        transformIndexHtml: { order: 'pre', handler() {
            const source = createRequire(import.meta.url).resolve('mind-os/index.html');
            return readFileSync(source, 'utf8')
                .replace('<head>', '<head>\n<link rel="icon" href="data:,">')
                .replace('src/styles/index.css', './src/style.css')
                .replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]+>/g, '');
        } },
    }, firstPaintStyles(), httpBuildGraph()],
    resolve: {
        alias: workspaceAliases(__dirname),
        dedupe: ['@codemirror/state', '@codemirror/view'],
    },
    // Open pages may still import lazy chunks from the previous build.
    build: { target: 'esnext', emptyOutDir: false },
    optimizeDeps: { exclude: workspaceExcludes() },
});
