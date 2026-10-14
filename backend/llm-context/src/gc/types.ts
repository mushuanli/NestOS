import type { ContentRef } from '../domain/durable';

export interface ContextGcPolicy {
    /** Minimum age of an unreachable object. Defaults to one day. */
    retentionMs?: number;
    maxObjects?: number;
    maxRoots?: number;
    maxBytes?: number;
    maxDeletes?: number;
    /** Cooperative deadline checked between storage operations. */
    maxDurationMs?: number;
}
export interface ContextGcEntry { id: string; createdAt: number; bytes: number }
export interface ContextGcView {
    roots(): AsyncIterable<unknown>;
    entries(): AsyncIterable<ContextGcEntry>;
    /** Must validate the content hash and byte length, including legacy content. */
    read(ref: ContentRef): Promise<string>;
    remove(id: string): Promise<void>;
}
export interface IContextGcStore {
    /** Atomically remove entries, serialized with publication/root commits; null unless quiescent. */
    exclusive<T>(work: (view: ContextGcView) => Promise<T>): Promise<T | null>;
}
export interface ContextGcResult {
    status: 'collected' | 'dry-run' | 'busy' | 'budget' | 'failed';
    scanned: number;
    marked: number;
    candidates: number;
    deleted: number;
    reclaimedBytes: number;
    error?: string;
}
export interface ContextGcOptions { dryRun?: boolean; now?: number }
