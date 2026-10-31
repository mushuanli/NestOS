import {FSError, type IFileSystem} from '@itookit/vfs-core';
import type {DiagnosticEvent} from '@itookit/app-contracts/services';
import {clean} from './codec';

const path = '/var/log/application-diagnostics.seq';
export const maxEntries = 500, maxBytes = 512 * 1024;
interface Index {version: 2; revision: number; ids: string[]}

/** Each series is a SeqFile entry; its updates and the bounded index commit atomically. */
export class DiagnosticStore {
    private index: string | null = null;
    private legacy = false;
    private revision = 0;
    constructor(private readonly fs: IFileSystem) {}
    async load(): Promise<DiagnosticEvent[]> {
        if (!this.fs.meta.seq?.transaction) throw new FSError('ECAPABILITY', 'Diagnostic transactions unavailable');
        if (!await this.fs.driver.exists(path)) await this.fs.driver.createFile({parentPath: '/var/log', name: 'application-diagnostics.seq', type: 'seqfile', recursive: true});
        return this.fs.meta.seq.transaction(async tx => {
            this.index = await tx.getEntry(path, 'index');
            if (this.index === null) {
                const raw = await tx.getEntry(path, 'events'); this.legacy = raw !== null;
                return raw === null ? [] : parseLegacy(raw);
            }
            const index = parseIndex(this.index); this.revision = index.revision;
            const records = await tx.getEntriesMany(index.ids.map(id => ({fileIdOrPath: path, key: 'event:' + id})));
            let bytes = 0;
            return records.map((raw, position) => {
                if (!raw || (bytes += raw.length * 2) > maxBytes) throw new FSError('EINVAL', 'Invalid diagnostic entries');
                const event = clean(JSON.parse(raw));
                if (event.id !== index.ids[position]) throw new FSError('EINVAL', 'Diagnostic identity mismatch');
                return event;
            });
        });
    }
    async save(events: DiagnosticEvent[], changed: Map<string, string | null>): Promise<void> {
        const raw = JSON.stringify({version: 2, revision: this.revision + 1, ids: events.map(event => event.id)} satisfies Index);
        await this.fs.meta.seq!.transaction!(async tx => {
            if (!await tx.compareAndSet(path, 'index', {expected: this.index, value: raw})) throw new FSError('ECONFLICT', 'Diagnostic journal changed');
            for (const [id, value] of changed) {
                if (value === null) await tx.deleteEntry(path, 'event:' + id);
                else await tx.setEntry(path, 'event:' + id, value);
            }
            if (this.legacy) await tx.deleteEntry(path, 'events');
        });
        this.index = raw; this.revision++; this.legacy = false;
    }
}
function parseIndex(raw: string): Index {
    if (raw.length > 120 * 1024) throw new FSError('EINVAL', 'Diagnostic index too large');
    const value = JSON.parse(raw) as Index;
    if (value.version !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.ids) || value.ids.length > maxEntries || new Set(value.ids).size !== value.ids.length
        || value.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(id))) throw new FSError('EINVAL', 'Invalid diagnostic index');
    return value;
}
function parseLegacy(raw: string): DiagnosticEvent[] {
    if (raw.length * 2 > maxBytes) throw new FSError('EINVAL', 'Diagnostic journal too large');
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > maxEntries) throw new FSError('EINVAL', 'Invalid legacy diagnostic journal');
    return value.map(clean);
}
