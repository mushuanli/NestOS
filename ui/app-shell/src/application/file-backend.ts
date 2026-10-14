import { FSError, type FSNode, type IStorageBackend, type OperationOptions } from '@itookit/vfs-core';
import { ENTITY_ICONS } from '@itookit/common';
import type { ApplicationPort, WorkspaceIdentity } from '@itookit/app-contracts/application';

const SESSION_SUFFIX = '.session';
export function sessionPath(id: string, folder?: string | null): string { return `${folder ?? ''}/${id}${SESSION_SUFFIX}`; }
export function sessionId(path: string): string | undefined {
    return path.endsWith(SESSION_SUFFIX) ? path.slice(path.lastIndexOf('/') + 1, -SESSION_SUFFIX.length) : undefined;
}
function directory(path: string, name = path.split('/').pop() || '/'): FSNode {
    return { type: 'directory', path, name, parentPath: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
        createdAt: 0, modifiedAt: 0, version: 1, tags: [], metadata: { title: name } };
}

/** Authorized presentation files only; execution and durable records stay in the host. */
export class ApplicationFileBackend implements IStorageBackend {
    readonly name = 'application';
    private readonly revisions = new Map<string, string | undefined>();
    constructor(private readonly application: ApplicationPort, private readonly workspace?: WorkspaceIdentity) {}
    async init(): Promise<void> {}
    async close(): Promise<void> { this.revisions.clear(); }
    async stat(path: string, options?: OperationOptions): Promise<FSNode | null> {
        if (this.workspace) return this.application.query('entry', { workspace: this.workspace, path }, options?.signal);
        if (path === '/') return directory(path);
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        return (await this.list(parent, options)).find(node => node.path === path) ?? null;
    }
    async list(path: string, options?: OperationOptions): Promise<FSNode[]> {
        if (!this.workspace) {
            const page = await this.application.query('navigation', { folder: path === '/' ? null : path }, options?.signal);
            return [...page.folders.map(item => directory(item.path, item.name)), ...page.sessions.map(item => this.session(item))];
        }
        const nodes: FSNode[] = [];
        let offset: number | undefined;
        do {
            const page = await this.application.query('directory', { workspace: this.workspace, path, offset, limit: 200 }, options?.signal);
            nodes.push(...page.entries); offset = page.nextOffset;
        } while (offset !== undefined);
        return nodes;
    }
    private session(item: { id: string; folder?: string | null; title: string; createdAt: number; updatedAt: number }): FSNode {
        return { type: 'file', path: sessionPath(item.id, item.folder), name: `${item.id}${SESSION_SUFFIX}`,
            parentPath: item.folder ?? '/', size: 0, version: 1, createdAt: item.createdAt, modifiedAt: item.updatedAt,
            icon: ENTITY_ICONS.chat, tags: [], metadata: { title: item.title, _readOnly: true } };
    }
    async read(path: string, options?: OperationOptions): Promise<Uint8Array> {
        if (!this.workspace) return new Uint8Array();
        const file = await this.application.query('file', { workspace: this.workspace, path }, options?.signal);
        this.revisions.set(path, file.revision);
        return file.encoding === 'text' ? new TextEncoder().encode(file.content)
            : Uint8Array.from(atob(file.content), char => char.charCodeAt(0));
    }
    async write(path: string, content: Uint8Array): Promise<FSNode> {
        if (!this.workspace || !this.revisions.has(path)) return this.unsupported();
        const result = await this.application.command('saveFile', { workspace: this.workspace, path,
            content: new TextDecoder().decode(content), revision: this.revisions.get(path) });
        this.revisions.set(path, result.revision);
        const node = await this.stat(path);
        if (!node) throw new FSError('ENOENT', 'File not found', 'write', path);
        return node;
    }
    async mkdir(_path: string): Promise<FSNode> { return this.unsupported(); }
    async delete(_path: string): Promise<void> { return this.unsupported(); }
    async rename(_from: string, _to: string): Promise<void> { return this.unsupported(); }
    async updateMetadata(_path: string, _metadata: Record<string, unknown>): Promise<void> { return this.unsupported(); }
    async setTags(_path: string, _tags: string[]): Promise<void> { return this.unsupported(); }
    async getAllTags(): Promise<string[]> { return []; }
    private unsupported(): never { throw new FSError('ECAPABILITY', 'Application operation is unavailable'); }
}
