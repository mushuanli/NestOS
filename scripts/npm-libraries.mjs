import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const libraries = JSON.parse(readFileSync(new URL('./npm-libraries.json', import.meta.url), 'utf8'));
export const versions = new Map(libraries.map(library => [library.name, library.version]));
export const releaseRoot = resolve(root, 'release/npm-libraries');
export const libraryRoot = resolve(root, 'libraries');

export function releaseManifest(manifest, version) {
    const result = { ...manifest, ...manifest.publishConfig, version };
    delete result.publishConfig;
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
        if (!result[section]) continue;
        result[section] = Object.fromEntries(Object.entries(result[section]).map(([name, spec]) => [name, versions.get(name) ?? spec]));
    }
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const spec of Object.values(result[section] ?? {})) {
            if (/^(workspace:|link:|file:)/.test(spec)) throw new Error(`Non-registry dependency: ${spec}`);
        }
    }
    return result;
}
