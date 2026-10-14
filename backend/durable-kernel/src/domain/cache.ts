import type { JsonValue, ResourceHandle } from './types';

export interface CacheApi {
    create(spec: CacheSpec): Promise<{ namespace: CacheNamespace; handle: ResourceHandle }>;
    list(): Promise<Array<{ namespace: CacheNamespace; handleId: string }>>;
    read(request: CacheRead): Promise<CacheReceipt>;
    publish(request: CachePublish): Promise<CacheEntry>;
    invalidate(handleId: string, expectedGeneration: number): Promise<CacheNamespace>;
    renew(handleId: string, expectedGeneration: number, ttlMs: number): Promise<CacheNamespace>;
}

export type CacheManagementAction =
    | { type: 'cache-create'; operationId: string; spec: CacheSpec }
    | { type: 'cache-invalidate'; operationId: string; handleId: string; expectedGeneration: number }
    | { type: 'cache-renew'; operationId: string; handleId: string; expectedGeneration: number; ttlMs: number };

export type CacheManagementReceipt =
    | { operationId: string; type: 'created'; namespace: CacheNamespace; handle: ResourceHandle }
    | { operationId: string; type: 'invalidated' | 'renewed'; namespace: CacheNamespace };

export interface CacheSpec {
    name: string;
    scope?: 'step' | 'task' | 'session';
    usage?: 'reusable' | 'single-use';
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
}
export interface CacheNamespace {
    id: string;
    ownerTaskId: string;
    stepNumber: number;
    name: string;
    scope: 'step' | 'task' | 'session';
    usage: 'reusable' | 'single-use';
    generation: number;
    ttlMs?: number;
    maxEntries: number;
    maxBytes: number;
    createdAt: number;
}
export interface CacheSource { handleId: string; key: string; fingerprint: string; expectedVersion?: number; }
export interface CacheRead {
    operationId: string;
    sources: CacheSource[];
    mode?: 'prefer-cache' | 'cache-only' | 'refresh' | 'bypass';
    maxAgeMs?: number;
}
export interface CacheReceipt {
    operationId: string;
    status: 'hit' | 'miss' | 'bypass';
    value?: JsonValue;
    namespaceId?: string;
    generation?: number;
    entryVersion?: number;
    observedAt: number;
}
export interface CachePublish {
    operationId: string;
    handleId: string;
    key: string;
    fingerprint: string;
    value: JsonValue;
    expectedGeneration: number;
    expectedVersion?: number | null;
}
export interface CacheEntry {
    key: string;
    fingerprint: string;
    generation: number;
    version: number;
    value: JsonValue;
    createdAt: number;
    expiresAt?: number;
    consumedBy?: string;
}
