import { createFileSystemSource, type FSNode, type IStorageBackend } from '@itookit/vfs-core';
import { DirectorySourceUnavailableError } from './errors';

/** Retains a mount's identity while failing every content operation closed. */
class UnavailableDirectory implements IStorageBackend {
    readonly name = 'unavailable-directory';
    async init() {} async close() {}
    async stat(path: string): Promise<FSNode | null> {
        if (path !== '/') throw this.error();
        return { type: 'directory', path: '/', parentPath: null, name: '', createdAt: 0, modifiedAt: 0, version: 0, tags: [], metadata: { unavailable: true } };
    }
    constructor(private readonly sourceId: string) {}
    private error() { return new DirectorySourceUnavailableError(this.sourceId); }
    async list(): Promise<FSNode[]> { throw this.error(); }
    async read(): Promise<Uint8Array> { throw this.error(); }
    async write(): Promise<FSNode> { throw this.error(); }
    async mkdir(): Promise<FSNode> { throw this.error(); }
    async delete(): Promise<void> { throw this.error(); }
    async rename(): Promise<void> { throw this.error(); }
    async updateMetadata(): Promise<void> { throw this.error(); }
    async setTags(): Promise<void> { throw this.error(); }
    async getAllTags(): Promise<string[]> { return []; }
}
export function createUnavailableDirectory(sourceId: string) {
    return createFileSystemSource({ tags: false, backend: new UnavailableDirectory(sourceId), viewId: `unavailable:${sourceId}`, access: 'ro' });
}
