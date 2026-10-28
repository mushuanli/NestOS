import { type IStorageBackend } from '@itookit/vfs-core';
import { PathGuard } from './path-guard';

/** Keep filesystem checks inside the daemon, beneath every domain service. */
export function guardHostStorage(backend: IStorageBackend, root: string): IStorageBackend {
    const guard = new PathGuard(root), singlePath = new Set(['stat', 'statType', 'read', 'write', 'mkdir', 'delete', 'list', 'listEntries', 'chmod', 'readlink', 'updateMetadata', 'setTags', 'replace']);
    return new Proxy(backend, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'close') return async () => {};
        if (key === 'symlink' || key === 'hardlink') return undefined;
        if (key === 'rename' || key === 'copy') return async (from: string, to: string, ...args: unknown[]) =>
            value.call(target, await guard.check(from), await guard.check(to), ...args);
        if (singlePath.has(String(key)) && typeof value === 'function') return async (file: string, ...args: unknown[]) => {
            const result = await value.call(target, await guard.check(file), ...args);
            return key === 'list' || key === 'listEntries' ? result.filter((entry: { path: string }) => guard.visible(entry.path)) : result;
        };
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
