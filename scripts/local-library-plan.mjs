import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import state from './local-library-state.mjs';

export const excluded = new Set(['node_modules', 'dist', '.git', 'target', 'coverage', '.vite', 'release']);
export function sourceHash(directory, digest = createHash('sha256'), prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (excluded.has(entry.name)) continue;
        const file = join(directory, entry.name), name = prefix + '/' + entry.name;
        digest.update(name + '\0');
        if (entry.isDirectory()) sourceHash(file, digest, name);
        else if (entry.isFile()) digest.update(readFileSync(file));
        else throw new Error(`LOCAL_LIBRARIES_SOURCE_TYPE: unsupported entry ${name}`);
        digest.update('\0');
    }
    return prefix ? digest : digest.digest('hex');
}

export function buildHash(root) {
    const digest = createHash('sha256');
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
        'scripts/library-artifacts.mjs', 'scripts/npm-libraries.mjs', 'scripts/local-library-build.mjs', 'scripts/local-library-plan.mjs']) {
        digest.update(file + '\0'); digest.update(readFileSync(join(root, file))); digest.update('\0');
    }
    return digest.digest('hex');
}

export function preparedSnapshot(root) {
    const file = join(state.localRoot(root), 'prepared.json');
    if (!existsSync(file)) return state.readSelection(root);
    const prepared = JSON.parse(readFileSync(file, 'utf8'));
    if (prepared.format !== 1) throw new Error('LOCAL_LIBRARIES_PREPARED_FORMAT: invalid prepared selection');
    return state.readSnapshot(root, prepared.id);
}

function dependencies(manifest, catalog) {
    return [...new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .flatMap(field => Object.keys(manifest[field] ?? {})))].filter(name => name !== manifest.name && catalog.some(item => item.name === name)).sort();
}
function sourceRecord(root, library, catalog, hash) {
    const directory = join(root, 'libraries', library.directory);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== library.name) throw new Error(`LOCAL_LIBRARIES_SOURCE_IDENTITY: ${library.name}`);
    return { ...library, version: manifest.version, sourceHash: sourceHash(directory), buildHash: hash,
        libraryDependencies: dependencies(manifest, catalog) };
}
function baseRecords(base, catalog) {
    return catalog.map(library => {
        const previous = base.packages.find(item => item.name === library.name);
        if (previous.libraryDependencies) return { ...previous, directory: library.directory };
        const manifest = JSON.parse(execFileSync('tar', ['-xOf', join(base.directory, previous.file), 'package/package.json'], { encoding: 'utf8' }));
        return { ...previous, directory: library.directory, libraryDependencies: dependencies(manifest, catalog) };
    });
}
function selectDependents(root, records, selected, catalog, hash) {
    let added = true;
    while (added) {
        added = false;
        for (let index = 0; index < records.length; index++) {
            if (selected.has(records[index].name) || !records[index].libraryDependencies.some(name => selected.has(name))) continue;
            selected.add(records[index].name);
            records[index] = sourceRecord(root, records[index], catalog, hash);
            added = true;
        }
    }
}

export function planSnapshot(root, catalog, { base = null, requested, full = false } = {}) {
    const target = requested && catalog.find(item => item.name === requested || item.directory === requested);
    if (requested && !target) throw new Error(`LOCAL_LIBRARIES_UNKNOWN: ${requested}; use a library name, not a snapshot ID`);
    const hash = buildHash(root), records = base ? baseRecords(base, catalog) : [];
    const selected = new Set();
    for (const library of catalog) {
        const index = catalog.indexOf(library), previous = records[index];
        const inspect = full || !base || !requested || library.name === target.name;
        if (!inspect || (base && !full && !requested && !existsSync(join(root, 'libraries', library.directory, 'package.json')))) continue;
        const current = sourceRecord(root, library, catalog, hash);
        if (full || !base || requested || previous.sourceHash !== current.sourceHash || previous.buildHash !== hash) {
            records[index] = current; selected.add(library.name);
        }
    }
    selectDependents(root, records, selected, catalog, hash);
    return { base, records, selected: [...selected], buildHash: hash };
}
