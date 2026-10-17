import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceAliases } from './workspace-sources.mjs';
import { moduleSeparationPlugin } from './check-module-separation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = ['app-shell', 'app-settings', 'llm-ui', 'llm-ui-adapter', 'llm-settings-ui', 'mdx-adapter', 'ui-common', 'vfs-ui', 'mdxeditor'];

// Build every frontend public root together without writing or executing the bundle.
await build({
    configFile: false,
    root: resolve(root, 'apps/http-app'),
    plugins: [moduleSeparationPlugin('frontend')],
    resolve: { alias: workspaceAliases(resolve(root, 'apps/http-app')), dedupe: ['@codemirror/state', '@codemirror/view'] },
    build: {
        write: false,
        target: 'esnext',
        minify: false,
        lib: { entry: Object.fromEntries(names.map(name => [name, resolve(root, ['vfs-ui', 'mdxeditor', 'llm-ui'].includes(name) ? 'libraries' : 'ui', name, 'src/index.ts')])), formats: ['es'] },
    },
});
process.stdout.write('All frontend public roots build without backend implementations.\n');
