import { FSError, normalizeVirtualPath, type IFileSystem } from '@itookit/vfs-core';
import type { ApplicationClient, FileSystemsPort } from '@itookit/app-contracts/services';

/** Managed state is writable through application commands; UI preferences remain files. */
export function restrictApplicationFiles(client: ApplicationClient, roots: readonly string[]): ApplicationClient {
    const vfs = viewVfs(client.services.vfs, roots);
    return { services: { ...client.services, vfs }, backend: { ...client.backend,
        settings: async sources => {
            for (const source of sources) if (source.workspace !== undefined && !roots.includes('/home/admin/' + source.workspace))
                throw new FSError('EACCES', 'Settings workspace is not an application workspace');
            const settings = await client.backend.settings(sources);
            return new Proxy(settings, { get(target, key) {
                if (key === 'vfs') return vfs;
                if (key === 'openWorkspace') return async (name: string) => {
                    const fs = await target.openWorkspace(name), source = sources.find(source => source.name === name);
                    return source?.workspace ? protectFiles(fs, '/home/admin/' + source.workspace) : fs;
                };
                if (key === 'writePreference') return (path: string, content: string) => {
                    if (!normalizeVirtualPath(path).startsWith('/ui/')) throw new FSError('EACCES', 'Unknown UI preference');
                    return target.writePreference(path, content);
                };
                if (key === 'configFiles') return target.configFiles ? protectFiles(target.configFiles, '/etc') : undefined;
                const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
            } });
        },
    } };
}
function viewVfs(vfs: FileSystemsPort, roots: readonly string[]): FileSystemsPort {
    const devices = { list: () => vfs.devices.list(), isFrozen: () => true, get: (id: string) => {
        const driver = vfs.devices.get(id);
        return { handlerId: driver.handlerId, description: driver.description, writable: driver.writable, streamable: driver.streamable, sessionable: driver.sessionable };
    } };
    return new Proxy(vfs, { get(target, key) {
        if (key === 'devices') return devices;
        if (key === 'openFileSystem') return async (root: string) => {
            const normalized = normalizeVirtualPath(root);
            if (root !== normalized || !roots.includes(root))
                throw new FSError('EACCES', 'Filesystem root is not an application workspace');
            return protectFiles(await target.openFileSystem(root), root);
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
}
const guardedFiles = new WeakMap<IFileSystem, IFileSystem>();
function protectFiles(fs: IFileSystem, root: string): IFileSystem {
    if (!['/etc', '/home/admin', '/home/admin/chats'].includes(root)) return fs;
    const cached = guardedFiles.get(fs); if (cached) return cached;
    const driver = protectOperations(fs.driver, root);
    const extensions = new WeakMap<object, object>();
    const meta = new Proxy(fs.meta, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (!value || typeof value !== 'object') return value;
        if (!extensions.has(value)) extensions.set(value, protectOperations(value, root));
        return extensions.get(value);
    } });
    const view = new Proxy(fs, { get(target, key) {
        if (key === 'driver') return driver;
        if (key === 'meta') return meta;
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    guardedFiles.set(fs, view); return view;
}
function protectOperations<T extends object>(operations: T, root: string): T {
    const reads = new Set(['getNode', 'getNodeType', 'getChildren', 'readContent', 'resolvePath', 'exists', 'walkTree', 'search', 'getStats', 'readlink', 'on', 'onAny',
        'getAsset', 'getAssetDirPath', 'listAssets', 'hasAssetDir', 'validateAssetDir', 'getAllTags', 'listTagEntries', 'walkByTag', 'walkTags', 'countTags',
        'getEntry', 'getEntries', 'getEntriesMany', 'hasEntry', 'walkEntries', 'queryEntries', 'walkIncoming', 'walkOutgoing', 'hasRef', 'watch']);
    return new Proxy(operations, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (reads.has(String(key))) return value.bind(target);
        return (...args: any[]) => {
            const paths = key === 'createFile' || key === 'createDirectory' ? [(args[0]?.parentPath ?? '/') + '/' + args[0]?.name] : Array.isArray(args[0]) ? args[0] : [args[0]];
            if (['move', 'copy', 'hardlink', 'symlink'].includes(String(key))) paths.push(args[1]);
            if (root !== '/etc' || !paths.every((path: unknown) => typeof path === 'string' && (normalizeVirtualPath(path) === '/ui' || normalizeVirtualPath(path).startsWith('/ui/'))))
                throw new FSError('EACCES', 'Managed state requires an application command');
            return value.apply(target, args);
        };
    } });
}
