import type { IFileSystem } from '@itookit/vfs-core';
import { normalizeVirtualPath, FSError } from '@itookit/vfs-core';
import type { ScopedPersistenceStore } from '@itookit/mdxeditor';
import { CLOZE_SRS_PATH, clozeDocumentPrefix } from '@itookit/app-contracts';
import { createModuleLogger, randomUUID } from '@itookit/common';
import { EngineMetadataStore } from './metadata-store';
import {studyIndex} from './study-index';

const log = createModuleLogger('cloze-storage');
function storageErrorCode(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CLOZE_WRITE_FAILED';
}
function parseValue(raw: string | null): unknown {
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
}

/** A document scope in the shared notes seqfile; reads never create files or records. */
export class SeqFileStore implements ScopedPersistenceStore {
    private documentPath: string;
    private legacy: EngineMetadataStore;
    constructor(private fs: IFileSystem, path: string) {
        this.documentPath = normalizeVirtualPath(path);
        this.legacy = new EngineMetadataStore(fs, this.documentPath, 'cloze:memory');
    }

    private seq() {
        if (!this.fs.meta.seq) throw new FSError('EINVAL', 'SeqFile capability is unavailable');
        return this.fs.meta.seq;
    }

    async get(key: string): Promise<unknown> {
        if (key === '_mdx_srs') return this.legacy.get(key);
        if (!await this.fs.driver.exists(CLOZE_SRS_PATH)) return undefined;
        return parseValue(await this.seq().getEntry(CLOZE_SRS_PATH, clozeDocumentPrefix(this.documentPath) + key));
    }

    async entries(prefix = ''): Promise<Array<[string, unknown]>> {
        if (!await this.fs.driver.exists(CLOZE_SRS_PATH)) return [];
        const scope = clozeDocumentPrefix(this.documentPath), entries: Array<[string, unknown]> = [];
        await this.seq().walkEntries(CLOZE_SRS_PATH, entry => {
            entries.push([entry.key.slice(scope.length), parseValue(entry.value)]); return true;
        }, { keyPrefix: scope + prefix });
        return entries;
    }

    private async ensure(): Promise<void> {
        if (await this.fs.driver.exists(CLOZE_SRS_PATH)) return;
        try {
            await this.fs.driver.createFile({ parentPath: '/.nestos', name: 'cloze-srs.seq', type: 'seqfile', recursive: true });
        } catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; }
    }

    async set(key: string, value: unknown): Promise<void> {
        if (key === '_mdx_srs') { await this.legacy.set(key, value); await this.legacy.flush(); return; }
        const path = this.documentPath, storageKey = clozeDocumentPrefix(path) + key;
        const operationId = randomUUID(), started = Date.now();
        try {
            if (!await this.fs.driver.exists(path)) throw new FSError('ENOENT', 'Review document was moved or deleted');
            await this.ensure();
            await this.seq().setEntry(CLOZE_SRS_PATH, storageKey, JSON.stringify(value ?? null));
            if (!await this.fs.driver.exists(path)) {
                await this.seq().deleteEntry(CLOZE_SRS_PATH, storageKey);
                throw new FSError('ENOENT', 'Review document was moved or deleted during saving');
            }
            studyIndex(this.fs).patch(path, key, value ?? null);
            log.info('cloze.write', { operationId, stage: 'persist', result: 'success', durationMs: Date.now() - started });
        } catch (error) {
            log.error('cloze.write', { operationId, stage: 'persist', result: 'failure',
                code: storageErrorCode(error), durationMs: Date.now() - started });
            throw error;
        }
    }

    async remove(key: string): Promise<void> {
        if (key === '_mdx_srs') {
            if (await this.legacy.get(key) !== undefined) { await this.legacy.remove(key); await this.legacy.flush(); }
            return;
        }
        if (await this.fs.driver.exists(CLOZE_SRS_PATH)) {
            await this.seq().deleteEntry(CLOZE_SRS_PATH, clozeDocumentPrefix(this.documentPath) + key);
            studyIndex(this.fs).patch(this.documentPath, key, undefined, true);
        }
    }

    updateDocumentPath(path: string): void {
        this.documentPath = normalizeVirtualPath(path);
        this.legacy.updateDocumentPath(this.documentPath);
    }
    destroy(): void { this.legacy.destroy?.(); }
}

/** Hosts choose the storage backend; card formats and migration stay in mdxeditor. */
export function createAdapterStore(fs: IFileSystem, path: string, plugin: string): ScopedPersistenceStore {
    return plugin === 'cloze:memory' && fs.capabilities.seqFiles
        ? new SeqFileStore(fs, path) : new EngineMetadataStore(fs, path, plugin);
}
