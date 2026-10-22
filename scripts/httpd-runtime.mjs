import path from 'node:path';
import os from 'node:os';
import { mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, existsSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readlinkSync } from 'node:fs';
import { cpSync, writeFileSync } from 'node:fs';
import libraryState from './local-library-state.mjs';

/** Capture Git inputs, including initialized library repositories, without build output. */
export function sourceFiles(root, prefix = '') {
    const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
    const snapshot = !prefix && libraryState.readSelection(root);
    return [...new Set(names)].sort().flatMap(name => {
        if (snapshot && (name === 'libraries' || name.startsWith('libraries/'))) return [];
        const file = path.join(root, name), relative = path.join(prefix, name);
        if (!existsSync(file)) return [];
        if (lstatSync(file).isDirectory()) return existsSync(path.join(file, '.git')) ? sourceFiles(file, relative) : [];
        return [relative];
    });
}
/** Carry the selected artifacts into the release capture, with no live library sources. */
export function copyLibrarySnapshot(root, destination, snapshot = libraryState.readSelection(root)) {
    if (!snapshot) return;
    const target = path.join(libraryState.localRoot(destination), 'snapshots', snapshot.id);
    cpSync(snapshot.directory, target, { recursive: true });
    writeFileSync(libraryState.activeFile(destination), JSON.stringify({ format: 1, mode: 'snapshot', id: snapshot.id }));
}
/** Explicit host providers prevent injected peers from being resolved through the registry. */
export function pinSnapshotDependencies(file, snapshot) {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, ...libraryState.snapshotOverrides(snapshot) };
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
/** Deployment skips lifecycle scripts; preserve the verified host-native build outputs. */
export function copyNativeRuntimes(source, destination, names = ['better-sqlite3', 'node-pty']) {
    for (const name of names) {
        const from = realpathSync(path.join(source, 'node_modules', name));
        const to = realpathSync(path.join(destination, 'node_modules', name));
        const original = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'));
        const deployed = JSON.parse(readFileSync(path.join(to, 'package.json'), 'utf8'));
        if (original.name !== deployed.name || original.version !== deployed.version) throw new Error(`NATIVE_RUNTIME_VERSION_MISMATCH: ${name} installed=${original.version} deployed=${deployed.version}`);
        const built = path.join(from, 'build/Release');
        if (existsSync(built)) cpSync(built, path.join(to, 'build/Release'), { recursive: true,
            filter: file => !['obj', 'obj.target', '.deps'].includes(path.basename(file)) && !file.endsWith('.o') });
    }
}
export function sourceFingerprint(root, files = sourceFiles(root)) {
    const hash = createHash('sha256');
    for (const file of files) {
        const target = path.join(root, file);
        hash.update(file + '\0');
        hash.update(lstatSync(target).isSymbolicLink() ? readlinkSync(target) : readFileSync(target)); hash.update('\0');
    }
    return hash.digest('hex');
}
export function copySource(root, destination, files = sourceFiles(root)) {
    for (const file of files) {
        const from = path.join(root, file), to = path.join(destination, file);
        mkdirSync(path.dirname(to), { recursive: true });
        if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
        else copyFileSync(from, to);
    }
}

export function runtimePaths(mode, env = process.env) {
    const config = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mindos');
    const logs = path.resolve(env.MINDOS_HTTPD_LOG_DIR || '/var/log/mindos'), prefix = mode === 'dev' ? 'httpd.debug' : 'httpd';
    return { config, logs, audit: path.join(logs, `${prefix}.audit.jsonl`), runtime: path.join(logs, `${prefix}.runtime.log`),
        auth: path.join(config, 'http-auth', mode), developmentRoot: path.join(config, 'http-dev', 'data') };
}
export function hostArguments(mode, args, env = process.env) {
    const paths = runtimePaths(mode, env);
    const values = [...args];
    const add = (name, value) => { if (!args.some(arg => arg === name || arg.startsWith(name + '='))) values.push(name, value); };
    add('--audit-file', paths.audit); add('--auth-dir', paths.auth);
    if (mode === 'dev') { add('--port', '2001'); add('--root', paths.developmentRoot); }
    return values;
}
/** Inherit system proxy settings while preserving an explicit Node proxy opt-out. */
export function hostEnvironment(env = process.env) {
    const values = { ...env };
    if (values.NODE_USE_ENV_PROXY === undefined
        && ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].some(name => values[name]?.trim()))
        values.NODE_USE_ENV_PROXY = '1';
    return values;
}
export function releaseDirectory(root, id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id) || id === '.' || id === '..') throw new Error('Invalid release ID');
    return path.join(root, id);
}
/** Legacy pnpm deploy leaves nested workspace links pointing back at the source tree. */
export function freezeWorkspaceDependencies(snapshot) {
    const store = path.join(snapshot, 'node_modules/.pnpm'), packages = new Map();
    const rootPackage = JSON.parse(readFileSync(path.join(snapshot, 'package.json'), 'utf8'));
    packages.set(rootPackage.name + '@' + rootPackage.version, snapshot);
    for (const entry of readdirSync(store, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules') continue;
        const modules = path.join(store, entry.name, 'node_modules'); if (!existsSync(modules)) continue;
        for (const name of readdirSync(modules)) {
            const base = path.join(modules, name);
            const paths = name.startsWith('@') ? readdirSync(base).map(child => path.join(base, child)) : [base];
            for (const candidate of paths) {
                if (lstatSync(candidate).isSymbolicLink() || !existsSync(path.join(candidate, 'package.json'))) continue;
                const pkg = JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8'));
                packages.set(pkg.name + '@' + pkg.version, candidate);
            }
        }
    }
    freezeLinks(path.join(snapshot, 'node_modules'), snapshot, packages);
}
function freezeLinks(directory, snapshot, packages) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (!lstatSync(file).isSymbolicLink()) { if (entry.isDirectory()) freezeLinks(file, snapshot, packages); continue; }
        const target = realpathSync(file), relative = path.relative(snapshot, target);
        if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) continue;
        const manifest = path.join(target, 'package.json');
        const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
        const local = packages.get(pkg.name + '@' + pkg.version);
        if (!local || !(pkg.name?.startsWith('@itookit/') || pkg.name === 'mind-os')) throw new Error(`External release dependency: ${file}`);
        rmSync(file); symlinkSync(path.relative(path.dirname(file), local), file, 'dir');
    }
}
export function verifyRelease(directory) {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8'));
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Release manifest is missing');
    for (const { file, sha256 } of manifest.files) {
        if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Invalid release path');
        if (createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex') !== sha256) throw new Error(`Release file changed: ${file}`);
    }
    if (manifest.nodeMajor !== Number(process.versions.node.split('.')[0])) throw new Error('Use the Node major version recorded in release.json');
    return manifest;
}
/** Bounded runtime output; audit metadata has its own server-owned JSONL writer. */
export function runtimeLog(file, limit = 10 * 1024 * 1024) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd = openSync(file, 'a', 0o600), size = statSync(file).size;
    return {
        write(chunk) {
            if (size && size + chunk.length > limit) {
                closeSync(fd);
                for (let i = 2; i >= 0; i--) {
                    const from = i ? `${file}.${i}` : file;
                    if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
                }
                fd = openSync(file, 'w', 0o600); size = 0;
            }
            writeSync(fd, chunk); size += chunk.length;
        },
        close() { closeSync(fd); },
    };
}
