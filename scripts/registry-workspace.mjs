import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { libraries } from './npm-libraries.mjs';
import { workspacePackages } from './workspace-packages.mjs';

export function registryManifest(manifest, catalog = libraries) {
    const result = structuredClone(manifest), versions = new Map(catalog.map(library => [library.name, library.version]));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(result[section] ?? {})) {
            if (versions.has(name)) result[section][name] = versions.get(name);
        }
    }
    return result;
}

export function prepareRegistryWorkspace(repository, destination, catalog = libraries) {
    mkdirSync(destination, { recursive: true });
    const excluded = new Set(['node_modules', 'dist', 'dist-server', '.git', 'target', 'vendor', 'coverage', '.env']);
    for (const name of ['apps', 'packages', 'scripts', 'patches', 'tsconfig.base.json']) {
        const source = join(repository, name);
        if (existsSync(source)) cpSync(source, join(destination, name), { recursive: true,
            filter: file => resolve(file) !== resolve(repository, 'packages/mdx')
                && !excluded.has(basename(file)) && !basename(file).startsWith('.env.') });
    }
    const root = registryManifest(JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')), catalog);
    delete root.scripts.preinstall;
    writeFileSync(join(destination, 'package.json'), JSON.stringify(root, null, 4) + '\n');
    for (const pkg of workspacePackages(repository).filter(pkg => pkg.group !== 'libraries')) {
        const path = join(destination, pkg.group, basename(pkg.directory), 'package.json');
        const { directory, group, ...manifest } = pkg;
        writeFileSync(path, JSON.stringify(registryManifest(manifest, catalog), null, 2) + '\n');
    }
    writeRegistryConfig(repository, destination, catalog);
    const lock = resolve(repository, 'pnpm-lock.registry.yaml');
    if (existsSync(lock)) cpSync(lock, join(destination, 'pnpm-lock.yaml'));
    return destination;
}

function writeRegistryConfig(repository, destination, catalog) {
    const workspace = readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8').replace('  - libraries/*\n', '');
    const pinned = workspace.replace(/^(\s+)"(@itookit\/[^\"]+)": "workspace:\*"$/gm, (line, indent, name) => {
        const library = catalog.find(library => library.name === name);
        return library ? `${indent}"${name}": "${library.version}"` : line;
    });
    // Registry patches are applied only in this isolated installation.
    const patches = catalog.filter(library => existsSync(join(repository, 'patches', `${library.name.replace('/', '__')}@${library.version}.patch`)));
    const patchConfig = patches.map(library => `  '${library.name}@${library.version}': patches/${library.name.replace('/', '__')}@${library.version}.patch`);
    writeFileSync(join(destination, 'pnpm-workspace.yaml'), pinned + (patchConfig.length ? '\npatchedDependencies:\n' + patchConfig.join('\n') + '\n' : ''));
}
