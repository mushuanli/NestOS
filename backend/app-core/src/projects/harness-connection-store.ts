import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { HarnessExecutionConnection, HarnessExecutionConnectionRecord } from '@itookit/kernel-adapters/contracts';

export type HarnessConnectionRecord = HarnessExecutionConnectionRecord;
const indexPath = '/etc/execution/connections.seq';
const recordPath = (id: string) => `/etc/execution/connections/${safeId(id)}.seq`;

/** Tombstones retain revisions so a removed target cannot be recreated through a stale writer. */
export class HarnessConnectionStore {
    constructor(private readonly fs: IFileSystem) {}
    async get(id: string): Promise<HarnessConnectionRecord | undefined> {
        const path = recordPath(id);
        if (!await this.fs.driver.exists(path)) return;
        const record = decode(await this.fs.meta.seq!.getEntry(path, 'connection'));
        if (record?.connection && record.connection.id !== id) throw new FSError('EIO', 'Execution connection identity does not match its record');
        return record;
    }
    async list(): Promise<HarnessConnectionRecord[]> {
        if (!await this.fs.driver.exists(indexPath)) return [];
        const ids = decodeIndex(await this.fs.meta.seq!.getEntry(indexPath, 'index'));
        const records = await Promise.all(ids.map(id => this.get(id)));
        return records.filter((record): record is HarnessConnectionRecord => !!record?.connection);
    }
    async save(id: string, connection: HarnessExecutionConnection | null, expectedRevision: number): Promise<HarnessConnectionRecord> {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER)
            throw new FSError('EINVAL', 'Invalid execution connection revision');
        const path = recordPath(id), next: HarnessConnectionRecord = { version: 1, revision: expectedRevision + 1, connection };
        await this.ensure(indexPath); await this.ensure(path);
        if (!this.fs.meta.seq?.transaction) throw new FSError('ECAPABILITY', 'Execution connections require transactional storage');
        await this.fs.meta.seq.transaction(async tx => {
            const raw = await tx.getEntry(path, 'connection'), old = decode(raw);
            if ((old?.revision ?? 0) !== expectedRevision) throw conflict();
            const indexRaw = await tx.getEntry(indexPath, 'index'), ids = decodeIndex(indexRaw).filter(value => value !== id);
            if (connection) ids.push(id);
            if (!await tx.compareAndSet(path, 'connection', { expected: raw, value: JSON.stringify(next) })
                || !await tx.compareAndSet(indexPath, 'index', { expected: indexRaw, value: JSON.stringify([...new Set(ids)].sort()) })) throw conflict();
        });
        return structuredClone(next);
    }
    private async ensure(path: string): Promise<void> {
        if (await this.fs.driver.exists(path)) return;
        const split = path.lastIndexOf('/');
        try { await this.fs.driver.createFile({ parentPath: path.slice(0, split), name: path.slice(split + 1), type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
}
export function safeId(id: string): string {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new FSError('EINVAL', 'Invalid execution connection identity');
    return id;
}
function decode(raw: string | null): HarnessConnectionRecord | undefined {
    if (raw === null) return;
    let value: HarnessConnectionRecord;
    try { value = JSON.parse(raw); } catch { throw new FSError('EIO', 'Invalid execution connection record'); }
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
        || value.connection !== null && (!value.connection || typeof value.connection !== 'object')) throw new FSError('EIO', 'Invalid execution connection record');
    return value;
}
function decodeIndex(raw: string | null): string[] {
    if (raw === null) return [];
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new FSError('EIO', 'Invalid execution connection index'); }
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new FSError('EIO', 'Invalid execution connection index');
    return value.map(safeId);
}
function conflict() { return new FSError('ECONFLICT', 'Execution connection changed; reload its configuration'); }
