import type { ISeqFileTransaction } from '@itookit/vfs-core';
import type { TwinRecordFamily, TwinRecordRef } from './contracts';
import { recordKey } from './codec';

interface Directory { next: number; counts: Record<string, number>; }
const SIZE = 100;
const capacity = (family: TwinRecordFamily) => family === 'memory' ? 500 : family === 'scan-plan' ? 50 : 10000;
/** Domain-owned bounded pages; each driver prefix contains at most SIZE small slot rows. */
export class TwinSeqPages {
    constructor(private readonly path: string) {}
    async add(tx: ISeqFileTransaction, ref: TwinRecordRef): Promise<void> {
        const key = `slot/${recordKey(ref)}`;
        if (await tx.getEntry(this.path, key)) return;
        const directory = await this.directory(tx, ref.family);
        if (Object.values(directory.counts).reduce((sum, count) => sum + count, 0) >= capacity(ref.family)) throw new Error('TWIN_RECORD_LIMIT');
        if (!Number.isSafeInteger(directory.next + 1)) throw new Error('TWIN_RECORD_LIMIT');
        const ordinal = directory.next++, page = pageId(ordinal);
        directory.counts[page] = (directory.counts[page] ?? 0) + 1;
        await tx.setEntry(this.path, `page/${ref.family}/${page}/${String(ordinal).padStart(16, '0')}`, ref.id);
        await tx.setEntry(this.path, key, String(ordinal));
        await this.save(tx, ref.family, directory);
    }
    async remove(tx: ISeqFileTransaction, ref: TwinRecordRef): Promise<void> {
        const key = `slot/${recordKey(ref)}`, raw = await tx.getEntry(this.path, key);
        if (raw === null) return;
        const ordinal = Number(raw), page = pageId(ordinal), directory = await this.directory(tx, ref.family);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !directory.counts[page]) throw new Error('TWIN_INVALID_PAGE');
        directory.counts[page]--;
        if (!directory.counts[page]) delete directory.counts[page];
        await tx.deleteEntry(this.path, `page/${ref.family}/${page}/${String(ordinal).padStart(16, '0')}`);
        await tx.deleteEntry(this.path, key); await this.save(tx, ref.family, directory);
    }
    async list(tx: ISeqFileTransaction, family: TwinRecordFamily, offset: number, limit: number): Promise<string[]> {
        const directory = await this.directory(tx, family), ids: string[] = [];
        for (const page of Object.keys(directory.counts).sort()) {
            const count = directory.counts[page];
            if (offset >= count) { offset -= count; continue; }
            const expected = Math.min(count - offset, limit - ids.length), before = ids.length;
            await tx.walkEntries(this.path, row => { ids.push(row.value); return true; },
                { keyPrefix: `page/${family}/${page}/`, offset, limit: Math.min(limit - ids.length, SIZE) });
            if (ids.length - before !== expected) throw new Error('TWIN_INVALID_PAGE');
            offset = 0;
            if (ids.length === limit) break;
        }
        return ids;
    }
    private async directory(tx: ISeqFileTransaction, family: TwinRecordFamily): Promise<Directory> {
        const raw = await tx.getEntry(this.path, `directory/${family}`);
        if (!raw) return { next: 0, counts: {} };
        const value = JSON.parse(raw) as Directory;
        if (!Number.isSafeInteger(value.next) || value.next < 0 || !value.counts || Array.isArray(value.counts)
            || Object.entries(value.counts).some(([page, count]) => !/^\d{16}$/.test(page)
                || !Number.isSafeInteger(count) || count < 1 || count > SIZE)) throw new Error('TWIN_INVALID_PAGE');
        return value;
    }
    private save(tx: ISeqFileTransaction, family: TwinRecordFamily, directory: Directory) {
        return tx.setEntry(this.path, `directory/${family}`, JSON.stringify(directory));
    }
}
const pageId = (ordinal: number) => String(Math.floor(ordinal / SIZE)).padStart(16, '0');
