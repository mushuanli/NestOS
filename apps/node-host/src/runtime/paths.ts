import {FSError} from '@itookit/vfs-core';
import path from 'node:path';
import {mkdir, realpath, lstat, chmod} from 'node:fs/promises';

interface HostPaths {root: string; sidecar: string; authDir: string; auditFile: string}
export function within(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export async function canonical(value: string): Promise<string> {
    try { return await realpath(value); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return path.join(await canonical(path.dirname(value)), path.basename(value));
    }
}
/** All Node entry points must keep host credentials and logs outside the visible VFS. */
export async function resolveHostPaths(options: HostPaths): Promise<HostPaths> {
    const [root, sidecar, authDir, auditFile] = await Promise.all(
        [options.root, options.sidecar, options.authDir, options.auditFile].map(value => canonical(path.resolve(value))));
    if (within(root, authDir) || within(root, auditFile)) throw new Error('OAuth credentials and audit logs must remain outside the VFS data root');
    if (within(root, sidecar) && sidecar !== path.join(root, '_meta')) throw new Error('Sidecar must be <root>/_meta or outside the VFS data root');
    await mkdir(root, {recursive: true});
    return {root, sidecar, authDir, auditFile};
}

/** Validate every ancestor before opening any credential or database beneath a user's bundle. */
export async function privateDirectory(directory: string): Promise<string> {
    const absolute = path.resolve(directory);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {await mkdir(current, {mode: 0o700});}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new FSError('EACCES', 'User storage ancestors must be real directories');
    }
    await chmod(absolute, 0o700);
    return realpath(absolute);
}
