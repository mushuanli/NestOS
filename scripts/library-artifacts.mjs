import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { releaseManifest } from './npm-libraries.mjs';

export function artifactHash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

export function validateExports(value, directory) {
    if (typeof value === 'string') {
        const target = resolve(directory, value);
        if (!value.startsWith('./') || relative(directory, target).startsWith('..') || !existsSync(target)) throw new Error(`Missing export: ${value}`);
    } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) validateExports(child, directory);
    }
}

/** Shared by public releases and immutable local snapshots. No publishing occurs here. */
export function packBuiltLibrary(library, source, output, dependencyVersions) {
    const staging = join(output, 'staging', library.directory);
    const manifest = releaseManifest(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')), library.version, dependencyVersions);
    if (manifest.name !== library.name || manifest.private) throw new Error(`Invalid release identity: ${library.name}`);
    rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
    cpSync(join(source, 'dist'), join(staging, 'dist'), { recursive: true });
    for (const name of ['README.md', 'LICENSE', 'docs']) if (existsSync(join(source, name))) cpSync(join(source, name), join(staging, name), { recursive: true });
    validateExports(manifest.exports, staging);
    for (const field of ['main', 'module', 'types']) if (manifest[field]) validateExports(manifest[field], staging);
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { cwd: staging, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
    const tarball = join(output, `${library.name.replace('@', '').replace('/', '-')}-${library.version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`Missing tarball: ${tarball}`);
    return { ...library, tarball, sha256: artifactHash(tarball) };
}
