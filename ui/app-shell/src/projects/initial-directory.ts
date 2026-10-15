import { createFile, checkOperation, type IFileSystem, type FSNode } from '@itookit/vfs-core';

/** Consume initial metadata once; later refreshes always read the live file view. */
export function withInitialDirectory(fs: IFileSystem, initial: { revision: number; node: FSNode | null; nodes: FSNode[] }): IFileSystem {
    const available = new Set(['getNode', 'getChildren']);
    const driver = new Proxy(fs.driver, { get(target, key) {
        if (key === 'getNode' || key === 'getChildren') return async (path: string, options?: import('@itookit/vfs-core').OperationOptions) => {
            checkOperation(options);
            if (path === '/' && fs.revision === initial.revision && available.delete(key))
                return structuredClone(key === 'getNode' ? initial.node : initial.nodes);
            return target[key](path, options);
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const view: IFileSystem = new Proxy(fs, { get(target, key) {
        if (key === 'driver') return driver;
        if (key === 'openFile') return (path: string) => createFile(view, path);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return view;
}
