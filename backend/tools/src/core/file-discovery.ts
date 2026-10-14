import { discoverFiles, pathUtils, type FileDiscoverySource } from '@itookit/vfs-core';
import type { ToolUseContext } from './types';

export async function* discoverToolFiles(context: ToolUseContext, path?: string, includeIgnored?: boolean): AsyncGenerator<string> {
    const options = { includeIgnored, signal: context.signal };
    if (context.vfs) {
        if (context.vfs.walkFiles) yield* context.vfs.walkFiles(path ?? context.cwd, options);
        else yield* await context.vfs.listFiles(path ?? context.cwd, options);
        return;
    }
    const { source, root } = await nativeSource(context.cwd, path);
    for await (const entry of discoverFiles(source, root, options)) yield entry.path;
}

export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export async function readSearchFile(context: ToolUseContext, path: string): Promise<string> {
    if (context.vfs) return context.vfs.readFile(path, { maxBytes: MAX_SEARCH_FILE_BYTES });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs = await import('node:fs/promises' as any);
    const file = await fs.open(path.replace(/^\/([a-z]:\/)/i, '$1'), 'r');
    try {
        const bytes = new Uint8Array(MAX_SEARCH_FILE_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_SEARCH_FILE_BYTES) throw Object.assign(new Error('Search file exceeds 2 MiB'), { code: 'SEARCH_FILE_TOO_LARGE' });
        return new TextDecoder().decode(bytes.subarray(0, bytesRead));
    } finally { await file.close(); }
}

export function displaySearchPath(path: string, root: string, virtual: boolean, cwd: string): string {
    if (virtual) return path;
    const absolute = /^(\/|[a-z]:)/i.test(root) ? root : `${cwd}/${root}`;
    const prefix = pathUtils.normalize(absolute.replace(/\\/g, '/')).replace(/\/$/, '') + '/';
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function matchesSearchGlob(regex: RegExp, path: string, root: string, cwd: string): boolean {
    return regex.test(path) || regex.test(displaySearchPath(path, root, false, cwd));
}

async function nativeSource(cwd: string, path?: string): Promise<{ source: FileDiscoverySource; root: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs = await import('node:fs/promises' as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodePath = await import('node:path' as any);
    const posix = (value: string): string => value.replace(/\\/g, '/').replace(/^([a-z]:)/i, '/$1');
    const native = (value: string): string => value.replace(/^\/([a-z]:\/)/i, '$1');
    const root = posix(nodePath.resolve(cwd, path ?? '.'));
    const base = posix(nodePath.resolve(cwd));
    const boundary = root === base || root.startsWith(base + '/') ? base : posix(nodePath.dirname(root));
    return { root, source: {
        rootFor: () => boundary,
        stat: async target => { const info = await nativeStat(fs, native(target)); return info ? entry(target, info) : null; },
        list: async target => (await fs.readdir(native(target), { withFileTypes: true }))
            .map((info: NativeEntry) => entry(posix(nodePath.join(native(target), info.name!)), info)),
        async readIgnoreFile(target) {
            const info = await nativeStat(fs, native(target));
            if (!info?.isFile()) return null;
            if ((info.size ?? 0) > 1024 * 1024) throw new Error('Ignore file size limit exceeded');
            return fs.readFile(native(target), 'utf8');
        },
    } };
}

interface NativeEntry { name?: string; size?: number; isFile(): boolean; isDirectory(): boolean }
function entry(path: string, info: NativeEntry) {
    return { path, name: path.split('/').pop()!, size: info.size,
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' };
}

async function nativeStat(fs: { lstat(path: string): Promise<NativeEntry> }, path: string): Promise<NativeEntry | null> {
    try { return await fs.lstat(path); }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
}
