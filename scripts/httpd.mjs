#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hostArguments, hostEnvironment, runtimePaths, runtimeLog, releaseDirectory, verifyRelease } from './httpd-runtime.mjs';
import { buildHttpRelease } from './httpd-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(root, 'apps/http-app'), releases = path.join(root, 'release/httpd');
const developmentUI = path.join(root, 'release/httpd-dev/dist');
function run(command, args, cwd = root, env = process.env) { execFileSync(command, args, { cwd, stdio: 'inherit', env }); }
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
        env: { ...hostEnvironment(), INIT_CWD: root, NESTOS_HTTPD_MODE: mode, NESTOS_HTTPD_VERSION: id } });
    child.stdout.on('data', chunk => { output.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output.write(chunk); process.stderr.write(chunk); });
    let stopping = false;
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) process.on(signal, () => { if (!stopping) { stopping = true; child.kill(signal); } });
    child.once('error', error => { output.close(); console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { output.close(); process.exitCode = code ?? (signal ? 1 : 0); });
}
const [command = 'start', ...args] = process.argv.slice(2);
try {
    if (command === 'build') {
        run(process.execPath, [path.join(root, 'scripts/local-libraries.mjs'), 'build']);
        const id = buildHttpRelease(root, {cache: !args.includes('--no-cache'), activate: args.includes('--no-activate') ? undefined : activate});
        console.log(`HTTP release ready: ${id}\nStart: pnpm httpd\nDevelopment: pnpm httpd:dev`);
    }
    else if (command === 'dev') serve('dev', args);
    else if (command === 'start') serve('release', args);
    else if (command === 'activate' && args[0]) activate(args[0]);
    else if (command === 'list') {
        for (const entry of readdirSync(releases)) if (!entry.startsWith('.') && entry !== 'current.json') console.log(entry);
    }
    else throw new Error('Usage: httpd.mjs build | start [httpd options] | dev [httpd options] | list | activate <release-id>');
} catch (error) {
    console.error(error.code === 'ENOENT' && command === 'start' ? 'No HTTP release found. Run pnpm httpd:build first.' : error.message); process.exitCode = 1;
}
