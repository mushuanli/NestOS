import type { TwinCleanup, TwinIdentity, TwinRecord, TwinRecordFamily, TwinRecordRef } from './contracts';

const FAMILIES: ReadonlySet<string> = new Set<TwinRecordFamily>([
    'memory', 'evidence', 'support', 'derivation', 'review', 'entity', 'relation', 'goal',
    'work-item', 'binding', 'source', 'checkpoint', 'grant', 'suppression', 'projection', 'settings', 'job', 'usage',
    'scan-plan', 'scan-run', 'scan-checkpoint', 'meter-entry', 'meter-period',
]);
// One scope may include all 500 memories plus 10000 evidence and 10000 review rows.
export const MAX_FORGET_RECORDS = 25000;

export function identity(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid Twin identity');
}

export function recordRef(ref: TwinRecordRef): void {
    if (!ref || !FAMILIES.has(ref.family)) throw new Error('Invalid Twin record family');
    identity(ref.id);
}

export function refs(records: TwinRecordRef[], maximum = 100): void {
    if (!Array.isArray(records) || records.length < 1 || records.length > maximum) throw new Error('Invalid Twin batch');
    records.forEach(recordRef);
    if (new Set(records.map(recordKey)).size !== records.length) throw new Error('Duplicate Twin record');
}

export function epoch(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Twin epoch');
}

export function recordKey(ref: TwinRecordRef): string {
    return `${ref.family}/${encodeURIComponent(ref.id)}`;
}

export function decodeIdentity(raw: string | null): TwinIdentity {
    if (!raw) throw new Error('Twin is not initialized');
    const value = JSON.parse(raw) as TwinIdentity;
    if (value.schemaVersion !== 1) throw new Error('Unsupported Twin schema');
    if (value.layoutVersion !== 6) throw new Error('Unsupported Twin layout');
    identity(value.twinId); identity(value.ownerId); identity(value.incarnation); epoch(value.forgetEpoch);
    return value;
}

export function decodeRecord(raw: string | null, ref: TwinRecordRef): TwinRecord | null {
    if (!raw) return null;
    const value = JSON.parse(raw) as TwinRecord;
    recordRef(value); identity(value.revision); payload(value.payload);
    if (recordKey(value) !== recordKey(ref)) throw new Error('Twin record identity mismatch');
    return value;
}

export function payload(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Twin payload');
}

export function decodeCleanup(raw: string | null, operationId: string): TwinCleanup {
    if (!raw) throw new Error('Twin cleanup not found');
    const value = JSON.parse(raw) as TwinCleanup;
    if (value.operationId !== operationId || !['invalidated', 'cleaning', 'completed'].includes(value.state)) {
        throw new Error('Invalid Twin cleanup');
    }
    refs(value.records, MAX_FORGET_RECORDS); epoch(value.forgetEpoch); epoch(value.recordOffset);
    if (!value.cursors || Array.isArray(value.cursors) || typeof value.cursors !== 'object'
        || value.records.some(ref => value.cursors[recordKey(ref)] !== null && typeof value.cursors[recordKey(ref)] !== 'string')) throw new Error('Invalid Twin cursors');
    return value;
}
