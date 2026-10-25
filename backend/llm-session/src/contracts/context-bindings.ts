import type {ContextBindingRef} from '@itookit/kernel-adapters/contracts';

/** UI and CLI receive references, never raw native control identities or operation fingerprints. */
export interface ContextBindingQuery {
    sessionId: string;
    branchId?: string;
    bindingId?: string;
    cursor?: ContextBindingCursor;
    limit?: number;
}
export interface ContextBindingSummary {
    ref: ContextBindingRef;
    branchId: string;
    targetRef: string;
    connectionId: string;
    validity: 'pending' | 'valid' | 'invalid';
    invalidReason?: string;
    busy: boolean;
    knownHeadRef?: string;
    checkpointCount: number;
}
export type ContextCheckpointSummary = {ref: string; previousRef?: string} & (
    | {kind: 'terminal'; invocationId: string}
    | {kind: 'legacy-head'}
);
export interface ContextBindingPage {
    revision: number | null;
    bindings: ContextBindingSummary[];
    /** Present only when querying one binding; pagination then addresses its checkpoints. */
    checkpoints?: ContextCheckpointSummary[];
    nextCursor?: ContextBindingCursor;
}
export interface ContextBindingCursor {revision: number; after: string; scope: string}
export type ContextBindingReader = (query: ContextBindingQuery) => Promise<ContextBindingPage>;

export function assertContextBindingQuery(query: ContextBindingQuery): void {
    if (!validQueryShape(query)) invalid();
    if (!/^[\w-]{1,128}$/.test(query.sessionId)) invalid();
    if ([query.branchId, query.bindingId].some(value => value !== undefined && !reference(value))) invalid();
    if (!validLimit(query.limit)) invalid();
    if (query.cursor !== undefined) assertCursor(query.cursor);
}
function validQueryShape(query: ContextBindingQuery): boolean {
    return !!query && typeof query === 'object' && reference(query.sessionId)
        && Object.keys(query).every(key => ['sessionId', 'branchId', 'bindingId', 'cursor', 'limit'].includes(key));
}
function validLimit(limit: number | undefined): boolean {return limit === undefined || Number.isSafeInteger(limit) && limit >= 1 && limit <= 100;}
function assertCursor(cursor: ContextBindingCursor): void {
    if (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1
        || !reference(cursor.after) || typeof cursor.scope !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.scope)
        || Object.keys(cursor).some(key => !['revision', 'after', 'scope'].includes(key))) invalid();
}
function reference(value: unknown): value is string {return typeof value === 'string' && !!value && value.length <= 4096;}
function invalid(): never {throw Object.assign(new Error('Invalid context binding query'), {code: 'CONTEXT_QUERY_INVALID'});}
