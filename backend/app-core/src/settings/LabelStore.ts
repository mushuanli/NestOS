import type { IFileSystem } from '@itookit/vfs-core';
import type { Tag } from '@itookit/app-contracts/settings';

export const TAG_STORE_PATH = '/tags.seq';
const PREFIX = 'tag/';
const SCHEMA_VERSION = '1';

/** Definitions only. File associations belong to each filesystem's tag index. */
export class LabelStore {
    constructor(private readonly files: IFileSystem) {}

    async list(): Promise<Tag[]> {
        if (!await this.files.driver.exists(TAG_STORE_PATH)) return this.legacy();
        const seq = this.files.meta.seq;
        if (!seq?.transaction) throw new Error('Tag definitions require transactional SeqFiles');
        const tags = await seq.transaction(async tx => {
            const version = await tx.getEntry(TAG_STORE_PATH, 'schema');
            if (version === null) return null;
            if (version !== SCHEMA_VERSION) throw new Error('Unsupported tag catalog version');
            const result: Tag[] = [];
            await tx.walkEntries(TAG_STORE_PATH, entry => { result.push(JSON.parse(entry.value)); return true; }, { keyPrefix: PREFIX });
            return result;
        });
        return tags ?? this.legacy();
    }

    private async legacy(): Promise<Tag[]> {
        if (!await this.files.driver.exists('/tags.json')) return [];
        const raw = await this.files.driver.readContent('/tags.json', { encoding: 'utf-8' });
        const tags = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer));
        if (!Array.isArray(tags)) throw new Error('Invalid legacy tag definitions');
        return tags;
    }

    private async ready(): Promise<void> {
        if (!this.files.meta.seq?.transaction) throw new Error('Tag definitions require transactional SeqFiles');
        if (!await this.files.driver.exists(TAG_STORE_PATH)) {
            try { await this.files.driver.createFile({ name: 'tags.seq', parentPath: '/', type: 'seqfile' }); }
            catch (error) { if (!await this.files.driver.exists(TAG_STORE_PATH)) throw error; }
        }
        const version = await this.files.meta.seq.getEntry(TAG_STORE_PATH, 'schema');
        if (version !== null) {
            if (version !== SCHEMA_VERSION) throw new Error('Unsupported tag catalog version');
            return;
        }
        const legacy = await this.legacy();
        await this.files.meta.seq.transaction(async tx => {
            if (await tx.getEntry(TAG_STORE_PATH, 'schema')) return;
            for (const tag of legacy) await tx.setEntry(TAG_STORE_PATH, PREFIX + tag.id, JSON.stringify(definition(tag)));
            await tx.setEntry(TAG_STORE_PATH, 'schema', SCHEMA_VERSION);
        });
    }

    async replaceAll(tags: Tag[]): Promise<void> {
        await this.ready();
        const seq = this.files.meta.seq;
        if (!seq?.transaction) throw new Error('Tag definitions require transactional SeqFiles');
        await seq.transaction(async tx => {
            const existing: string[] = [];
            await tx.walkEntries(TAG_STORE_PATH, entry => {
                if (entry.key.startsWith(PREFIX)) existing.push(entry.key);
                return true;
            }, { keyPrefix: PREFIX });
            for (const key of existing) await tx.deleteEntry(TAG_STORE_PATH, key);
            for (const tag of tags) {
                await tx.setEntry(TAG_STORE_PATH, PREFIX + tag.id, JSON.stringify(definition(tag)));
            }
        });
    }

    async save(tag: Tag): Promise<void> {
        await this.ready();
        await this.files.meta.seq!.setEntry(TAG_STORE_PATH, PREFIX + tag.id, JSON.stringify(definition(tag)));
    }

    async delete(id: string): Promise<void> {
        await this.ready();
        await this.files.meta.seq!.deleteEntry(TAG_STORE_PATH, PREFIX + id);
    }
}

function definition(tag: Tag): Omit<Tag, 'count'> {
    const { count: _count, ...value } = tag;
    return value;
}
