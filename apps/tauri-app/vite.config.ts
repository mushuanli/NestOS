import { defineConfig } from 'vite';
import path from 'path';
import { builtinModules } from 'node:module';
import { workspaceAliases, workspaceExcludes } from '../../scripts/workspace-sources.mjs';

export default defineConfig({
    base: './',
    plugins: [{
        name: 'trace-tauri-relative-core',
        enforce: 'pre',
        transform(code, id) {
            if (!id.replaceAll('\\', '/').endsWith('/@tauri-apps/api/core.js')) return;
            const entry = 'return window.__TAURI_INTERNALS__.invoke(cmd, args, options);';
            if (code.split(entry).length !== 2) throw new Error('Tauri core invoke changed; update IPC instrumentation');
            const counter = JSON.stringify(path.resolve(__dirname, 'src/log/ipc-counter-state.ts'));
            return { code: `import { ipcCounter as __mindosIpc } from ${counter};\n` + code.replace(entry,
                `if (import.meta.env.VITE_MINDOS_TRACE === '1') __mindosIpc.record(cmd);\n    ${entry}`), map: null };
        },
        resolveId(source, importer) {
            if (source === './core.js' && importer?.replaceAll('\\', '/').includes('/@tauri-apps/api/')) {
                return path.resolve(__dirname, 'src/log/traced-core.ts');
            }
        },
    }],

    resolve: {
        alias: [
            // The local driver's Node fallback is unreachable after native port injection.
            { find: /^better-sqlite3$/, replacement: path.resolve(__dirname, 'src/db/node-sqlite-unavailable.ts') },
            { find: '@tauri-apps/api/core', replacement: path.resolve(__dirname, 'src/log/traced-core.ts') },
            // Workspace packages resolve to source: one copy in the dev graph, HMR-friendly.
            // The list (and the CSS subpath entries) is shared with the web app so the two dev
            // graphs cannot drift apart again — see scripts/workspace-sources.mjs.
            ...workspaceAliases(__dirname),
        ],
    },

    server: {
        port:       1420,
        strictPort: true,
    },

    build: {
        // Keep fonts as same-origin files accepted by the desktop font-src policy.
        assetsInlineLimit: 0,
        target:    'es2021',
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
        rollupOptions: {
            // Keep both prefixed and unprefixed Node built-ins external.
            // Tauri always injects createFs/createDb. Node filesystem modules stay
            // unreachable, and the SQLite fallback resolves to the explicit webview guard.
            external: (id: string) =>
                id.startsWith('node:') || builtinModules.includes(id),
        },
    },

    optimizeDeps: {
        exclude: ['better-sqlite3', ...workspaceExcludes()],
    },
});
