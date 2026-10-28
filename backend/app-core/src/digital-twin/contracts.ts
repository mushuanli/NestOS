/** Host-only persistence contracts; source and consumer policies belong to the knowledge service. */
export type TwinRecordFamily = 'memory' | 'evidence' | 'support' | 'derivation' | 'review'
    | 'entity' | 'relation' | 'goal' | 'work-item' | 'binding' | 'source' | 'checkpoint'
    | 'grant' | 'suppression' | 'projection' | 'settings' | 'job' | 'usage'
    | 'scan-plan' | 'scan-run' | 'scan-checkpoint' | 'meter-entry' | 'meter-period';

export interface TwinIdentity {
    twinId: string;
    ownerId: string;
    incarnation: string;
    schemaVersion: 1;
    layoutVersion: 6;
    forgetEpoch: number;
}

export interface TwinRecordRef { family: TwinRecordFamily; id: string; }
export interface TwinRecord extends TwinRecordRef {
    revision: string;
    payload: Record<string, unknown>;
}
export interface TwinRecordWrite extends TwinRecordRef {
    expectedRevision: string | null;
    payload: Record<string, unknown>;
}
export interface TwinCommit {
    operationId: string;
    expectedForgetEpoch: number;
    writes: TwinRecordWrite[];
    conditions?: Array<TwinRecordRef & { expectedRevision: string | null }>;
}
export interface TwinCommitReceipt {
    operationId: string;
    versions: Array<TwinRecordRef & { revision: string }>;
}
export interface TwinForget {
    conditions?: Array<TwinRecordRef & { expectedRevision: string | null }>;
    operationId: string;
    expectedForgetEpoch: number;
    records: TwinRecordRef[];
}
export interface TwinCleanup {
    cursors: Record<string, string | null>;
    recordOffset: number;
    operationId: string;
    records: TwinRecordRef[];
    state: 'invalidated' | 'cleaning' | 'completed';
    forgetEpoch: number;
}

/** A bound owner handle, never a model tool or a consumer authorization endpoint. */
export interface TwinStore {
    inspect(): Promise<TwinIdentity>;
    read(ref: TwinRecordRef): Promise<TwinRecord | null>;
    list(family: TwinRecordFamily, options?: { offset?: number; limit?: number }): Promise<TwinRecord[]>;
    commit(command: TwinCommit): Promise<TwinCommitReceipt>;
    startForget(command: TwinForget): Promise<TwinCleanup>;
    pendingCleanup(): Promise<TwinCleanup[]>;
    cleanBatch(operationId: string, limit: number): Promise<TwinCleanup>;
}
