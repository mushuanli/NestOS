#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hostArguments, hostEnvironment, runtimePaths, runtimeLog, releaseDirectory, verifyRelease, freezeWorkspaceDependencies, sourceFiles, sourceFingerprint, copySource } from './httpd-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(root, 'apps/http-app'), releases = path.join(root, 'release/httpd');
const developmentUI = path.join(root, 'release/httpd-dev/dist');
function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit' }); }
function git(args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function hashes(directory, relative = '') {
    return readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
        const file = path.join(relative, entry.name);
        return entry.isDirectory() ? hashes(directory, file) : [{ file, sha256: createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex') }];
    });
}
function assertDependencies(directory, snapshot, visited = new Set()) {
    const actual = realpathSync(directory); if (visited.has(actual)) return; visited.add(actual);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (lstatSync(file).isSymbolicLink()) {
            const relative = path.relative(snapshot, realpathSync(file));
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                throw new Error(`Release dependency points outside its snapshot: ${file}`);
            }
        } else if (entry.isDirectory()) assertDependencies(file, snapshot, visited);
    }
}

function build() {
    mkdirSync(releases, { recursive: true });
    const commit = git(['rev-parse', 'HEAD']), dirty = Boolean(git(['status', '--porcelain']));
    const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '-' + commit.slice(0, 8) + (dirty ? '-dirty' : '');
    const destination = releaseDirectory(releases, id), staging = path.join(releases, '.building-' + randomUUID());
    const source = path.join(releases, '.source-' + randomUUID()), inputs = sourceFiles(root), fingerprint = sourceFingerprint(root, inputs);
    try {
        copySource(root, source, inputs);
        run('pnpm', ['--config.package-import-method=copy', '--ignore-scripts', '--filter', '@itookit/http-app', 'deploy', '--prod', '--legacy', staging], source);
        freezeWorkspaceDependencies(staging);
        for (const entry of readdirSync(staging)) if (!['package.json', 'node_modules'].includes(entry)) rmSync(path.join(staging, entry), { recursive: true, force: true });
        run('pnpm', ['exec', 'vite', 'build', '--outDir', path.join(staging, 'dist'), '--emptyOutDir'], app);
        run('pnpm', ['exec', 'tsup', 'src/server/main.ts', '--format', 'esm', '--platform', 'node', '--out-dir', path.join(staging, 'server'), '--splitting', '--clean'], app);
        assertDependencies(path.join(staging, 'node_modules'), staging);
        run(process.execPath, [path.join(staging, 'server/main.js'), '--help'], staging);
        if (fingerprint !== sourceFingerprint(root)) throw new Error('Source changed during the build. Retry after saving your changes.');
        const files = [...hashes(staging, 'server'), ...hashes(staging, 'dist')];
        writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ id, commit, dirty, builtAt: new Date().toISOString(),
            nodeMajor: Number(process.versions.node.split('.')[0]), files }, null, 2) + '\n');
        renameSync(staging, destination); activate(id);
        console.log(`HTTP release ready: ${id}\nStart: pnpm httpd\nDevelopment: pnpm httpd:dev`);
    } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
    finally { rmSync(source, { recursive: true, force: true }); }
}
function activate(id) {
    verifyRelease(releaseDirectory(releases, id));
    const temporary = path.join(releases, '.current-' + randomUUID());
    writeFileSync(temporary, JSON.stringify({ id }) + '\n'); renameSync(temporary, path.join(releases, 'current.json'));
}
function serve(mode, args) {
    let id = 'working-tree', directory = app, entry = path.join(app, 'src/server/main.ts');
    if (mode === 'release') {
        id = JSON.parse(readFileSync(path.join(releases, 'current.json'), 'utf8')).id;
        directory = releaseDirectory(releases, id); verifyRelease(directory); entry = path.join(directory, 'server/main.js');
    } else run('pnpm', ['exec', 'vite', 'build', '--outDir', developmentUI, '--emptyOutDir'], app);
    const command = process.execPath;
    const values = hostArguments(mode, args);
    const childArgs = mode === 'release' ? [entry, ...values] : ['--import', createRequire(path.join(app, 'package.json')).resolve('tsx'), entry, '--static', developmentUI, ...values];
    const file = runtimePaths(mode).runtime, output = runtimeLog(file);
    const banner = `HTTP mode: ${mode}\nVersion: ${id}\nRuntime log: ${file}`; console.log(banner); output.write(Buffer.from(banner + '\n'));
    const child = spawn(command, childArgs, { cwd: directory, stdio: ['inherit', 'pipe', 'pipe'], detached: true,
        env: { ...hostEnvironment(), INIT_CWD: root, MINDOS_HTTPD_MODE: mode, MINDOS_HTTPD_VERSION: id } });
    child.stdout.on('data', chunk => { output.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output.write(chunk); process.stderr.write(chunk); });
    let stopping = false;
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) process.on(signal, () => { if (!stopping) { stopping = true; child.kill(signal); } });
    child.once('error', error => { output.close(); console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { output.close(); process.exitCode = code ?? (signal ? 1 : 0); });
}
try {
    const [command = 'start', ...args] = process.argv.slice(2);
    if (command === 'build') build();
    else if (command === 'dev') serve('dev', args);
    else if (command === 'start') serve('release', args);
    else if (command === 'activate' && args[0]) activate(args[0]);
    else if (command === 'list') {
        for (const entry of readdirSync(releases)) if (!entry.startsWith('.') && entry !== 'current.json') console.log(entry);
    }
    else throw new Error('Usage: httpd.mjs build | start [httpd options] | dev [httpd options] | list | activate <release-id>');
} catch (error) {
    console.error(error.code === 'ENOENT' ? 'No HTTP release found. Run pnpm httpd:build first.' : error.message); process.exitCode = 1;
}
