#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { libraries, root, libraryRoot, releaseRoot, releaseManifest } from './npm-libraries.mjs';

function run(command, args, cwd = root) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function validateExports(value, directory) {
    if (typeof value === 'string') {
        if (!value.startsWith('./') || !existsSync(resolve(directory, value))) throw new Error(`Missing export: ${value}`);
    } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) validateExports(child, directory);
    }
}
function preparePackage(library, sourceRoot) {
    const candidate = resolve(sourceRoot, library.directory);
    const source = !existsSync(candidate) && library.workspace ? join(libraryRoot,library.directory) : candidate;
    const staging = join(releaseRoot, library.directory);
    process.stdout.write(`Building ${library.name}\n`);
    writeFileSync(join(releaseRoot, `${library.directory}.build.log`), run('pnpm', ['build'], source));
    const manifest = releaseManifest(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')), library.version);
    if (manifest.name !== library.name || manifest.private) throw new Error(`Invalid release identity: ${library.name}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(join(source, 'dist'), join(staging, 'dist'), { recursive: true });
    for (const name of ['README.md', 'LICENSE', 'docs']) if (existsSync(join(source, name))) cpSync(join(source, name), join(staging, name), { recursive: true });
    validateExports(manifest.exports, staging);
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', releaseRoot], staging);
    const tarball = join(releaseRoot, `${library.name.replace('@', '').replace('/', '-')}-${library.version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`Missing tarball: ${tarball}`);
    return { ...library, tarball, sha256: sha256(tarball) };
}
function prepare(sourceRoot, packageName) {
    mkdirSync(releaseRoot, { recursive: true });
    const selected = packageName ? libraries.filter(library => library.name === packageName) : libraries;
    if (!selected.length) throw new Error(`Unknown release package: ${packageName}`);
    const prepared = selected.map(library => preparePackage(library, sourceRoot));
    const index = join(releaseRoot,'artifacts.json');
    const previous = packageName && existsSync(index) ? JSON.parse(readFileSync(index,'utf8')) : [];
    const artifacts = [...previous.filter(item => libraries.some(library => library.name === item.name && library.version === item.version)
        && !selected.some(library => library.name === item.name)),...prepared];
    writeFileSync(join(releaseRoot, 'artifacts.json'), JSON.stringify(artifacts, null, 2) + '\n');
    process.stdout.write(`Prepared ${prepared.length} packages in ${releaseRoot}\n`);
}
function publish() {
    run('npm', ['whoami']);
    const artifacts = JSON.parse(readFileSync(join(releaseRoot, 'artifacts.json'), 'utf8'));
    for (const artifact of artifacts) {
        if (sha256(artifact.tarball) !== artifact.sha256) throw new Error(`Artifact changed: ${artifact.name}`);
        process.stdout.write(`Publishing ${artifact.name}@${artifact.version}\n`);
        execFileSync('npm', ['publish', artifact.tarball, '--access', 'public'], { cwd: root, stdio: 'inherit' });
    }
}
const command = process.argv[2];
try {
    if (command === 'prepare') prepare(resolve(process.argv[3] ?? libraryRoot),process.argv[4]);
    else if (command === 'publish') publish();
    else throw new Error('Usage: node scripts/release-npm-libraries.mjs prepare [source-root] [package-name] | publish');
} catch (error) {
    process.stderr.write((error.stderr?.toString() || error.message) + '\n');
    process.exitCode = 1;
}
