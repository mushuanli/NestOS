import {FSError, type IFileSystem} from '@itookit/vfs-core';
import {randomUUID} from '@itookit/common';
import type {ProjectConversationPort, ConversationComposerDraft} from '@itookit/app-contracts/services';

const empty = (): ConversationComposerDraft => ({revision: '0', data: '', acceptedOperationIds: []});
/** Opaque input state and immutable assets stay local to the application host. */
export class ConversationComposerStore {
    private readonly path: string;
    private readonly directory: string;
    constructor(private readonly fs: IFileSystem, projectId: string, private readonly owner: string,
        private readonly writable: boolean, private readonly checkAccess: () => void) {
        if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new FSError('EINVAL', 'Invalid project identity');
        this.path = `/var/lib/projects/${projectId}/conversation-input.seq`;
        this.directory = `/var/lib/projects/${projectId}/conversation-assets`;
    }
    async readComposerDraft(): Promise<ConversationComposerDraft> {
        this.checkAccess();
        if (!await this.fs.driver.exists(this.path)) return empty();
        const raw = await this.fs.meta.seq!.getEntry(this.path, this.owner);
        return raw ? JSON.parse(raw) : empty();
    }
    async saveComposerDraft(data: string, expectedRevision: string, operationId: string): Promise<ConversationComposerDraft> {
        this.writeAccess();
        if (typeof data !== 'string' || new TextEncoder().encode(data).length > 1024 * 1024
            || typeof expectedRevision !== 'string' || !validId(operationId)) throw new FSError('EINVAL', 'Invalid composer update');
        await this.ensureFile();
        return this.fs.meta.seq!.transaction!(async tx => {
            this.writeAccess(); const raw = await tx.getEntry(this.path, this.owner);
            const current: ConversationComposerDraft = raw ? JSON.parse(raw) : empty();
            if (current.acceptedOperationIds.includes(operationId)) return current;
            if (current.revision !== expectedRevision) throw new FSError('ECONFLICT', 'Composer changed in another view');
            const next = {data, revision: randomUUID(), acceptedOperationIds: [...current.acceptedOperationIds, operationId].slice(-64)};
            if (!await tx.compareAndSet(this.path, this.owner, {expected: raw, value: JSON.stringify(next)}))
                throw new FSError('ECONFLICT', 'Composer changed in another view');
            return next;
        });
    }
    async putComposerAsset(content: ArrayBuffer): Promise<string> {
        this.writeAccess();
        if (!(content instanceof ArrayBuffer) || content.byteLength > 20 * 1024 * 1024) throw new FSError('EFBIG', 'Composer asset too large');
        await this.ensureFile(); const id = randomUUID();
        await this.fs.driver.createFile({parentPath: this.directory, name: id, content, recursive: true});
        this.writeAccess(); await this.fs.meta.seq!.setEntry(this.path, `asset/${id}`, this.owner); return id;
    }
    async readComposerAsset(id: string): Promise<ArrayBuffer> {
        this.checkAccess();
        if (!validId(id) || !await this.fs.driver.exists(this.path)
            || await this.fs.meta.seq!.getEntry(this.path, `asset/${id}`) !== this.owner) throw new FSError('ENOENT', 'Composer asset unavailable');
        return this.fs.driver.readContent(`${this.directory}/${id}`, {encoding: 'binary'});
    }
    private writeAccess(): void {this.checkAccess(); if (!this.writable) throw new FSError('EACCES', 'Composer is read only');}
    private async ensureFile(): Promise<void> {
        if (await this.fs.driver.exists(this.path)) return;
        try {await this.fs.driver.createFile({parentPath: this.path.slice(0, this.path.lastIndexOf('/')), name: 'conversation-input.seq', type: 'seqfile', recursive: true});}
        catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
    }
}
function validId(id: unknown): id is string {return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);}

export function withConversationComposer(source: ProjectConversationPort, composer: ConversationComposerStore): ProjectConversationPort {
    let closed = false;
    return new Proxy(source, {get: (target, key) => {
        if (key === 'close') return () => {closed = true; return source.close();};
        if (['readComposerDraft', 'saveComposerDraft', 'putComposerAsset', 'readComposerAsset'].includes(String(key)))
            return (...args: unknown[]) => closed ? Promise.reject(new FSError('EIO', 'Conversation view closed'))
                : Reflect.get(composer, key, composer).apply(composer, args);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
