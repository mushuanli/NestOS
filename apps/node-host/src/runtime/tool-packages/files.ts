import {access, copyFile, lstat, mkdir, readdir, readFile, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {packageError, type ToolPackageSource} from './manifest';

export interface ExecutableBinding {env: string; path: string; source: 'environment' | 'path' | 'package'; relative?: string;}

export async function resolvePackageExecutables(source: ToolPackageSource, env: NodeJS.ProcessEnv): Promise<ExecutableBinding[]> {
    const bindings: ExecutableBinding[] = [];
    for (const executable of source.manifest.executables) {
        const configured = env[executable.env];
        if (configured) {
            const resolved = path.isAbsolute(configured) ? configured : configured.includes(path.sep)
                ? path.resolve(env.INIT_CWD || process.cwd(), configured) : await findOnPath(configured, env.PATH);
            if (!resolved || !await isExecutable(resolved)) throw packageError('TOOL_PACKAGE_EXECUTABLE_MISSING', `Configured executable ${executable.env} is unavailable`);
            bindings.push({env: executable.env, path: await realpath(resolved), source: 'environment'}); continue;
        }
        const existing = await findOnPath(executable.command, env.PATH);
        if (existing) {bindings.push({env: executable.env, path: existing, source: 'path'}); continue;}
        const fallback = path.join(source.root, executable.default);
        if (!await isExecutable(fallback)) throw packageError('TOOL_PACKAGE_EXECUTABLE_MISSING', `Executable ${executable.command} is unavailable; provide it on PATH or configure ${executable.env}`);
        await assertInside(source.root, fallback);
        bindings.push({env: executable.env, path: fallback, relative: executable.default, source: 'package'});
    }
    return bindings;
}

async function findOnPath(command: string, search = ''): Promise<string | undefined> {
    const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
    for (const directory of search.split(path.delimiter).filter(Boolean)) {
        if (!path.isAbsolute(directory)) continue;
        for (const suffix of suffixes) {
            const candidate = path.join(directory, command + suffix);
            if (await isExecutable(candidate)) return realpath(candidate);
        }
    }
}
async function isExecutable(file: string): Promise<boolean> {
    try {await access(file, constants.X_OK); return (await stat(file)).isFile();} catch {return false;}
}
async function assertInside(root: string, file: string): Promise<void> {
    const relative = path.relative(await realpath(root), await realpath(file));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw packageError('TOOL_PACKAGE_PATH_INVALID', 'Tool package entry leaves its package directory');
}

export async function packageFiles(source: ToolPackageSource, bindings: ExecutableBinding[] = []): Promise<string[]> {
    const files: string[] = [];
    const binaries = bindings.filter(binding => binding.source === 'package' && binding.relative).map(binding => binding.relative!);
    const entries = [...new Set(['mindos-tool.json', source.manifest.module, ...source.manifest.files, ...binaries])].sort();
    for (const entry of entries) await enumerate(source.root, entry, files);
    return [...new Set(files)].sort();
}
async function enumerate(root: string, relative: string, files: string[]): Promise<void> {
    const target = path.join(root, relative), entry = await lstat(target);
    if (entry.isSymbolicLink()) throw packageError('TOOL_PACKAGE_PATH_INVALID', 'Tool package files cannot contain symbolic links');
    await assertInside(root, target);
    if (entry.isFile()) {files.push(relative); return;}
    if (!entry.isDirectory()) throw packageError('TOOL_PACKAGE_PATH_INVALID', 'Unsupported package file type');
    for (const child of await readdir(target)) await enumerate(root, path.join(relative, child), files);
}

export async function packageFingerprint(source: ToolPackageSource, files: string[]): Promise<string> {
    const hash = createHash('sha256');
    for (const file of files) {hash.update(file).update('\0').update(await readFile(path.join(source.root, file))).update('\0');}
    return hash.digest('hex');
}
export async function copyPackageFiles(source: ToolPackageSource, destination: string, files: string[], bindings: ExecutableBinding[]): Promise<ExecutableBinding[]> {
    for (const file of files) {
        const target = path.join(destination, file); await mkdir(path.dirname(target), {recursive: true});
        await copyFile(path.join(source.root, file), target);
    }
    const installed: ExecutableBinding[] = [];
    for (const binding of bindings) {
        if (binding.source !== 'package' || !binding.relative) {installed.push(binding); continue;}
        const target = path.join(destination, binding.relative); await mkdir(path.dirname(target), {recursive: true});
        if (!files.includes(binding.relative)) await copyFile(binding.path, target);
        installed.push({...binding, path: target});
    }
    return installed;
}
