import { randomUUID } from '@itookit/common';
import { sha256HexSync } from '@itookit/llm-context';
import type { IFileSystem, ISeqFileTransaction } from '@itookit/vfs-core';
import { decodeCleanup, decodeRecord, epoch, identity, payload, recordKey, recordRef, refs, MAX_FORGET_RECORDS } from './codec';
import type { TwinCleanup, TwinCommit, TwinCommitReceipt, TwinForget, TwinRecord, TwinRecordFamily, TwinRecordRef,
    TwinRecordWrite, TwinStore } from './contracts';
import { TwinSeqPages } from './seq-pages';
import { TwinSeqStorage } from './seq-storage';

/** Storage foundation for trusted host services; does not implement consumer/source policy. */
export class SeqTwinStore implements TwinStore {
    private readonly pages: TwinSeqPages;
    private constructor(private readonly storage: TwinSeqStorage) { this.pages = new TwinSeqPages(storage.file('indexes')); }

    static async open(fs: IFileSystem, twinId: string, ownerId: string, progress: (stage: string) => void = () => {}): Promise<SeqTwinStore> {
        return new SeqTwinStore(await TwinSeqStorage.open(fs, twinId, ownerId, progress));
    }

    async inspect() { return this.storage.transaction(async (_tx, current) => current); }

    async read(ref: TwinRecordRef): Promise<TwinRecord | null> {
        ref = structuredClone(ref); recordRef(ref);
        return this.storage.transaction(async tx => {
            if (await tx.getEntry(this.storage.file('authority'), `forgotten/${recordKey(ref)}`)) return null;
            const revision = await tx.getEntry(this.storage.file('knowledge'), `head/${recordKey(ref)}`);
            if (!revision) return null;
            const record = decodeRecord(await tx.getEntry(this.storage.file('knowledge'), versionKey(ref, revision)), ref);
            if (!record || record.revision !== revision) throw new Error('Twin version missing or inconsistent');
            return record;
        });
    }

    async list(family: TwinRecordFamily, options: { offset?: number; limit?: number } = {}): Promise<TwinRecord[]> {
        recordRef({ family, id: 'validate' });
        const offset = options.offset ?? 0, limit = options.limit ?? 100;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
            throw new Error('Invalid Twin page');
        }
        return this.storage.transaction(async tx => {
            const ids = await this.pages.list(tx, family, offset, limit), result: TwinRecord[] = [];
            for (const id of ids) {
                const ref = { family, id };
                if (await tx.getEntry(this.storage.file('authority'), `forgotten/${recordKey(ref)}`)) continue;
                const revision = await tx.getEntry(this.storage.file('knowledge'), `head/${recordKey(ref)}`);
                if (!revision) throw new Error('Twin index has no head');
                const record = decodeRecord(await tx.getEntry(this.storage.file('knowledge'), versionKey(ref, revision)), ref);
                if (!record || record.revision !== revision) throw new Error('Twin index version inconsistent');
                result.push(record);
            }
            return result;
        });
    }

    async commit(command: TwinCommit): Promise<TwinCommitReceipt> {
        command = jsonSnapshot(command); validateCommit(command);
        const digest = sha256HexSync(JSON.stringify(command));
        const records = command.writes.map(write => ({ family: write.family, id: write.id,
            revision: randomUUID(), payload: write.payload }));
        return this.storage.transaction(async (tx, current) => {
            const saved = await this.receipt<TwinCommitReceipt>(tx, command.operationId, 'commit', digest);
            if (saved) return saved;
            assertEpoch(current.forgetEpoch, command.expectedForgetEpoch);
            for (const condition of command.conditions ?? []) await this.checkCondition(tx, condition);
            for (const write of command.writes) await this.checkWrite(tx, write);
            for (let index = 0; index < records.length; index++) await this.write(tx, records[index], command.writes[index].expectedRevision);
            const result = { operationId: command.operationId,
                versions: records.map(({ family, id, revision }) => ({ family, id, revision })) };
            await this.saveReceipt(tx, command.operationId, 'commit', digest, result);
            return result;
        });
    }

    async startForget(command: TwinForget): Promise<TwinCleanup> {
        command = jsonSnapshot(command); identity(command.operationId); epoch(command.expectedForgetEpoch); refs(command.records, MAX_FORGET_RECORDS);
        if (command.conditions?.length) refs(command.conditions, MAX_FORGET_RECORDS);
        const digest = sha256HexSync(JSON.stringify(command));
        return this.storage.transaction(async (tx, current) => {
            const saved = await this.receipt<TwinCleanup>(tx, command.operationId, 'forget', digest);
            if (saved) return this.cleanup(tx, command.operationId);
            assertEpoch(current.forgetEpoch, command.expectedForgetEpoch);
            for (const condition of command.conditions ?? []) await this.checkCondition(tx, condition);
            const forgetEpoch = current.forgetEpoch + 1; epoch(forgetEpoch);
            const result: TwinCleanup = { operationId: command.operationId, records: command.records,
                state: 'invalidated', forgetEpoch, cursors: {}, recordOffset: 0 };
            await tx.setEntry(this.storage.file('authority'), 'twin', JSON.stringify({ ...current, forgetEpoch }));
            const pending = await this.pendingIds(tx);
            if (pending.length >= 100) throw new Error('TWIN_CLEANUP_LIMIT');
            for (const ref of command.records) await this.invalidateRecord(tx, ref, result);
            await tx.setEntry(this.storage.file('authority'), 'cleanup-pending', JSON.stringify([...pending, command.operationId]));
            await tx.setEntry(this.storage.file('authority'), cleanupKey(command.operationId), JSON.stringify(result));
            await this.saveReceipt(tx, command.operationId, 'forget', digest, { operationId: command.operationId });
            return result;
        });
    }

    async pendingCleanup(): Promise<TwinCleanup[]> {
        return this.storage.transaction(async tx => {
            const operations: TwinCleanup[] = [];
            for (const id of (await this.pendingIds(tx)).slice(0, 20)) operations.push(await this.cleanup(tx, id));
            return operations;
        });
    }

    async cleanBatch(operationId: string, limit: number): Promise<TwinCleanup> {
        identity(operationId);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Twin cleanup limit');
        return this.storage.transaction(async tx => {
            const operation = await this.cleanup(tx, operationId);
            if (operation.state === 'completed') return operation;
            let removed = 0;
            while (removed < limit && operation.recordOffset < operation.records.length) {
                const ref = operation.records[operation.recordOffset], key = recordKey(ref), revision = operation.cursors[key];
                if (!revision) { operation.recordOffset++; continue; }
                operation.cursors[key] = await this.cleanVersion(tx, ref, revision); removed++;
            }
            const pending = Object.values(operation.cursors).some(Boolean);
            const result: TwinCleanup = { ...operation, state: pending ? 'cleaning' : 'completed' };
            await tx.setEntry(this.storage.file('authority'), cleanupKey(operationId), JSON.stringify(result));
            if (!pending) await tx.setEntry(this.storage.file('authority'), 'cleanup-pending', JSON.stringify(
                (await this.pendingIds(tx)).filter(id => id !== operationId)));
            return result;
        });
    }

    private async checkWrite(tx: ISeqFileTransaction, write: TwinRecordWrite): Promise<void> {
        const key = recordKey(write);
        if (await tx.getEntry(this.storage.file('authority'), `forgotten/${key}`)) throw new Error('Twin record forgotten');
        const current = await tx.getEntry(this.storage.file('knowledge'), `head/${key}`);
        if (current !== write.expectedRevision) throw new Error('Twin revision conflict');
    }

    private async checkCondition(tx: ISeqFileTransaction, condition: TwinRecordRef & { expectedRevision: string | null }): Promise<void> {
        const key = recordKey(condition);
        if (await tx.getEntry(this.storage.file('authority'), `forgotten/${key}`)) throw new Error('Twin record forgotten');
        if (await tx.getEntry(this.storage.file('knowledge'), `head/${key}`) !== condition.expectedRevision) {
            throw new Error('Twin condition revision conflict');
        }
    }

    private async write(tx: ISeqFileTransaction, record: TwinRecord, previousRevision: string | null): Promise<void> {
        await this.pages.add(tx, record);
        await tx.setEntry(this.storage.file('knowledge'), versionKey(record, record.revision), JSON.stringify({ ...record, previousRevision }));
        await tx.setEntry(this.storage.file('knowledge'), `head/${recordKey(record)}`, record.revision);
        await tx.setEntry(this.storage.file('indexes'), `family/${recordKey(record)}`, record.revision);
    }

    private async receipt<T>(tx: ISeqFileTransaction, operationId: string, action: string, digest: string): Promise<T | null> {
        const raw = await tx.getEntry(this.storage.file('processing'), receiptKey(operationId));
        if (!raw) return null;
        const saved = JSON.parse(raw) as { action: string; digest: string; result: T };
        if (saved.action !== action || saved.digest !== digest) throw new Error('Twin operation identity conflict');
        return saved.result;
    }

    private async saveReceipt(tx: ISeqFileTransaction, operationId: string, action: string,
        digest: string, result: unknown): Promise<void> {
        await tx.setEntry(this.storage.file('processing'), receiptKey(operationId), JSON.stringify({ action, digest, result }));
    }

    private async cleanup(tx: ISeqFileTransaction, operationId: string): Promise<TwinCleanup> {
        return decodeCleanup(await tx.getEntry(this.storage.file('authority'), cleanupKey(operationId)), operationId);
    }

    private async cleanVersion(tx: ISeqFileTransaction, ref: TwinRecordRef, revision: string): Promise<string | null> {
        const path = this.storage.file('knowledge'), key = versionKey(ref, revision), raw = await tx.getEntry(path, key);
        const record = decodeRecord(raw, ref);
        if (!record || record.revision !== revision) throw new Error('Twin cleanup version missing');
        const previous = (JSON.parse(raw!) as { previousRevision: string | null }).previousRevision;
        if (previous !== null) identity(previous);
        await tx.deleteEntry(path, key);
        return previous;
    }

    private async invalidateRecord(tx: ISeqFileTransaction, ref: TwinRecordRef, operation: TwinCleanup): Promise<void> {
        const key = recordKey(ref);
        operation.cursors[key] = await tx.getEntry(this.storage.file('knowledge'), `head/${key}`);
        await this.pages.remove(tx, ref);
        await tx.deleteEntry(this.storage.file('knowledge'), `head/${key}`);
        await tx.setEntry(this.storage.file('authority'), `forgotten/${key}`,
            JSON.stringify({ operationId: operation.operationId, forgetEpoch: operation.forgetEpoch }));
        await tx.deleteEntry(this.storage.file('indexes'), `family/${key}`);
    }

    private async pendingIds(tx: ISeqFileTransaction): Promise<string[]> {
        const raw = await tx.getEntry(this.storage.file('authority'), 'cleanup-pending');
        const ids: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new Error('Invalid Twin pending cleanup');
        return ids;
    }

}

function validateCommit(command: TwinCommit): void {
    identity(command.operationId); epoch(command.expectedForgetEpoch); refs(command.writes);
    if (command.conditions?.length) refs(command.conditions);
    for (const condition of command.conditions ?? []) if (condition.expectedRevision !== null) identity(condition.expectedRevision);
    for (const write of command.writes) {
        if (write.expectedRevision !== null) identity(write.expectedRevision);
        payload(write.payload);
    }
}

function assertEpoch(current: number, expected: number): void {
    if (current !== expected) throw new Error('Twin forget epoch conflict');
}

function jsonSnapshot<T>(value: T): T {
    // Reject unsupported JSON values instead of silently discarding fields in a receipt digest.
    const raw = JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol'
            || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('Invalid Twin JSON value');
        return item;
    });
    return JSON.parse(raw) as T;
}

const versionKey = (ref: TwinRecordRef, revision: string) => `version/${recordKey(ref)}/${encodeURIComponent(revision)}`;
const receiptKey = (id: string) => `receipt/${encodeURIComponent(id)}`;
const cleanupKey = (id: string) => `cleanup/${encodeURIComponent(id)}`;
