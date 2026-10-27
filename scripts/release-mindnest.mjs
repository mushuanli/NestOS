#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync, realpathSync} from 'node:fs';
import {createRequire, isBuiltin} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildHttpRelease} from './httpd-build.mjs';
import {artifactHash} from './library-artifacts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), output = path.join(root, 'release/npm-mindnest');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function dependencyVersions(release) {
    const imports = read(path.join(release, 'server/runtime-dependencies.json'));
    const require = createRequire(path.join(release, 'package.json')), result = {};
    for (const specifier of imports) {
        if (isBuiltin(specifier) || specifier.startsWith('.')) continue;
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (name.startsWith('@itookit/')) throw new Error(`Unbundled workspace dependency: ${name}`);
        let directory = path.dirname(realpathSync(require.resolve(specifier)));
        while (!existsSync(path.join(directory, 'package.json')) || read(path.join(directory, 'package.json')).name !== name) {
            const parent = path.dirname(directory); if (parent === directory) throw new Error(`Missing runtime package: ${name}`); directory = parent;
        }
        result[name] = read(path.join(directory, 'package.json')).version;
    }
    return result;
}
function prepare() {
    execFileSync('pnpm', ['lib:build'], {cwd: root, stdio: 'inherit'});
    const id = buildHttpRelease(root), release = path.join(root, 'release/httpd', id), staging = path.join(output, 'package');
    const template = path.join(root, 'apps/http-app/npm'), manifest = read(path.join(template, 'package.json'));
    manifest.dependencies = dependencyVersions(release);
    rmSync(staging, {recursive: true, force: true}); mkdirSync(staging, {recursive: true});
    for (const folder of ['server', 'dist']) cpSync(path.join(release, folder), path.join(staging, folder), {recursive: true});
    for (const item of ['bin', 'README.md', 'LICENSE']) cpSync(path.join(template, item), path.join(staging, item), {recursive: true});
    cpSync(path.join(release, 'release.json'), path.join(staging, 'release.json'));
    writeFileSync(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    chmodSync(path.join(staging, 'bin/mindnest.mjs'), 0o755);
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], {cwd: staging, stdio: 'inherit'});
    const tarball = path.join(output, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
    writeFileSync(path.join(output, 'artifact.json'), JSON.stringify({name: manifest.name, version: manifest.version, tarball, sha256: artifactHash(tarball), releaseId: id}, null, 2) + '\n');
    console.log(`Prepared ${manifest.name}@${manifest.version}: ${tarball}`);
}
function publish() {
    const artifact = read(path.join(output, 'artifact.json'));
    if (artifactHash(artifact.tarball) !== artifact.sha256) throw new Error('MindNest tarball changed after preparation');
    execFileSync('npm', ['publish', artifact.tarball, '--access', 'public', '--registry', 'https://registry.npmjs.org/'], {cwd: root, stdio: 'inherit'});
}
try {
    if (process.argv[2] === 'prepare') prepare();
    else if (process.argv[2] === 'publish') publish();
    else throw new Error('Usage: node scripts/release-mindnest.mjs prepare | publish');
} catch (error) {console.error(error.message); process.exitCode = 1;}
