import { createFileSystemSource, FSError, type FSNode, type IStorageBackend } from '@itookit/vfs-core';
import type { ISessionRepository } from './types';

/** Read-through file projection of Session records; never a second durable copy. */
class SessionProjection implements IStorageBackend {
    readonly name = 'session-record-projection';
    constructor(private readonly repository: ISessionRepository, private readonly id: string) {}
    async init() {}
    async close() {}
    async stat(path: string): Promise<FSNode | null> {
        const directory = path === '/' || path === '/history';
        let content: Uint8Array | undefined;
        if (!directory) {
            try { content = await this.read(path); }
            catch (error) { if (error instanceof FSError && error.code === 'ENOENT') return null; throw error; }
        }
        const base = { path, name: path.split('/').pop()!, parentPath: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/', createdAt: 0, modifiedAt: 0, version: 0, tags: [], metadata: {} };
        return directory ? { ...base, type: 'directory' } : { ...base, type: 'file', size: content!.byteLength };
    }
    async list(path: string): Promise<FSNode[]> {
        const paths = path === '/' ? ['/session.json', '/history'] : path === '/history'
            ? (await this.repository.listHistory(this.id)).map(name => `/history/${name}`) : [];
        return (await Promise.all(paths.map(path => this.stat(path)))).filter((node): node is FSNode => node !== null);
    }
    async read(path: string): Promise<Uint8Array> {
        let value: string | null = null;
        if (path === '/session.json') value = JSON.stringify(await this.repository.getManifest(this.id), null, 2);
        else if (/^\/history\/[^/]+$/.test(path)) value = await this.repository.readDocument(this.id, path.slice('/history/'.length));
        if (value === null) throw new FSError('ENOENT', 'Session projection file not found');
        return new TextEncoder().encode(value);
    }
    async mkdir(): Promise<FSNode> { throw new FSError('EROFS', 'Session history is managed by Session operations'); }
    async write(): Promise<FSNode> { throw new FSError('EROFS', 'Session history is managed by Session operations'); }
    async delete(): Promise<void> { throw new FSError('EROFS', 'Session history is managed by Session operations'); }
    async rename(): Promise<void> { throw new FSError('EROFS', 'Session history is managed by Session operations'); }
    async updateMetadata(): Promise<void> { throw new FSError('EROFS', 'Session history is managed by Session operations'); }
    async setTags(): Promise<void> { throw new FSError('EROFS', 'Session history is managed by Session operations'); }
    async getAllTags(): Promise<string[]> { return []; }
}

export async function createSessionDataProjection(repository: ISessionRepository, sessionId: string) {
    await repository.getManifest(sessionId);
    return createFileSystemSource({ backend: new SessionProjection(repository, sessionId), viewId: `session-data:${sessionId}`, access: 'ro' });
}
