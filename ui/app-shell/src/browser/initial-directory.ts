import { createFile, checkOperation, type IFileSystem, type OperationOptions } from '@itookit/vfs-core';
import type { NavigationDirectory } from '@itookit/app-contracts/services';

type ReadOptions = OperationOptions & { encoding?: string; includeHidden?: boolean; onRevision?: unknown };
function observe(target: object, key: PropertyKey, available: Set<string>) {
    const method = Reflect.get(target, key, target);
    if (!['on', 'onAny'].includes(String(key)) || typeof method !== 'function') return undefined;
    return (...args: any[]) => {
        const listener = args.pop();
        return method.call(target, ...args, (...values: unknown[]) => { available.clear(); return listener(...values); });
    };
}
function canSeed(fs: IFileSystem, initial: NavigationDirectory, key: PropertyKey, options?: ReadOptions): boolean {
    if (initial.stale || fs.revision !== initial.revision) return false;
    if (key === 'readContent' && initial.ignore?.content === undefined) return false;
    return !options?.onRevision && !options?.includeHidden && options?.encoding !== 'binary';
}
function initialValue(initial: NavigationDirectory, key: PropertyKey, path: string) {
    const node = path === '/' ? initial.node : initial.ignore!.node;
    if (key === 'getChildren') return structuredClone(initial.nodes);
    if (key === 'getNodeType') return node ? { type: node.type } : null;
    if (key === 'readContent') return initial.ignore!.content;
    return structuredClone(node);
}
function seededRead(fs: IFileSystem, initial: NavigationDirectory, available: Set<string>, key: PropertyKey) {
    const target = fs.driver;
    return async (path: string, options?: ReadOptions) => {
        checkOperation(options);
        const known = path === '/' ? key !== 'readContent' : path === '/.gitignore' && !!initial.ignore && key !== 'getChildren';
        if (known && canSeed(fs, initial, key, options) && available.delete(`${String(key)}:${path}`))
            return initialValue(initial, key, path);
        const method = Reflect.get(target, key, target);
        if (!method && key === 'getNodeType') { const node = await target.getNode(path, options); return node ? { type: node.type } : null; }
        return method.call(target, path, options);
    };
}
/** Seed startup reads once; mutations, explicit revisions and later refreshes use the live capability. */
export function withInitialDirectory(fs: IFileSystem, initial: NavigationDirectory): IFileSystem {
    const available = new Set(['getNode:/', 'getChildren:/', 'getNodeType:/',
        'getNode:/.gitignore', 'getNodeType:/.gitignore', 'readContent:/.gitignore']);
    const driver = new Proxy(fs.driver, { get(target, key) {
        const observer = observe(target, key, available); if (observer) return observer;
        if (['getNode', 'getNodeType', 'getChildren', 'readContent'].includes(String(key))) return seededRead(fs, initial, available, key);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const view: IFileSystem = new Proxy(fs, { get(target, key) {
        const observer = observe(target, key, available); if (observer) return observer;
        if (key === 'driver') return driver;
        if (key === 'openFile') return (path: string) => createFile(view, path);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return view;
}
