import {createModuleLogger} from '@itookit/common';
import {FSError, type IFileSystem, type ISeqFileOperations} from '@itookit/vfs-core';
import type {DocumentChatLink, LocalApplicationServices} from '@itookit/app-contracts/services';

const table = '/fs/document-chat-links.seq', log = createModuleLogger('document-chat-registry');
const queues = new WeakMap<object, Promise<unknown>>();
/** One canonical edge with atomic forward/reverse index entries. Projections are disposable. */
export class DocumentChatRegistry {
    constructor(private services: LocalApplicationServices) {}
    serialize<T>(work: () => Promise<T>): Promise<T> {
        const owner = this.services.vfs, next = (queues.get(owner) ?? Promise.resolve()).then(work);
        queues.set(owner, next.catch(() => {})); return next;
    }
    private async files(create = false): Promise<{fs: IFileSystem; seq: ISeqFileOperations} | undefined> {
        const fs = await this.services.vfs.openFileSystem('/etc');
        if (!await fs.driver.exists(table)) {
            if (!create) return;
            try {await fs.driver.createFile({parentPath: '/fs', name: 'document-chat-links.seq', content: '', recursive: true});}
            catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        }
        if (!fs.meta.seq?.transaction) throw new FSError('ECAPABILITY', 'Document chat links require atomic record storage');
        return {fs, seq: fs.meta.seq};
    }
    async read(id: string): Promise<DocumentChatLink | undefined> {
        const files = await this.files(); if (!files) return;
        const value = await files.seq.getEntry(table, 'edge:' + id);
        return value ? JSON.parse(value) as DocumentChatLink : undefined;
    }
    async source(namespaceId: string, path: string, anchorId: string): Promise<DocumentChatLink | undefined> {
        const files = await this.files(); if (!files) return;
        const id = await files.seq.getEntry(table, `source:${encodeURIComponent(namespaceId)}:${encodeURIComponent(path)}:${anchorId}`);
        return id ? this.read(id) : undefined;
    }
    async save(link: DocumentChatLink, expected?: DocumentChatLink): Promise<DocumentChatLink> {
        const started = Date.now(), current = {...link, revision: (expected?.revision ?? 0) + 1, updatedAt: Date.now()};
        try {
            const files = (await this.files(true))!;
            await files.seq.transaction!(async tx => {
                const old = await tx.getEntry(table, 'edge:' + link.id), previous = old ? JSON.parse(old) as DocumentChatLink : undefined;
                if (previous?.revision !== expected?.revision) throw new FSError('ECONFLICT', 'Document chat link changed; reload before retrying');
                if (previous?.binding) await tx.deleteEntry(table, this.branchKey(previous));
                if (previous) await tx.deleteEntry(table, this.sourceKey(previous));
                await tx.setEntry(table, 'edge:' + link.id, JSON.stringify(current));
                await tx.setEntry(table, this.sourceKey(current), link.id);
                await tx.setEntry(table, `document:${link.documentId}:${link.anchorId}`, link.id);
                if (current.binding && current.status === 'bound') await tx.setEntry(table, this.branchKey(current), link.id);
            });
            log.info('document.chat.link', {operationId: link.pending?.submission?.id ?? link.anchorId, linkId: link.id, stage: 'persist-edge', result: 'success', status: current.status, revision: current.revision, durationMs: Date.now() - started});
            return current;
        } catch (error) {
            log.warn('document.chat.link', {operationId: link.pending?.submission?.id ?? link.anchorId, linkId: link.id, stage: 'persist-edge', result: 'failure', durationMs: Date.now() - started, code: (error as {code?: string})?.code ?? 'LINK_WRITE_FAILED'});
            throw error;
        }
    }
    async branch(sessionId: string, branch: string): Promise<DocumentChatLink[]> {
        const files = await this.files(); if (!files) return [];
        const links: DocumentChatLink[] = [];
        await files.seq.walkEntries(table, async entry => {
            const link = await this.read(entry.value); if (link?.status === 'bound') links.push(link); return true;
        }, {keyPrefix: `branch:${encodeURIComponent(sessionId)}:${encodeURIComponent(branch)}:`, limit: 1000});
        return links;
    }
    private sourceKey(link: DocumentChatLink): string {
        return `source:${encodeURIComponent(link.source.namespaceId)}:${encodeURIComponent(link.source.path)}:${link.anchorId}`;
    }
    private branchKey(link: DocumentChatLink): string {
        return `branch:${encodeURIComponent(link.binding!.sessionId)}:${encodeURIComponent(link.binding!.branch)}:${link.id}`;
    }
}
