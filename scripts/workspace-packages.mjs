import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const WORKSPACE_GROUPS = ['ui', 'backend', 'shared', 'libraries', 'apps', 'tools'];

export function workspacePackages(root) {
    return WORKSPACE_GROUPS.flatMap(group => {
        const parent = resolve(root, group);
        if (!existsSync(parent)) return [];
        return readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
            if (!entry.isDirectory()) return [];
            const directory = resolve(parent, entry.name), file = resolve(directory, 'package.json');
            if (!existsSync(file)) return [];
            const manifest = JSON.parse(readFileSync(file, 'utf8'));
            return [{ ...manifest, directory, group }];
        });
    });
}

function importEntry(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return;
    return importEntry(value.import ?? value.default ?? value.types);
}

export function sourceExports(manifest) {
    const exports = manifest.exports ?? { '.': manifest.module ?? manifest.main };
    const entries = typeof exports === 'string' ? { '.': exports } : exports;
    return Object.entries(entries).flatMap(([subpath, value]) => {
        const entry = importEntry(value);
        return entry ? [[manifest.name + (subpath === '.' ? '' : subpath.slice(1)), entry]] : [];
    });
}
