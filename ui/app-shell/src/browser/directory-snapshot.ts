import { checkOperation, createFile, type IFileSystem, type OperationOptions } from '@itookit/vfs-core';
import type { NavigationDirectory } from '@itookit/app-contracts/services';

type Directory = NavigationDirectory & { path: string };
type ReadOptions = OperationOptions & { includeHidden?: boolean; fields?: string; onRevision?: unknown; encoding?: string };
interface Seed { revision: number; stale?: boolean; value: unknown }
const reads = ['getNode', 'getNodeType', 'getChildren', 'readContent'];

/** Consume prepared metadata once; events, explicit revisions and later reads use the live port. */
export function directorySnapshot(files: IFileSystem) {
    const available = new Map<string, Seed>();
    const driver = new Proxy(files.driver, { get(target, key) {
        const observer = observeSnapshot(target, key, available); if (observer) return observer;
        if (reads.includes(String(key))) return seededRead(files, key, available);
        const method = Reflect.get(target, key, target); return typeof method === 'function' ? method.bind(target) : method;
    } });
    const view: IFileSystem = new Proxy(files, { get(target, key) {
        const observer = observeSnapshot(target, key, available); if (observer) return observer;
        if (key === 'driver') return driver;
        if (key === 'openFile') return (path: string) => createFile(view, path);
        const method = Reflect.get(target, key, target); return typeof method === 'function' ? method.bind(target) : method;
    } });
    return { files: view, seed(directories: Directory[]) {
        available.clear();
        for (const directory of directories) seedDirectory(available, directory);
    } };
}
function seedDirectory(available: Map<string, Seed>, directory: Directory): void {
    const { path, node, nodes, revision, stale, ignore } = directory;
    const add = (method: string, at: string, value: unknown) => available.set(`${method}:${at}`, { revision, stale, value });
    add('getChildren', path, nodes); add('getNode', path, node); add('getNodeType', path, node ? { type: node.type } : null);
    if (!ignore) return;
    const at = `${path === '/' ? '' : path}/.gitignore`;
    add('getNode', at, ignore.node); add('getNodeType', at, ignore.node ? { type: ignore.node.type } : null);
    if (ignore.content !== undefined) add('readContent', at, ignore.content);
}

function observeSnapshot(target: object, key: PropertyKey, available: Map<string, Seed>) {
    const method = Reflect.get(target, key, target);
    if (!['on', 'onAny'].includes(String(key)) || typeof method !== 'function') return undefined;
    return (...args: unknown[]) => {
        const listener = args.pop() as (...values: unknown[]) => void;
        return method.call(target, ...args, (...values: unknown[]) => { available.clear(); return listener(...values); });
    };
}
function seededRead(files: IFileSystem, key: PropertyKey, available: Map<string, Seed>) {
    const target = files.driver, method = Reflect.get(target, key, target);
    return async (path: string, options?: ReadOptions) => {
        checkOperation(options);
        const id = `${String(key)}:${path}`, initial = available.get(id);
        if (initial && !initial.stale && files.revision === initial.revision && !options?.includeHidden && !options?.fields
            && !options?.onRevision && options?.encoding !== 'binary') {
            available.delete(id); return structuredClone(initial.value);
        }
        if (!method && key === 'getNodeType') { const node = await target.getNode(path, options); return node ? { type: node.type } : null; }
        return method.call(target, path, options);
    };
}
