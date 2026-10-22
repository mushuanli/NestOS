import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceAliases } from './workspace-sources.mjs';
import { moduleSeparationPlugin } from './check-module-separation.mjs';
import { readFileSync } from 'node:fs';
import state from './local-library-state.mjs';
import { sourceExports, workspacePackages } from './workspace-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = ['app-shell', 'app-settings', 'llm-ui', 'llm-ui-adapter', 'llm-settings-ui', 'mdx-adapter', 'ui-common', 'vfs-ui', 'mdxeditor'];
const snapshot = state.readSelection(root);
function entry(name) {
    const library = ['vfs-ui', 'mdxeditor', 'llm-ui'].includes(name);
    if (library && snapshot) {
        const specifier = `@itookit/${name}`;
        const consumer = workspacePackages(root).find(pkg => pkg.group !== 'libraries' && pkg.dependencies?.[specifier]);
        if (!consumer) throw new Error(`No frontend consumer declares ${specifier}`);
        const directory = resolve(consumer.directory, 'node_modules', specifier);
        const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
        return resolve(directory, sourceExports(manifest).find(([key]) => key === specifier)[1]);
    }
    return resolve(root, library ? 'libraries' : 'ui', name, 'src/index.ts');
}

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
        lib: { entry: Object.fromEntries(names.map(name => [name, entry(name)])), formats: ['es'] },
    },
});
process.stdout.write('All frontend public roots build without backend implementations.\n');
