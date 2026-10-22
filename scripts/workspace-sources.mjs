import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceExports, workspacePackages } from './workspace-packages.mjs';
import state from './local-library-state.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourcePackages = (repository, snapshot = state.readSelection(repository)) => workspacePackages(repository, { includeLibraries: !snapshot })
    .filter(pkg => pkg.group !== 'apps' && pkg.exports && !(snapshot && pkg.group === 'libraries'));

export const WORKSPACE_SOURCES = sourcePackages(root).map(pkg => [pkg.name, path.relative(root, pkg.directory) + '/src/index.ts']);

/** Exact public exports keep roots, contracts and CSS on the same workspace copy. */
export function workspaceAliases(appDir) {
    const repository = path.resolve(appDir, '../..');
    return sourcePackages(repository).flatMap(pkg =>
        sourceExports(pkg).map(([specifier, entry]) => ({
            find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            replacement: path.resolve(pkg.directory, entry),
        })));
}

export function workspaceExcludes() {
    return sourcePackages(root).map(pkg => pkg.name);
}
