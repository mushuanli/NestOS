#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { libraries, root, libraryRoot, releaseRoot } from './npm-libraries.mjs';
import { packBuiltLibrary, artifactHash as sha256 } from './library-artifacts.mjs';

function run(command, args, cwd = root) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}
function preparePackage(library, sourceRoot) {
    const candidate = resolve(sourceRoot, library.directory);
    const source = !existsSync(candidate) && library.workspace ? join(libraryRoot,library.directory) : candidate;
    process.stdout.write(`Building ${library.name}\n`);
    writeFileSync(join(releaseRoot, `${library.directory}.build.log`), run('pnpm', ['build'], source));
    return packBuiltLibrary(library, source, releaseRoot);
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
