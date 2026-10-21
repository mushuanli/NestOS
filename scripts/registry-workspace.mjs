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
    for (const name of ['apps', 'ui', 'backend', 'shared', 'scripts', 'tsconfig.base.json']) {
        const source = join(repository, name);
        if (existsSync(source)) cpSync(source, join(destination, name), { recursive: true,
            filter: file => !excluded.has(basename(file)) && !basename(file).startsWith('.env.') });
    }
    const root = registryManifest(JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')), catalog);
    delete root.scripts.preinstall;
    writeFileSync(join(destination, 'package.json'), JSON.stringify(root, null, 4) + '\n');
    for (const pkg of workspacePackages(repository).filter(pkg => pkg.group !== 'libraries')) {
        const path = join(destination, pkg.group, basename(pkg.directory), 'package.json');
        if (pkg.group === 'tools') cpSync(pkg.directory, join(destination, pkg.group, basename(pkg.directory)), {recursive: true, filter: file => !excluded.has(basename(file)) && !basename(file).startsWith('.env.')});
        const { directory, group, ...manifest } = pkg;
        void directory; void group;
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
    writeFileSync(join(destination, 'pnpm-workspace.yaml'), pinned);
}
