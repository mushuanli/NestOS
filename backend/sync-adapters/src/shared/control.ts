import { assertSync, validId, type SyncState } from '@itookit/vfs-sync';
import { decodePlan, encodePlan, validateState } from './records';
export interface RecordFields {
    getRecordField(path: string, field: string): Promise<unknown>;
    setRecordField(path: string, field: string, value: string): Promise<void>;
}
export type ControlTransaction = <T>(mode: 'read' | 'write', action: (records: RecordFields) => Promise<T>) => Promise<T>;

/** Portable SeqFile control schema; host transactions provide atomicity and fencing. */
export class SeqControl {
    constructor(readonly path: string, private readonly transaction: ControlTransaction) {}
    async load(records: RecordFields): Promise<SyncState> {
        const raw = await records.getRecordField(this.path, 'state'); assertSync(typeof raw === 'string', 'SYNC_CONTROL_MISSING');
        const state = JSON.parse(raw) as SyncState; validateState(state); return state;
    }
    save(records: RecordFields, state: SyncState): Promise<void> {
        validateState(state); return records.setRecordField(this.path, 'state', JSON.stringify(state));
    }
    read(): Promise<SyncState> { return this.transaction('read', tx => this.load(tx)); }
    update(change: (state: SyncState) => SyncState): Promise<SyncState> {
        return this.transaction('write', async tx => { const state = change(await this.load(tx)); await this.save(tx, state); return state; });
    }
    persistPlan(key: string, value: unknown): Promise<void> {
        validId(key); return this.transaction('write', tx => tx.setRecordField(this.path, key, encodePlan(value)));
    }
    plan<T>(key: string): Promise<T | undefined> {
        validId(key); return this.transaction('read', async tx => {
            const raw = await tx.getRecordField(this.path, key); return raw === undefined ? undefined : decodePlan<T>(raw as string);
        });
    }
}
